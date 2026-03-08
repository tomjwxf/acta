/**
 * Tier 2 Moderation — LLM-assisted content classification.
 *
 * Rules (from Protocol Spec):
 *   ✓ LLMs may classify, tag, and flag
 *   ✗ LLMs may NOT make irreversible epistemic decisions alone
 *   ✗ LLMs may NOT declare claims true/false
 *   ✗ LLMs may NOT override state transitions
 *
 * Hard-reject flags escalate to Tier 3 (human review).
 * Everything else enters the ledger with tags.
 */

// ── Hard-Reject Categories ──────────────────────────────────────────

const HARD_REJECT_CATEGORIES = [
    'csam',
    'malware',
    'doxxing',
    'impersonation',
    'credible_violent_threat',
];

// ── Classification Tags ─────────────────────────────────────────────

const CONTENT_TAGS = [
    'likely_opinion',        // Content that reads as opinion but isn't labelled as such
    'unsubstantiated',       // Factual-sounding claim without evidence
    'potentially_misleading', // Contains common misinformation patterns
    'review_pending',        // LLM uncertain — escalate to Tier 3
];

// ── Main Classification Function ────────────────────────────────────

/**
 * Classify content using Workers AI.
 *
 * Returns:
 *   { action: 'accept', tags: [...] }                    — enters ledger with tags
 *   { action: 'hard_reject_flag', category: '...' }      — escalated to Tier 3
 *   { action: 'accept', tags: [] }                       — clean, no tags
 *
 * This function NEVER makes a final hard-reject decision.
 * It only FLAGS for Tier 3 human review.
 */
export async function classifyContent(env, entry) {
    // Skip classification if Workers AI is not bound
    if (!env.AI) {
        return { action: 'accept', tags: [], skipped: true, reason: 'ai_not_configured' };
    }

    const content = entry.payload?.body || '';
    if (!content || content.length < 5) {
        return { action: 'accept', tags: [] };
    }

    try {
        const result = await runClassification(env, content, entry);
        return result;
    } catch (err) {
        // LLM failure → accept without tags (fail open for epistemic content)
        console.error('[TIER2] Classification failed:', err.message);
        return {
            action: 'accept',
            tags: ['classification_failed'],
            error: err.message,
        };
    }
}

/**
 * Run the actual LLM classification.
 */
async function runClassification(env, content, entry) {
    const systemPrompt = `You are a content classifier for a public record system called Acta.

Your job is to classify content into categories. You DO NOT judge whether content is true or false.
You DO NOT make editorial decisions. You only classify structure and safety.

For each piece of content, respond with a JSON object:
{
  "safety": "safe" | "flag_for_review",
  "safety_category": null | "csam" | "malware" | "doxxing" | "impersonation" | "credible_violent_threat",
  "safety_reasoning": "brief explanation if flagged",
  "content_tags": [],
  "tag_reasoning": "brief explanation for each tag"
}

Content tag rules:
- Add "likely_opinion" if the content expresses a subjective view but the contribution type is "claim" with category "factual"
- Add "unsubstantiated" only if the contribution type is "claim", category is "factual", and no source or reasoning is provided
  (Note: the schema validator already catches this — you are a backup check)
- Add "potentially_misleading" only if the content contains well-known false claims (flat earth, election denial with no evidence, etc.)
  Do NOT tag things as misleading just because you disagree
- Add "review_pending" if you are uncertain about any of the above classifications

CRITICAL RULES:
- "credible_violent_threat" means SPECIFIC, OPERATIONAL threats: "I will [act] at [target] at [time]"
  Discussion of violence, historical accounts, policy debate about conflict = NOT a threat
- Never classify based on political viewpoint
- When uncertain, classify as safe with "review_pending" tag
- You must respond with valid JSON only, no other text`;

    const userPrompt = `Classify this ${entry.type} (subtype: ${entry.subtype}${entry.payload?.category ? `, category: ${entry.payload.category}` : ''}):

"""
${content.slice(0, 2000)}
"""`;

    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        max_tokens: 300,
        temperature: 0.1, // Low temperature for consistent classification
    });

    // Parse the LLM response
    const parsed = parseClassificationResponse(response.response || '');

    if (!parsed) {
        return { action: 'accept', tags: ['classification_parse_failed'] };
    }

    // If safety flag → escalate to Tier 3 (NEVER auto-reject)
    if (parsed.safety === 'flag_for_review' && HARD_REJECT_CATEGORIES.includes(parsed.safety_category)) {
        return {
            action: 'hard_reject_flag',
            category: parsed.safety_category,
            reasoning: parsed.safety_reasoning,
            // This does NOT reject the content. It queues it for Tier 3 human review.
            // The content is held (not written to ledger) pending human decision.
        };
    }

    // Otherwise, accept with any content tags
    const tags = (parsed.content_tags || []).filter(t => CONTENT_TAGS.includes(t));

    return {
        action: 'accept',
        tags,
        tag_reasoning: parsed.tag_reasoning || null,
    };
}

/**
 * Parse LLM JSON response, handling common formatting issues.
 */
function parseClassificationResponse(text) {
    if (!text) return null;

    // Try direct parse
    try {
        return JSON.parse(text);
    } catch {
        // Try extracting JSON from markdown code blocks
        const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[1]);
            } catch {
                // Fall through
            }
        }

        // Try finding JSON object in text
        const objMatch = text.match(/\{[\s\S]*\}/);
        if (objMatch) {
            try {
                return JSON.parse(objMatch[0]);
            } catch {
                // Fall through
            }
        }
    }

    return null;
}

/**
 * Tier 3 Queue — store items flagged for human review in KV.
 */
export async function queueForHumanReview(env, entry, classification) {
    const kv = env.ACTA_KV;
    if (!kv) return;

    const reviewItem = {
        entry,
        classification,
        queued_at: new Date().toISOString(),
        status: 'pending',
        reviewer: null,
        decision: null,
    };

    const queueKey = `review:${crypto.randomUUID()}`;
    await kv.put(queueKey, JSON.stringify(reviewItem), { expirationTtl: 86400 * 30 }); // 30 day TTL

    // Update pending count
    const pendingCount = parseInt(await kv.get('review:pending_count') || '0');
    await kv.put('review:pending_count', String(pendingCount + 1));
}

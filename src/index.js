/**
 * Acta — Worker Entry Point
 *
 * Routes API requests to the appropriate handlers.
 * Full pipeline: Identity → Schema → Duplicate → Budget → Moderation → Ledger → KV
 */

import { validateContribution, validateResponse, computeState, TOKEN_COSTS } from './validators/schema.js';
import { replicateToKV, getEntryFromKV, getTopicForEntry, listTopics, getFeedFromKV } from './kv-index.js';
import { classifyContent, queueForHumanReview } from './moderation.js';
import { resolveIdentity } from './identity.js';
import { checkDuplicate, recordSubmission } from './duplicate-detection.js';
import { renderHTML } from './ui.js';

// Re-export Durable Objects for wrangler
export { LedgerChain } from './durable-objects/ledger-chain.js';
export { DeviceBudget } from './durable-objects/device-budget.js';

// ── CORS ────────────────────────────────────────────────────────────

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, DPoP, X-Device-Id',
    'Access-Control-Max-Age': '86400',
};

function corsJson(body, init = {}) {
    const headers = { 'Content-Type': 'application/json', ...CORS_HEADERS, ...init.headers };
    return new Response(JSON.stringify(body), { ...init, headers });
}

function corsHtml(body, init = {}) {
    const headers = { 'Content-Type': 'text/html; charset=utf-8', ...init.headers };
    return new Response(body, { ...init, headers });
}

// ── Main Handler ────────────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        try {
            // ── Web UI ──
            if (request.method === 'GET' && url.pathname === '/') {
                return corsHtml(renderHTML('home', { topics: await listTopics(env) }));
            }

            if (request.method === 'GET' && url.pathname.startsWith('/topic/')) {
                const topic = decodeURIComponent(url.pathname.slice(7));
                return corsHtml(await renderTopicPage(env, topic));
            }

            if (request.method === 'GET' && url.pathname === '/about') {
                return corsHtml(renderHTML('about'));
            }

            if (request.method === 'GET' && url.pathname === '/moderation-log') {
                return corsHtml(await renderModerationLog(env));
            }

            // ── API: Read ──

            if (request.method === 'GET') {
                if (url.pathname === '/api/charter') {
                    return corsJson({
                        mission: 'Shared reality for coordination.',
                        charter_url: 'https://github.com/tomjwxf/acta/blob/main/CHARTER.md',
                        invariants: [
                            'Contributions are typed, each type carries an explicit burden',
                            'Every object has provenance and revision history',
                            'Claims and decisions can be challenged',
                            'No entity can dominate attention through scale',
                            'Agents are disclosed delegates, not default peers',
                            'The record maintains fidelity, provenance, checkability, and integrity',
                            'Resolution and supersession are explicit',
                        ],
                    });
                }

                if (url.pathname === '/api/topics') {
                    return corsJson(await listTopics(env));
                }

                if (url.pathname === '/api/feed') {
                    const topic = url.searchParams.get('topic');
                    if (!topic) return corsJson({ error: 'topic_required' }, { status: 400 });
                    return corsJson(await getTopicFeedWithState(env, topic.trim().toLowerCase()));
                }

                // Single entry lookup (now implemented via KV)
                const entryMatch = url.pathname.match(/^\/api\/entry\/([a-f0-9-]{36})$/);
                if (entryMatch) {
                    return handleGetEntry(env, entryMatch[1]);
                }

                if (url.pathname === '/api/verify') {
                    const topic = url.searchParams.get('topic');
                    if (!topic) return corsJson({ error: 'topic_required' }, { status: 400 });
                    const chainDO = getChainDO(env, topic.trim().toLowerCase());
                    const resp = await chainDO.fetch(new Request('http://internal/verify'));
                    return corsJson(await resp.json());
                }

                // Moderation log API
                if (url.pathname === '/api/moderation-log') {
                    return corsJson(await getModerationEntries(env));
                }
            }

            // ── API: Write ──

            if (request.method === 'POST') {
                if (url.pathname === '/api/contribute') {
                    return handleContribute(request, env, ctx);
                }
                if (url.pathname === '/api/respond') {
                    return handleRespond(request, env, ctx);
                }
            }

            // 404
            if (url.pathname.startsWith('/api/')) {
                return corsJson({ error: 'not_found' }, { status: 404 });
            }
            return corsHtml(renderHTML('404'), { status: 404 });

        } catch (err) {
            console.error('[ACTA]', err);
            return corsJson({
                error: 'internal_error',
                message: env.ENVIRONMENT === 'development' ? err.message : 'An error occurred',
            }, { status: 500 });
        }
    },
};

// ── Write Handlers ──────────────────────────────────────────────────

async function handleContribute(request, env, ctx) {
    const body = await request.json();
    const { type, topic, payload } = body;

    // Tier 0: Identity
    const identity = await resolveIdentity(request, env);
    if (!identity && env.ENVIRONMENT !== 'development') {
        return corsJson({ error: 'identity_required' }, { status: 401 });
    }

    const authorType = identity?.type || 'human';
    const deviceId = identity?.device_id || 'dev-anonymous';

    // Tier 1: Schema validation
    const validation = validateContribution(type, payload || {});
    if (!validation.valid) {
        return corsJson({ error: 'schema_validation_failed', action: 'return_for_revision', errors: validation.errors }, { status: 422 });
    }

    if (!topic || typeof topic !== 'string' || topic.trim().length < 1) {
        return corsJson({ error: 'schema_validation_failed', errors: [{ field: 'topic', error: 'Required' }] }, { status: 422 });
    }

    // Build entry early for duplicate check
    const entry = {
        type: 'contribution',
        subtype: type,
        topic: topic.trim().toLowerCase(),
        author: {
            type: authorType,
            device_attestation_hash: await hashString(deviceId),
            method: identity?.method || 'none',
            trust_level: identity?.trust_level || 'none',
            agent_operator: body.agent_operator || null,
        },
        payload,
        state: 'open',
        linked_to: [],
    };

    // Tier 1: Duplicate detection
    const dupCheck = await checkDuplicate(env, entry);
    if (dupCheck.duplicate) {
        return corsJson({
            error: 'duplicate_detected',
            similarity: dupCheck.similarity,
            similar_entry_id: dupCheck.similar_entry_id,
            message: `This contribution is ${dupCheck.similarity}% similar to a recent submission from the same device.`,
        }, { status: 409 });
    }

    // Tier 2: Content classification (before budget — don't charge for held content)
    const classification = await classifyContent(env, entry);
    if (classification.action === 'hard_reject_flag') {
        if (ctx?.waitUntil) ctx.waitUntil(queueForHumanReview(env, entry, classification));
        return corsJson({ status: 'held_for_review', reason: 'Content flagged for human review.' }, { status: 202 });
    }
    if (classification.tags?.length > 0) entry.moderation_tags = classification.tags;

    // Tier 1: Budget check (after moderation — only charge for accepted content)
    const cost = TOKEN_COSTS[type] || 2;
    const budgetResult = await checkBudget(env, deviceId, authorType, cost);
    if (!budgetResult.allowed) {
        return corsJson({
            error: 'budget_exceeded',
            tokens_remaining: budgetResult.tokens_remaining,
            resets_at: budgetResult.resets_at,
        }, { status: 429 });
    }

    // Append to ledger chain
    const chainResult = await appendToChain(env, entry.topic, entry);

    // Async: KV replication + duplicate recording
    const asyncWork = async () => {
        await replicateToKV(env, null, entry, chainResult);
        await recordSubmission(env, null, entry, chainResult.entry_id);
    };
    if (ctx?.waitUntil) { ctx.waitUntil(asyncWork()); } else { await asyncWork(); }

    return corsJson({
        status: 'accepted',
        entry_id: chainResult.entry_id,
        entry_hash: chainResult.entry_hash,
        sequence: chainResult.sequence,
        state: entry.state,
        moderation_tags: entry.moderation_tags || [],
        tokens_remaining: budgetResult.tokens_remaining,
    }, { status: 201 });
}

async function handleRespond(request, env, ctx) {
    const body = await request.json();
    const { type, topic, payload } = body;

    // Tier 0: Identity
    const identity = await resolveIdentity(request, env);
    if (!identity && env.ENVIRONMENT !== 'development') {
        return corsJson({ error: 'identity_required' }, { status: 401 });
    }

    const authorType = identity?.type || 'human';
    const deviceId = identity?.device_id || 'dev-anonymous';

    // Tier 1: Schema
    const validation = validateResponse(type, payload || {});
    if (!validation.valid) {
        return corsJson({ error: 'schema_validation_failed', action: 'return_for_revision', errors: validation.errors }, { status: 422 });
    }

    if (!topic || typeof topic !== 'string') {
        return corsJson({ error: 'schema_validation_failed', errors: [{ field: 'topic', error: 'Required' }] }, { status: 422 });
    }

    const entry = {
        type: 'response',
        subtype: type,
        topic: topic.trim().toLowerCase(),
        author: {
            type: authorType,
            device_attestation_hash: await hashString(deviceId),
            method: identity?.method || 'none',
            trust_level: identity?.trust_level || 'none',
            agent_operator: body.agent_operator || null,
        },
        payload,
        state: null,
        linked_to: [payload.target_id],
    };

    // Tier 2: classify (before budget — don't charge for held content)
    const classification = await classifyContent(env, entry);
    if (classification.action === 'hard_reject_flag') {
        if (ctx?.waitUntil) ctx.waitUntil(queueForHumanReview(env, entry, classification));
        return corsJson({ status: 'held_for_review' }, { status: 202 });
    }
    if (classification.tags?.length > 0) entry.moderation_tags = classification.tags;

    // Tier 1: Budget (after moderation — only charge for accepted content)
    const cost = TOKEN_COSTS[type] || 1;
    const budgetResult = await checkBudget(env, deviceId, authorType, cost);
    if (!budgetResult.allowed) {
        return corsJson({ error: 'budget_exceeded', tokens_remaining: budgetResult.tokens_remaining, resets_at: budgetResult.resets_at }, { status: 429 });
    }

    const chainResult = await appendToChain(env, entry.topic, entry);

    const asyncWork = async () => {
        await replicateToKV(env, null, entry, chainResult);
        await recordSubmission(env, null, entry, chainResult.entry_id);
    };
    if (ctx?.waitUntil) { ctx.waitUntil(asyncWork()); } else { await asyncWork(); }

    return corsJson({
        status: 'accepted',
        entry_id: chainResult.entry_id,
        entry_hash: chainResult.entry_hash,
        sequence: chainResult.sequence,
        moderation_tags: entry.moderation_tags || [],
        tokens_remaining: budgetResult.tokens_remaining,
    }, { status: 201 });
}

// ── Read Handlers ───────────────────────────────────────────────────

/**
 * Get a single entry by ID via KV, with its responses.
 */
async function handleGetEntry(env, entryId) {
    const meta = await getEntryFromKV(env, entryId);
    if (!meta) return corsJson({ error: 'not_found' }, { status: 404 });

    // If we know the topic, fetch linked responses from the DO
    if (meta.topic) {
        const chainDO = getChainDO(env, meta.topic);
        const resp = await chainDO.fetch(new Request('http://internal/entries?offset=0&limit=50&order=asc'));
        const data = await resp.json();
        const allEntries = data.entries || [];

        // Find responses linked to this entry
        const responses = allEntries.filter(e =>
            e.type === 'response' && (e.linked_to || []).includes(entryId)
        );

        // Compute state
        const computed = computeState(meta, responses);

        return corsJson({
            ...meta,
            computed_state: computed.state,
            display_hint: computed.display_hint,
            responses,
        });
    }

    return corsJson(meta);
}

/**
 * Get topic feed with computed states for all contributions.
 */
async function getTopicFeedWithState(env, topic) {
    // Fetch ALL entries from the DO (for state computation)
    const chainDO = getChainDO(env, topic);
    const resp = await chainDO.fetch(new Request('http://internal/entries?offset=0&limit=200&order=asc'));
    const data = await resp.json();
    const allEntries = data.entries || [];

    // Compute state for each contribution
    const contributions = allEntries.filter(e => e.type === 'contribution');
    const responses = allEntries.filter(e => e.type === 'response');

    for (const c of contributions) {
        const linked = responses.filter(r => (r.linked_to || []).includes(c.entry_id));
        const computed = computeState(c, linked);
        c.computed_state = computed.state;
        c.display_hint = computed.display_hint;
        c.response_count = linked.length;
    }

    return {
        entries: allEntries,
        contributions,
        total: allEntries.length,
    };
}

/**
 * Render the topic page HTML with state-computed entries.
 */
async function renderTopicPage(env, topic) {
    const feedData = await getTopicFeedWithState(env, topic.trim().toLowerCase());
    return renderHTML('topic', {
        topic,
        entries: feedData.entries,
    });
}

/**
 * Get moderation log entries from KV.
 */
async function getModerationEntries(env) {
    const kv = env.ACTA_KV;
    if (!kv) return { entries: [] };

    // List review items from KV (prefix scan)
    const list = await kv.list({ prefix: 'review:' });
    const entries = [];

    for (const key of list.keys) {
        if (key.name === 'review:pending_count') continue;
        const item = await kv.get(key.name, { type: 'json' });
        if (item) {
            entries.push({
                id: key.name,
                action: item.classification?.action || 'unknown',
                category: item.classification?.category || null,
                reasoning: item.classification?.reasoning || null,
                status: item.status,
                queued_at: item.queued_at,
                timestamp: item.queued_at,
            });
        }
    }

    return { entries: entries.sort((a, b) => new Date(b.queued_at) - new Date(a.queued_at)) };
}

async function renderModerationLog(env) {
    const data = await getModerationEntries(env);
    return renderHTML('moderation', data);
}

// ── Helpers ─────────────────────────────────────────────────────────

function getChainDO(env, topic) {
    const id = env.LEDGER_CHAIN.idFromName(topic);
    return env.LEDGER_CHAIN.get(id);
}

async function checkBudget(env, deviceId, authorType, cost) {
    const id = env.DEVICE_BUDGET.idFromName(deviceId);
    const stub = env.DEVICE_BUDGET.get(id);
    const resp = await stub.fetch(new Request('http://internal/spend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cost, author_type: authorType }),
    }));
    return resp.json();
}

async function appendToChain(env, topic, entry) {
    const chainDO = getChainDO(env, topic);
    const resp = await chainDO.fetch(new Request('http://internal/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
    }));
    return resp.json();
}

async function hashString(str) {
    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

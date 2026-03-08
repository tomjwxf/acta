/**
 * Acta — Worker Entry Point
 *
 * Routes API requests to the appropriate handlers.
 * Implements Tier 1 enforcement (schema validation, budget checks).
 */

import { validateContribution, validateResponse, computeState, TOKEN_COSTS } from './validators/schema.js';

// Re-export Durable Objects for wrangler
export { LedgerChain } from './durable-objects/ledger-chain.js';
export { DeviceBudget } from './durable-objects/device-budget.js';

// ── CORS ────────────────────────────────────────────────────────────

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, DPoP',
    'Access-Control-Max-Age': '86400',
};

function corsResponse(body, init = {}) {
    const headers = { 'Content-Type': 'application/json', ...CORS_HEADERS, ...init.headers };
    return new Response(JSON.stringify(body), { ...init, headers });
}

// ── Main Handler ────────────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        try {
            // ── Read endpoints ──

            if (request.method === 'GET') {
                // GET /charter — returns the charter text
                if (url.pathname === '/charter') {
                    return corsResponse({
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

                // GET /feed?topic=...&offset=0&limit=20
                if (url.pathname === '/feed') {
                    return handleFeed(url, env);
                }

                // GET /entry/:id
                const entryMatch = url.pathname.match(/^\/entry\/([a-f0-9-]{36})$/);
                if (entryMatch) {
                    return handleGetEntry(entryMatch[1], env);
                }

                // GET /verify?topic=...
                if (url.pathname === '/verify') {
                    return handleVerifyChain(url, env);
                }
            }

            // ── Write endpoints ──

            if (request.method === 'POST') {
                // POST /contribute — submit a typed contribution
                if (url.pathname === '/contribute') {
                    return handleContribute(request, env);
                }

                // POST /respond — submit a typed response
                if (url.pathname === '/respond') {
                    return handleRespond(request, env);
                }
            }

            return corsResponse({ error: 'not_found' }, { status: 404 });

        } catch (err) {
            console.error('[ACTA]', err);
            return corsResponse({
                error: 'internal_error',
                message: env.ENVIRONMENT === 'development' ? err.message : 'An error occurred',
            }, { status: 500 });
        }
    },
};

// ── Handlers ────────────────────────────────────────────────────────

/**
 * POST /contribute
 * Submit a new typed contribution (question, claim, prediction).
 */
async function handleContribute(request, env) {
    const body = await request.json();
    const { type, topic, payload, device_attestation } = body;

    // Tier 1: Schema validation
    const validation = validateContribution(type, payload || {});
    if (!validation.valid) {
        return corsResponse({
            error: 'schema_validation_failed',
            action: 'return_for_revision',
            errors: validation.errors,
        }, { status: 422 });
    }

    // Topic is required
    if (!topic || typeof topic !== 'string' || topic.trim().length < 1) {
        return corsResponse({
            error: 'schema_validation_failed',
            errors: [{ field: 'topic', error: 'Required' }],
        }, { status: 422 });
    }

    // Tier 1: Budget check
    const deviceId = device_attestation || request.headers.get('x-device-id') || 'anonymous';
    const authorType = body.author_type || 'human';
    const budgetResult = await checkBudget(env, deviceId, authorType, TOKEN_COSTS[type] || 2);
    if (!budgetResult.allowed) {
        return corsResponse({
            error: 'budget_exceeded',
            tokens_remaining: budgetResult.tokens_remaining,
            tokens_requested: budgetResult.tokens_requested,
            resets_at: budgetResult.resets_at,
        }, { status: 429 });
    }

    // Determine initial state
    let initialState = 'open';
    if (type === 'claim' && payload.category === 'factual' && !payload.source && payload.reasoning) {
        // Has reasoning but no hard source — still open
        initialState = 'open';
    } else if (type === 'claim' && payload.category === 'factual' && !payload.source && !payload.reasoning) {
        // This shouldn't happen (schema validator catches it), but defensive
        initialState = 'unsubstantiated';
    }

    // Build the ledger entry
    const entry = {
        type: 'contribution',
        subtype: type,
        topic: topic.trim().toLowerCase(),
        author: {
            type: authorType,
            device_attestation_hash: await hashString(deviceId),
            agent_operator: body.agent_operator || null,
        },
        payload,
        state: initialState,
        linked_to: [],
    };

    // Append to ledger chain
    const chainResult = await appendToChain(env, entry.topic, entry);

    // Async: replicate to KV for feed queries
    // (In production, this would also replicate to R2 for archival)

    return corsResponse({
        status: 'accepted',
        entry_id: chainResult.entry_id,
        entry_hash: chainResult.entry_hash,
        sequence: chainResult.sequence,
        state: initialState,
        tokens_remaining: budgetResult.tokens_remaining,
    }, { status: 201 });
}

/**
 * POST /respond
 * Submit a typed response (evidence, challenge, update, resolution).
 */
async function handleRespond(request, env) {
    const body = await request.json();
    const { type, topic, payload, device_attestation } = body;

    // Tier 1: Schema validation
    const validation = validateResponse(type, payload || {});
    if (!validation.valid) {
        return corsResponse({
            error: 'schema_validation_failed',
            action: 'return_for_revision',
            errors: validation.errors,
        }, { status: 422 });
    }

    if (!topic || typeof topic !== 'string') {
        return corsResponse({
            error: 'schema_validation_failed',
            errors: [{ field: 'topic', error: 'Required' }],
        }, { status: 422 });
    }

    // Tier 1: Budget check
    const deviceId = device_attestation || request.headers.get('x-device-id') || 'anonymous';
    const authorType = body.author_type || 'human';
    const budgetResult = await checkBudget(env, deviceId, authorType, TOKEN_COSTS[type] || 1);
    if (!budgetResult.allowed) {
        return corsResponse({
            error: 'budget_exceeded',
            tokens_remaining: budgetResult.tokens_remaining,
            tokens_requested: budgetResult.tokens_requested,
            resets_at: budgetResult.resets_at,
        }, { status: 429 });
    }

    // Build the ledger entry
    const entry = {
        type: 'response',
        subtype: type,
        topic: topic.trim().toLowerCase(),
        author: {
            type: authorType,
            device_attestation_hash: await hashString(deviceId),
            agent_operator: body.agent_operator || null,
        },
        payload,
        state: null, // Responses don't have independent state
        linked_to: [payload.target_id],
    };

    // Append to ledger chain
    const chainResult = await appendToChain(env, entry.topic, entry);

    return corsResponse({
        status: 'accepted',
        entry_id: chainResult.entry_id,
        entry_hash: chainResult.entry_hash,
        sequence: chainResult.sequence,
        tokens_remaining: budgetResult.tokens_remaining,
    }, { status: 201 });
}

/**
 * GET /feed?topic=...&offset=0&limit=20
 * Read contributions and responses for a topic.
 */
async function handleFeed(url, env) {
    const topic = url.searchParams.get('topic');
    if (!topic) {
        return corsResponse({ error: 'topic_required' }, { status: 400 });
    }

    const offset = parseInt(url.searchParams.get('offset') || '0');
    const limit = parseInt(url.searchParams.get('limit') || '20');

    const chainDO = getChainDO(env, topic.trim().toLowerCase());
    const resp = await chainDO.fetch(new Request('http://internal/entries?' +
        `offset=${offset}&limit=${limit}&order=${url.searchParams.get('order') || 'desc'}`
    ));

    const data = await resp.json();

    // Compute states for contributions
    const contributions = data.entries.filter(e => e.type === 'contribution');
    const responses = data.entries.filter(e => e.type === 'response');

    for (const c of contributions) {
        const related = responses.filter(r => r.linked_to?.includes(c.entry_id));
        const computed = computeState(c, related);
        c.computed_state = computed.state;
        c.display_hint = computed.display_hint;
    }

    return corsResponse(data);
}

/**
 * GET /entry/:id
 * Get a single entry with its responses and computed state.
 */
async function handleGetEntry(entryId, env) {
    // For v1, we'd need to know the topic to find the entry.
    // This requires a KV index: entry_id → topic mapping.
    // For now, return a note about this limitation.
    return corsResponse({
        error: 'not_implemented',
        message: 'Single-entry lookup requires KV index (entry_id → topic). Coming in next iteration.',
    }, { status: 501 });
}

/**
 * GET /verify?topic=...
 * Verify the hash chain for a topic is intact.
 */
async function handleVerifyChain(url, env) {
    const topic = url.searchParams.get('topic');
    if (!topic) {
        return corsResponse({ error: 'topic_required' }, { status: 400 });
    }

    const chainDO = getChainDO(env, topic.trim().toLowerCase());
    const resp = await chainDO.fetch(new Request('http://internal/verify'));
    const data = await resp.json();

    return corsResponse(data);
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Get or create the LedgerChain DO for a topic.
 */
function getChainDO(env, topic) {
    const id = env.LEDGER_CHAIN.idFromName(topic);
    return env.LEDGER_CHAIN.get(id);
}

/**
 * Check and spend device budget.
 */
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

/**
 * Append an entry to the topic's ledger chain.
 */
async function appendToChain(env, topic, entry) {
    const chainDO = getChainDO(env, topic);

    const resp = await chainDO.fetch(new Request('http://internal/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
    }));

    return resp.json();
}

/**
 * SHA-256 hash a string, return hex.
 */
async function hashString(str) {
    const buffer = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(str)
    );
    return [...new Uint8Array(buffer)]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

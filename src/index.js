/**
 * Acta — Worker Entry Point
 *
 * Routes API requests to the appropriate handlers.
 * Implements Tier 1 (schema validation, budget) and Tier 2 (LLM moderation).
 */

import { validateContribution, validateResponse, computeState, TOKEN_COSTS } from './validators/schema.js';
import { replicateToKV, getEntryFromKV, getTopicForEntry, listTopics, getFeedFromKV } from './kv-index.js';
import { classifyContent, queueForHumanReview } from './moderation.js';
import { resolveIdentity } from './identity.js';
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

        // CORS preflight
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
                const feed = await getFeedFromKV(env, topic) || { entries: [], total: 0 };
                return corsHtml(renderHTML('topic', { topic, feed }));
            }

            if (request.method === 'GET' && url.pathname === '/about') {
                return corsHtml(renderHTML('about'));
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

                    const offset = parseInt(url.searchParams.get('offset') || '0');
                    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);

                    // Try KV first (fast), fall back to DO
                    const kvFeed = await getFeedFromKV(env, topic.trim().toLowerCase(), { offset, limit });
                    if (kvFeed) return corsJson(kvFeed);

                    // Fallback to DO
                    const chainDO = getChainDO(env, topic.trim().toLowerCase());
                    const resp = await chainDO.fetch(new Request(
                        `http://internal/entries?offset=${offset}&limit=${limit}&order=desc`
                    ));
                    return corsJson(await resp.json());
                }

                const entryMatch = url.pathname.match(/^\/api\/entry\/([a-f0-9-]{36})$/);
                if (entryMatch) {
                    const meta = await getEntryFromKV(env, entryMatch[1]);
                    if (meta) return corsJson(meta);
                    return corsJson({ error: 'not_found' }, { status: 404 });
                }

                if (url.pathname === '/api/verify') {
                    const topic = url.searchParams.get('topic');
                    if (!topic) return corsJson({ error: 'topic_required' }, { status: 400 });
                    const chainDO = getChainDO(env, topic.trim().toLowerCase());
                    const resp = await chainDO.fetch(new Request('http://internal/verify'));
                    return corsJson(await resp.json());
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
                return corsJson({ error: 'not_found', endpoints: ['/api/charter', '/api/topics', '/api/feed', '/api/contribute', '/api/respond', '/api/verify'] }, { status: 404 });
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

    // Tier 0: Identity resolution
    const identity = await resolveIdentity(request, env);
    if (!identity && env.ENVIRONMENT !== 'development') {
        return corsJson({ error: 'identity_required', message: 'Device attestation or agent DPoP proof required.' }, { status: 401 });
    }

    const authorType = identity?.type || 'human';
    const deviceId = identity?.device_id || 'dev-anonymous';

    // Tier 1: Schema validation
    const validation = validateContribution(type, payload || {});
    if (!validation.valid) {
        return corsJson({
            error: 'schema_validation_failed',
            action: 'return_for_revision',
            errors: validation.errors,
        }, { status: 422 });
    }

    if (!topic || typeof topic !== 'string' || topic.trim().length < 1) {
        return corsJson({
            error: 'schema_validation_failed',
            errors: [{ field: 'topic', error: 'Required' }],
        }, { status: 422 });
    }

    // Tier 1: Budget check
    const cost = TOKEN_COSTS[type] || 2;
    const budgetResult = await checkBudget(env, deviceId, authorType, cost);
    if (!budgetResult.allowed) {
        return corsJson({
            error: 'budget_exceeded',
            tokens_remaining: budgetResult.tokens_remaining,
            tokens_requested: budgetResult.tokens_requested,
            resets_at: budgetResult.resets_at,
        }, { status: 429 });
    }

    // Build the ledger entry
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

    // Tier 2: Content classification (async — doesn't block write for accepted content)
    const classification = await classifyContent(env, entry);

    if (classification.action === 'hard_reject_flag') {
        // Hold the entry — don't write to ledger. Queue for Tier 3.
        if (ctx?.waitUntil) {
            ctx.waitUntil(queueForHumanReview(env, entry, classification));
        }
        return corsJson({
            status: 'held_for_review',
            reason: 'Content flagged for human review. It will be published or rejected after review.',
        }, { status: 202 });
    }

    // Apply tags from classification
    if (classification.tags?.length > 0) {
        entry.moderation_tags = classification.tags;
    }

    // Append to ledger chain
    const chainResult = await appendToChain(env, entry.topic, entry);

    // Async: replicate to KV
    if (ctx?.waitUntil) {
        ctx.waitUntil(replicateToKV(env, ctx, entry, chainResult));
    } else {
        await replicateToKV(env, null, entry, chainResult);
    }

    return corsJson({
        status: 'accepted',
        entry_id: chainResult.entry_id,
        entry_hash: chainResult.entry_hash,
        sequence: chainResult.sequence,
        state: entry.state,
        moderation_tags: entry.moderation_tags || [],
        tokens_remaining: budgetResult.tokens_remaining,
        identity: {
            type: authorType,
            method: identity?.method || 'none',
            trust_level: identity?.trust_level || 'none',
        },
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

    // Tier 1: Schema validation
    const validation = validateResponse(type, payload || {});
    if (!validation.valid) {
        return corsJson({
            error: 'schema_validation_failed',
            action: 'return_for_revision',
            errors: validation.errors,
        }, { status: 422 });
    }

    if (!topic || typeof topic !== 'string') {
        return corsJson({
            error: 'schema_validation_failed',
            errors: [{ field: 'topic', error: 'Required' }],
        }, { status: 422 });
    }

    // Tier 1: Budget
    const cost = TOKEN_COSTS[type] || 1;
    const budgetResult = await checkBudget(env, deviceId, authorType, cost);
    if (!budgetResult.allowed) {
        return corsJson({
            error: 'budget_exceeded',
            tokens_remaining: budgetResult.tokens_remaining,
            resets_at: budgetResult.resets_at,
        }, { status: 429 });
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

    // Tier 2: classify
    const classification = await classifyContent(env, entry);
    if (classification.action === 'hard_reject_flag') {
        if (ctx?.waitUntil) ctx.waitUntil(queueForHumanReview(env, entry, classification));
        return corsJson({ status: 'held_for_review' }, { status: 202 });
    }
    if (classification.tags?.length > 0) entry.moderation_tags = classification.tags;

    const chainResult = await appendToChain(env, entry.topic, entry);

    if (ctx?.waitUntil) {
        ctx.waitUntil(replicateToKV(env, ctx, entry, chainResult));
    } else {
        await replicateToKV(env, null, entry, chainResult);
    }

    return corsJson({
        status: 'accepted',
        entry_id: chainResult.entry_id,
        entry_hash: chainResult.entry_hash,
        sequence: chainResult.sequence,
        moderation_tags: entry.moderation_tags || [],
        tokens_remaining: budgetResult.tokens_remaining,
    }, { status: 201 });
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

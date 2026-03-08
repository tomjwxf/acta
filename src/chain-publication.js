/**
 * Chain Head Publication — External Anchoring
 *
 * Scheduled handler (cron trigger) that computes a Merkle root
 * of all topic chain heads and logs it for external witnessing.
 *
 * Architecture (from adversarial analysis):
 *   Without external anchoring, the operator can rewrite the chain.
 *   This publishes cryptographic proof that the ledger existed in a
 *   specific state at a specific time.
 *
 *   Phase 1: Log Merkle root to KV (verifiable via /api/chain-anchors)
 *   Phase 2: Post to Bluesky/X via API (independent witness)
 *   Phase 3: Anchor to blockchain via OP_RETURN (immutable)
 */

import { jcsSerialize } from './durable-objects/ledger-chain.js';

/**
 * Scheduled handler — called by cron trigger.
 * Computes and stores a Merkle root of all topic chain heads.
 */
export async function handleScheduled(env) {
    const kv = env.ACTA_KV;
    if (!kv) return;

    // 1. List all topics
    const topicsList = await kv.list({ prefix: 'topics:list' });
    let topics = [];
    const rawTopics = await kv.get('topics:list', { type: 'json' });
    if (rawTopics) topics = rawTopics;

    if (topics.length === 0) {
        console.log('[ANCHOR] No topics to anchor.');
        return;
    }

    // 2. Fetch chain heads for each topic
    const chainHeads = [];
    for (const topic of topics) {
        const topicName = typeof topic === 'string' ? topic : topic.topic;
        try {
            const id = env.LEDGER_CHAIN.idFromName(topicName);
            const stub = env.LEDGER_CHAIN.get(id);
            const resp = await stub.fetch(new Request('http://internal/chain-head'));
            const head = await resp.json();
            chainHeads.push({
                topic: topicName,
                chain_head_hash: head.chain_head_hash,
                chain_length: head.chain_length,
            });
        } catch (err) {
            console.error(`[ANCHOR] Failed to get chain head for ${topicName}:`, err.message);
        }
    }

    if (chainHeads.length === 0) return;

    // 3. Compute Merkle root
    const merkleRoot = await computeMerkleRoot(chainHeads);

    // 4. Store anchor record
    const anchor = {
        timestamp: new Date().toISOString(),
        merkle_root: merkleRoot,
        chain_heads: chainHeads,
        topic_count: chainHeads.length,
    };

    const anchorKey = `anchor:${anchor.timestamp}`;
    await kv.put(anchorKey, JSON.stringify(anchor), { expirationTtl: 86400 * 365 * 5 }); // 5 year retention

    // Update latest anchor pointer
    await kv.put('anchor:latest', JSON.stringify(anchor));

    console.log(`[ANCHOR] Anchored ${chainHeads.length} topics. Merkle root: ${merkleRoot}`);

    // Phase 2 (future): Post to Bluesky
    // await postToBluesky(env, anchor);

    return anchor;
}

/**
 * Compute a simple Merkle root from chain heads.
 * Sorted by topic name for determinism.
 */
async function computeMerkleRoot(chainHeads) {
    // Sort by topic for determinism
    const sorted = [...chainHeads].sort((a, b) => a.topic.localeCompare(b.topic));

    // Create leaf hashes
    const leaves = [];
    for (const head of sorted) {
        const leaf = await sha256(jcsSerialize(head));
        leaves.push(leaf);
    }

    // Build tree
    if (leaves.length === 0) return '0'.repeat(64);
    if (leaves.length === 1) return leaves[0];

    let layer = leaves;
    while (layer.length > 1) {
        const nextLayer = [];
        for (let i = 0; i < layer.length; i += 2) {
            if (i + 1 < layer.length) {
                nextLayer.push(await sha256(layer[i] + layer[i + 1]));
            } else {
                nextLayer.push(layer[i]); // Odd leaf promoted
            }
        }
        layer = nextLayer;
    }

    return layer[0];
}

async function sha256(str) {
    const buffer = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(str)
    );
    return [...new Uint8Array(buffer)]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

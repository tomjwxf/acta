/**
 * LedgerChain Durable Object
 *
 * Maintains a hash-chained, append-only ledger for a single topic.
 * One DO instance per topic ensures strict linear ordering within topics
 * while allowing parallel writes across topics.
 *
 * Storage layout:
 *   prev_hash     → SHA-256 hex of the last entry
 *   chain_length  → integer count
 *   entry:{id}    → full entry object
 *   entries_list  → ordered array of entry IDs
 */
export class LedgerChain {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/append') {
      return this.handleAppend(request);
    }

    if (request.method === 'GET' && url.pathname === '/entries') {
      return this.handleGetEntries(url);
    }

    if (request.method === 'GET' && url.pathname === '/verify') {
      return this.handleVerifyChain();
    }

    if (request.method === 'POST' && url.pathname === '/tombstone') {
      return this.handleTombstone(request);
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Append a new entry to the hash chain.
   * The entry must already be validated (schema check happens in the Worker).
   */
  async handleAppend(request) {
    const entry = await request.json();

    const prevHash = (await this.state.storage.get('prev_hash')) || '0'.repeat(64);
    const chainLength = (await this.state.storage.get('chain_length')) || 0;

    const fullEntry = {
      ...entry,
      entry_id: crypto.randomUUID(),
      prev_hash: prevHash,
      sequence: chainLength,
      timestamp: new Date().toISOString(),
    };

    // Compute entry hash (deterministic: sorted keys, no entry_hash in input)
    const entryHash = await this.computeHash(fullEntry);
    fullEntry.entry_hash = entryHash;

    // Atomic write: entry + prev_hash + chain_length + entries_list update
    const entriesList = (await this.state.storage.get('entries_list')) || [];
    entriesList.push(fullEntry.entry_id);

    await this.state.storage.put({
      [`entry:${fullEntry.entry_id}`]: fullEntry,
      prev_hash: entryHash,
      chain_length: chainLength + 1,
      entries_list: entriesList,
    });

    return Response.json({
      entry_id: fullEntry.entry_id,
      entry_hash: entryHash,
      sequence: fullEntry.sequence,
      prev_hash: prevHash,
    });
  }

  /**
   * Get entries with pagination.
   * ?offset=0&limit=20&order=desc
   */
  async handleGetEntries(url) {
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const order = url.searchParams.get('order') || 'desc';

    const entriesList = (await this.state.storage.get('entries_list')) || [];
    const chainLength = entriesList.length;

    let slice;
    if (order === 'desc') {
      const start = Math.max(0, chainLength - offset - limit);
      const end = chainLength - offset;
      slice = entriesList.slice(start, end).reverse();
    } else {
      slice = entriesList.slice(offset, offset + limit);
    }

    const entries = [];
    for (const id of slice) {
      const entry = await this.state.storage.get(`entry:${id}`);
      if (entry) entries.push(entry);
    }

    return Response.json({
      entries,
      total: chainLength,
      offset,
      limit,
      has_more: offset + limit < chainLength,
    });
  }

  /**
   * Verify the entire hash chain is intact.
   * Returns { valid: true, length: N } or { valid: false, broken_at: N, reason: ... }
   */
  async handleVerifyChain() {
    const entriesList = (await this.state.storage.get('entries_list')) || [];
    let expectedPrevHash = '0'.repeat(64);

    for (let i = 0; i < entriesList.length; i++) {
      const entry = await this.state.storage.get(`entry:${entriesList[i]}`);
      if (!entry) {
        return Response.json({ valid: false, broken_at: i, reason: 'missing_entry' });
      }

      if (entry.prev_hash !== expectedPrevHash) {
        return Response.json({
          valid: false,
          broken_at: i,
          reason: 'prev_hash_mismatch',
          expected: expectedPrevHash,
          actual: entry.prev_hash,
        });
      }

      // Recompute hash (exclude entry_hash from the computation)
      const { entry_hash, ...entryWithoutHash } = entry;
      const recomputed = await this.computeHash(entryWithoutHash);
      if (recomputed !== entry_hash) {
        return Response.json({
          valid: false,
          broken_at: i,
          reason: 'entry_hash_mismatch',
          expected: recomputed,
          actual: entry_hash,
        });
      }

      expectedPrevHash = entry_hash;
    }

    return Response.json({ valid: true, length: entriesList.length });
  }

  /**
   * Tombstone an entry — purge payload, preserve hash chain integrity.
   * Used for CSAM, court orders, severe doxxing that slipped past hard-reject.
   */
  async handleTombstone(request) {
    const { entry_id, category, authority_reference } = await request.json();

    const entry = await this.state.storage.get(`entry:${entry_id}`);
    if (!entry) {
      return Response.json({ error: 'entry_not_found' }, { status: 404 });
    }

    if (entry.tombstone) {
      return Response.json({ error: 'already_tombstoned' }, { status: 409 });
    }

    // Preserve chain integrity: keep hash, remove payload
    const tombstoned = {
      entry_id: entry.entry_id,
      prev_hash: entry.prev_hash,
      sequence: entry.sequence,
      timestamp: entry.timestamp,
      entry_hash: entry.entry_hash, // Preserves chain linkage
      tombstone: {
        category, // CSAM_REMOVAL | LEGAL_ORDER | OPERATOR_REMOVAL
        authority_reference,
        tombstoned_at: new Date().toISOString(),
        original_content_hash: await this.computePayloadHash(entry.payload),
      },
      payload: null,
      type: entry.type,
      subtype: entry.subtype,
      author: entry.author,
      state: 'tombstoned',
    };

    await this.state.storage.put(`entry:${entry_id}`, tombstoned);

    return Response.json({ status: 'tombstoned', entry_id });
  }

  /**
   * Compute SHA-256 hash of an object using deterministic serialization.
   */
  async computeHash(obj) {
    const canonical = JSON.stringify(obj, Object.keys(obj).sort());
    const buffer = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(canonical)
    );
    return [...new Uint8Array(buffer)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Compute hash of just the payload for tombstone records.
   */
  async computePayloadHash(payload) {
    if (!payload) return null;
    return this.computeHash(payload);
  }
}

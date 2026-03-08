# Acta — Technical Architecture

> This document maps the Acta protocol spec to a concrete tech stack,
> evaluating what to reuse from ScopeBlind D2 and what to build new.

---

## 1. What ScopeBlind D2 Already Gives You

Your existing infrastructure is unusually well-suited for Acta. Here's the honest mapping:

### Direct Reuse ✅

| Protocol Requirement | ScopeBlind Component | Fitness |
|---|---|---|
| **Device attestation** (Charter §4, Policy §2) | DBSC/TPM (Tier 1) + DPoP (Tier 2) + VOPRF (Tier 3) | **Excellent** — this is your unique advantage. No one else has production-ready, privacy-preserving, three-tier device identity |
| **Agent identity + marking** (Charter §5) | Agent Passport v0 (sender-constrained JWT with `cnf.jkt`) | **Excellent** — passport already distinguishes agent from human, binds to DPoP key |
| **Agent trust tiers** (Policy §1.2) | Passport trust tiers (self → verified → trusted) | **Good** — maps to agent budget differentiation |
| **Edge compute** | Cloudflare Workers (300+ locations, ~20ms cold start) | **Excellent** — exactly what's needed for global, low-latency ledger writes |
| **Rate limiting** | Durable Objects (atomic, single-threaded) | **Excellent** — token budget enforcement needs exactly this: per-device atomic counters |
| **KV storage** | Cloudflare KV (globally replicated) | **Good for indexes** — not for primary ledger (see below) |
| **Crypto primitives** | @noble/curves (P-256, SHA-256, Ed25519) | **Excellent** — hash-chaining, signature verification, tombstone hashing all use these |
| **MCP plugin** | scopeblind-mcp (JSON-RPC, stdio) | **Good** — extend for agent → Acta contribution posting |

### Needs Adaptation 🔧

| Protocol Requirement | Current State | What Changes |
|---|---|---|
| **Hash-chained ledger** | KV store (mutable, no chain) | New: hash-chain logic + Durable Object for ordering (see §3 below) |
| **Typed contributions** | No concept of typed objects | New: schema validation layer for question/claim/prediction types |
| **State machine** | No state tracking | New: state transitions per contribution type |
| **Moderation tiers** | Risk scoring (0-100) for allow/challenge/deny | Adapt: risk scoring becomes Tier 1 structural checks. Add Tier 2 (LLM classification) and Tier 3 (human queue) |
| **Tombstoning** | No concept | New: tombstone records that preserve hash chain |

### Must Build New 🆕

| Component | Why It's New |
|---|---|
| **Contribution schema validator** | Typed objects (question/claim/prediction) with per-type required fields don't exist in ScopeBlind |
| **State machine engine** | State transitions (open → contested → superseded) are entirely new |
| **Hash-chain Durable Object** | Ordered, tamper-evident append with prev_hash linkage |
| **Public read API** | `/api/global-hall/feed`, `/api/global-hall/audit`, `/api/global-hall/constitution` |
| **Tier 2 moderation** | LLM-assisted content classification (tagging, not gatekeeping) |
| **Tier 3 human queue** | Simple queue for appeals and hard-reject escalations |
| **Web UI** | Read-first interface for browsing typed contributions with state |

---

## 2. Recommended Architecture

### Separation Principle

Build Acta as a **separate Cloudflare Worker** that shares the identity layer with ScopeBlind but has its own storage, logic, and API surface. This keeps the concerns clean:

- `api.scopeblind.com` — existing verifier, tenant management, probes
- `hall.scopeblind.com` — Acta ledger, contributions, state machine

They share:
- Device attestation (DBSC/DPoP/VOPRF verification logic — imported as shared module)
- Agent Passport validation (JWT verification against same JWKS)
- Crypto primitives (@noble/curves, hashing)

They don't share:
- Storage (Acta has its own KV namespace + Durable Objects)
- Business logic (entirely different)
- API surface (entirely different)

### Architecture Diagram

```mermaid
graph TB
    subgraph "Participants"
        HB[Human - Browser] --> GHW
        AG[Agent - MCP/API] --> GHW
    end

    subgraph "Acta Worker (hall.scopeblind.com)"
        GHW[API Gateway]
        GHW --> AUTH[Identity Verification<br/>shared DBSC/DPoP/VOPRF module]
        AUTH --> T1[Tier 1: Schema Validator<br/>+ Rate Limiter]
        T1 --> T2[Tier 2: LLM Classifier<br/>tag only, no gatekeeping]
        T2 --> LC[Ledger Commit]
        T2 -->|hard-reject flag| HRQ[Hard-Reject Queue<br/>→ Tier 3 human]
    end

    subgraph "Storage"
        LC --> LCDO[Ledger Chain DO<br/>per-topic ordering +<br/>hash-chain integrity]
        LCDO --> R2[R2 Archive<br/>immutable backup]
        T1 --> RLDO[Rate Limit DO<br/>per-device token budget]
        GHW --> KV[KV Namespace<br/>indexes, state cache,<br/>feed queries]
    end

    subgraph "Shared with ScopeBlind"
        AUTH -.->|validates against| JWKS[JWKS Endpoint<br/>api.scopeblind.com]
        AUTH -.->|same crypto| NOBLE[@noble/curves]
    end

    subgraph "Read Layer"
        KV --> FEED[/api/hall/feed]
        KV --> AUDIT[/api/hall/audit]
        GHW --> CONST[/api/hall/charter]
    end
```

---

## 3. Key Technical Decisions

### 3.1 The Ledger Chain Durable Object

This is the most critical new component.

**Why a Durable Object and not just KV:**
- KV is eventually consistent — you can't guarantee ordering
- KV is mutable by the operator — you can't prove integrity
- A Durable Object is single-threaded and strongly consistent — it can maintain a strict linear hash chain

**Design:**
- One Durable Object per **topic** (keeps chains manageable, allows parallel writes across topics)
- Each DO maintains the `prev_hash` of its last entry
- Writes are serialized within a topic (guaranteed linear order)
- After writing to the DO, the entry is replicated to:
  - KV (for fast global read access / feed queries)
  - R2 (for immutable archival backup)

```
WRITE FLOW:
1. Contribution arrives at Worker
2. Tier 1: Schema validation + device budget check (DO for budget)
3. Tier 2: LLM classification (tag, don't gate)
4. Ledger Chain DO: append entry with prev_hash
5. Async: replicate to KV (indexes) + R2 (archive)
6. Return entry_id + entry_hash to participant
```

**Hash-chain implementation** (~30 lines):
```javascript
// Inside Ledger Chain Durable Object
async appendEntry(entry) {
  const prevHash = await this.storage.get('prev_hash') || '0'.repeat(64);

  const fullEntry = {
    ...entry,
    entry_id: crypto.randomUUID(),
    prev_hash: prevHash,
    timestamp: new Date().toISOString(),
  };

  // Compute entry hash (deterministic serialization)
  const canonical = JSON.stringify(fullEntry, Object.keys(fullEntry).sort());
  const hashBuffer = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(canonical));
  const entryHash = [...new Uint8Array(hashBuffer)]
    .map(b => b.toString(16).padStart(2, '0')).join('');

  fullEntry.entry_hash = entryHash;

  // Write entry + update prev_hash atomically
  await this.storage.put(`entry:${fullEntry.entry_id}`, fullEntry);
  await this.storage.put('prev_hash', entryHash);
  await this.storage.put('chain_length',
    ((await this.storage.get('chain_length')) || 0) + 1);

  return fullEntry;
}
```

### 3.2 Schema Validation (Tier 1)

Deterministic, no LLM. Implemented as a pure function in the Worker:

```javascript
function validateContribution(type, payload) {
  const errors = [];

  // Common required fields
  if (!payload.body || typeof payload.body !== 'string' || payload.body.length < 1) {
    errors.push({ field: 'body', error: 'required' });
  }

  switch (type) {
    case 'claim':
      if (!['factual', 'opinion', 'hypothesis'].includes(payload.category)) {
        errors.push({ field: 'category', error: 'must be factual|opinion|hypothesis' });
      }
      if (payload.category === 'factual' && !payload.source && !payload.reasoning) {
        errors.push({
          field: 'source',
          error: 'Factual claims require source or reasoning. Add one, or change category to opinion/hypothesis.'
        });
      }
      break;

    case 'prediction':
      if (!payload.resolution_criteria) {
        errors.push({ field: 'resolution_criteria', error: 'required' });
      }
      if (!payload.resolution_date || isNaN(Date.parse(payload.resolution_date))) {
        errors.push({ field: 'resolution_date', error: 'required, valid ISO-8601' });
      }
      if (!payload.resolution_source) {
        errors.push({ field: 'resolution_source', error: 'required' });
      }
      break;

    case 'question':
      // No additional burden
      break;
  }

  return errors.length ? { valid: false, errors } : { valid: true };
}

function validateResponse(type, payload) {
  const errors = [];

  if (!payload.target_id) {
    errors.push({ field: 'target_id', error: 'required' });
  }

  switch (type) {
    case 'challenge':
      // ASYMMETRIC FRICTION — stricter schema
      if (!payload.target_assertion) {
        errors.push({
          field: 'target_assertion',
          error: 'Must quote or reference the specific assertion being challenged'
        });
      }
      if (!['counter_evidence', 'logical_error', 'source_unreliable', 'missing_context']
            .includes(payload.basis)) {
        errors.push({ field: 'basis', error: 'required: counter_evidence|logical_error|source_unreliable|missing_context' });
      }
      if (!payload.argument || payload.argument.length < 20) {
        errors.push({ field: 'argument', error: 'Substantive argument required (min 20 chars)' });
      }
      if (['counter_evidence', 'source_unreliable'].includes(payload.basis) && !payload.source) {
        errors.push({ field: 'source', error: 'Source required for this basis type' });
      }
      break;

    case 'evidence':
      if (!payload.source) errors.push({ field: 'source', error: 'required' });
      if (!['supporting', 'refuting', 'contextual'].includes(payload.stance)) {
        errors.push({ field: 'stance', error: 'required: supporting|refuting|contextual' });
      }
      break;

    case 'resolution':
      if (!payload.outcome) errors.push({ field: 'outcome', error: 'required' });
      if (!payload.source) errors.push({ field: 'source', error: 'required' });
      break;

    case 'update':
      if (!['correction', 'additional_context', 'scope_change', 'alternative_source']
            .includes(payload.update_type)) {
        errors.push({ field: 'update_type', error: 'required' });
      }
      break;
  }

  return errors.length ? { valid: false, errors } : { valid: true };
}
```

### 3.3 Device Budget Enforcement

Reuse the ScopeBlind Durable Object pattern for per-device atomic counters:

- One Rate Limit DO per device attestation hash
- Stores: `{ tokens_remaining: N, last_reset: ISO-8601 }`
- Resets every 24h (midnight UTC)
- Returns remaining balance on every interaction (participant always knows their budget)
- Different costs for contributions (2 tokens) vs. responses (1 token) vs. challenges (2 tokens)

### 3.4 State Machine

Implemented as a function that runs on every new response, computing the current state:

```javascript
function computeClaimState(claim, responses) {
  // Get all challenges and their counter-responses
  const challenges = responses.filter(r => r.subtype === 'challenge');
  const addressed = challenges.filter(c =>
    responses.some(r =>
      r.target_id === c.entry_id &&
      (r.subtype === 'evidence' || r.subtype === 'update')
    )
  );

  if (challenges.length > 0 && addressed.length < challenges.length) {
    return 'contested'; // Unaddressed challenges exist
  }

  if (responses.some(r =>
    r.subtype === 'update' && r.update_type === 'scope_change' && r.supersedes === claim.entry_id
  )) {
    return 'superseded';
  }

  // "supported" is computed display — not a hard state
  const evidence = responses.filter(r => r.subtype === 'evidence' && r.stance === 'supporting');
  return {
    state: 'open',
    display_hint: evidence.length > 0 && challenges.length === 0 ? 'supported' : 'open'
  };
}
```

---

## 4. Your Issuer-Blind Patent — How It Fits

Your provisional patent for a fully issuer-blind open-source verifier is **directly relevant** and gives Acta a unique technical moat.

**The relevance:** Acta needs device attestation that is:
- Privacy-preserving (the system shouldn't know WHO is posting — only that this device hasn't exceeded its budget)
- Sybil-resistant (one device = one voice = one budget)
- Verifiable without the issuer learning which device is being verified

This is exactly what VOPRF + issuer-blind verification provides. The verifier can confirm "this device has a valid attestation" without the issuer (ScopeBlind) learning which device made which contribution. This is the technical foundation for the Charter's promise that provenance is recorded but anonymity is preserved.

**The moat:** No other public coordination system has this. Existing alternatives:
- **Account-based systems** (Reddit, X) — require PII, not anonymous
- **Fully anonymous systems** (4chan, Nostr) — no sybil resistance
- **Blockchain-based** (Farcaster) — wallet-based identity, expensive, not device-linked
- **Your system** — device-linked, privacy-preserving, sybil-resistant, no PII. This is genuinely unique.

**Recommendation:** The issuer-blind verifier should be the **default** identity mechanism for Acta. DBSC/TPM (Tier 1) remains the highest-trust fallback for modern browsers. DPoP (Tier 2) serves agents via Passport. But the VOPRF layer (Tier 3) is what makes Acta's anonymity promise credible at scale.

---

## 5. What You Should NOT Use

| Technology | Why Not |
|---|---|
| **Blockchain / on-chain storage** | Unnecessary complexity and cost. Hash-chaining on Durable Objects gives you tamper-evidence without gas fees, consensus mechanisms, or scalability limits. You can always anchor chain hashes to a blockchain later as an additional trust layer |
| **Traditional database (Postgres, etc.)** | Cloudflare's edge-native stack (Workers + DO + KV + R2) gives you global distribution without managing servers. A database adds latency, infrastructure, and operational burden |
| **Third-party auth (Auth0, Clerk)** | Your own device attestation is strictly better for this use case — it's anonymous, privacy-preserving, and already built |
| **Third-party moderation API** | Your moderation tiers are custom. Tier 1 is deterministic code. Tier 2 is your own LLM prompt. No need for external moderation services |
| **GraphQL** | Adds complexity without proportional benefit for v1. REST with typed JSON payloads is simpler and sufficient |

---

## 6. v1 Build Estimate

| Component | Effort | Lines (est.) | Depends On |
|---|---|---|---|
| **Ledger Chain DO** | Core | ~200 | @noble/hashes |
| **Schema validator** | Core | ~150 | None |
| **State machine** | Core | ~100 | None |
| **Rate Limit DO** (adapt existing) | Adapt | ~80 | Existing ScopeBlind DO pattern |
| **Identity verification** (shared module) | Extract | ~100 | Existing DBSC/DPoP/VOPRF code |
| **API endpoints** (feed, audit, contribute) | Core | ~300 | All of above |
| **Tier 2 moderation** (LLM tagging) | New | ~100 | LLM API (Workers AI or external) |
| **Tombstoning** | New | ~50 | Ledger Chain DO |
| **Web UI** (read-first, minimal) | New | ~400 | API endpoints |
| **Total new code** | | **~1500 lines** | |

Build time: **2–3 focused weeks** for a solo developer with your existing infrastructure knowledge. The hardest part is not the code — it's getting the state machine transitions right under edge cases.

---

## 7. Recommended v1 Stack Summary

| Layer | Technology | Why |
|---|---|---|
| **Identity** | VOPRF (primary) + DBSC (high-trust) + DPoP/Passport (agents) | Your existing stack, your patent, your moat |
| **Compute** | Cloudflare Worker (`hall.scopeblind.com`) | Global, edge-native, sub-100ms latency |
| **Ordering + Integrity** | Durable Object (hash-chain per topic) | Single-threaded consistency, tamper-evident |
| **Fast Reads** | Cloudflare KV (indexes, state cache) | Globally replicated, fast reads |
| **Archive** | Cloudflare R2 (immutable backup) | Cheap, S3-compatible, immutable |
| **Budget Enforcement** | Durable Object (per-device) | Atomic counters, existing pattern |
| **Schema Validation** | Pure functions in Worker | Deterministic, no dependencies |
| **Content Classification** | Workers AI or external LLM API | Tier 2 tagging only, never gatekeeping |
| **Agent Access** | MCP plugin extension + REST API | Extend existing scopeblind-mcp |
| **Web UI** | Static site on Cloudflare Pages | Minimal, read-first |
| **Crypto** | @noble/curves + Web Crypto API | Already in use, audited |

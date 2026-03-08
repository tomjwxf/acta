/**
 * Acta Web UI
 *
 * Server-rendered HTML served directly from the Worker.
 * Read-first interface: browse topics, view typed contributions with state.
 *
 * No build step, no framework, no external dependencies.
 * Just HTML + CSS + minimal vanilla JS for API calls.
 */

// ── CSS ─────────────────────────────────────────────────────────────

const CSS = `
:root {
  --bg: #0a0a0b;
  --surface: #141416;
  --surface-2: #1c1c20;
  --border: #2a2a30;
  --border-hover: #3a3a42;
  --text: #e4e4e7;
  --text-muted: #8a8a94;
  --text-dim: #5a5a64;
  --accent: #22c55e;
  --accent-dim: rgba(34, 197, 94, 0.15);
  --accent-glow: rgba(34, 197, 94, 0.08);
  --red: #ef4444;
  --red-dim: rgba(239, 68, 68, 0.15);
  --amber: #f59e0b;
  --amber-dim: rgba(245, 158, 11, 0.15);
  --blue: #3b82f6;
  --blue-dim: rgba(59, 130, 246, 0.15);
  --purple: #a855f7;
  --purple-dim: rgba(168, 85, 247, 0.15);
  --radius: 8px;
  --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  min-height: 100vh;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.container { max-width: 800px; margin: 0 auto; padding: 0 20px; }

/* ── Header ── */
header {
  border-bottom: 1px solid var(--border);
  padding: 16px 0;
  position: sticky;
  top: 0;
  background: rgba(10, 10, 11, 0.92);
  backdrop-filter: blur(12px);
  z-index: 100;
}
header .container {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.logo {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text);
}
.logo span { color: var(--accent); }
nav a {
  color: var(--text-muted);
  margin-left: 24px;
  font-size: 14px;
  font-weight: 500;
  transition: color 0.15s;
}
nav a:hover { color: var(--text); text-decoration: none; }

/* ── Hero ── */
.hero {
  padding: 80px 0 60px;
  text-align: center;
}
.hero h1 {
  font-size: 42px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.1;
  margin-bottom: 16px;
}
.hero h1 em {
  font-style: normal;
  background: linear-gradient(135deg, var(--accent), #4ade80);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
.hero p {
  color: var(--text-muted);
  font-size: 18px;
  max-width: 560px;
  margin: 0 auto;
}

/* ── Cards ── */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  margin-bottom: 12px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.card:hover {
  border-color: var(--border-hover);
  box-shadow: 0 4px 24px rgba(0,0,0,0.3);
}
.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.card-body { color: var(--text); font-size: 15px; }
.card-meta {
  display: flex;
  gap: 12px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-dim);
}

/* ── Tags / Badges ── */
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.badge-question { background: var(--blue-dim); color: var(--blue); }
.badge-claim { background: var(--purple-dim); color: var(--purple); }
.badge-prediction { background: var(--amber-dim); color: var(--amber); }
.badge-evidence { background: var(--accent-dim); color: var(--accent); }
.badge-challenge { background: var(--red-dim); color: var(--red); }
.badge-update { background: var(--blue-dim); color: var(--blue); }
.badge-resolution { background: var(--accent-dim); color: var(--accent); }

.badge-open { background: var(--accent-dim); color: var(--accent); }
.badge-contested { background: var(--red-dim); color: var(--red); }
.badge-supported { background: var(--accent-dim); color: var(--accent); }
.badge-superseded { background: var(--amber-dim); color: var(--amber); }
.badge-resolved_confirmed { background: var(--accent-dim); color: var(--accent); }
.badge-resolved_refuted { background: var(--red-dim); color: var(--red); }
.badge-unsubstantiated { background: var(--amber-dim); color: var(--amber); }

.badge-human { background: var(--accent-dim); color: var(--accent); }
.badge-agent { background: var(--purple-dim); color: var(--purple); }

/* ── Topic List ── */
.topic-list { list-style: none; }
.topic-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 8px;
  transition: border-color 0.15s;
}
.topic-item:hover { border-color: var(--border-hover); }
.topic-name { font-weight: 600; font-size: 15px; }
.topic-stats { color: var(--text-dim); font-size: 13px; }

/* ── Empty State ── */
.empty {
  text-align: center;
  padding: 60px 20px;
  color: var(--text-muted);
}
.empty h3 { margin-bottom: 8px; font-weight: 600; }
.empty p { font-size: 14px; color: var(--text-dim); }
.empty code {
  background: var(--surface-2);
  padding: 2px 6px;
  border-radius: 3px;
  font-family: var(--mono);
  font-size: 13px;
}

/* ── About / Charter ── */
.charter-section {
  padding: 60px 0 40px;
}
.charter-section h2 {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 24px;
}
.invariant {
  display: flex;
  gap: 12px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
.invariant:last-child { border-bottom: none; }
.invariant-num {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
  min-width: 24px;
}
.invariant-text {
  font-size: 14px;
  color: var(--text-muted);
}
.invariant-text strong {
  color: var(--text);
  font-weight: 600;
}

/* ── Contribute Form ── */
.contribute-section { padding: 40px 0; }
.form-group { margin-bottom: 16px; }
.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 6px;
}
select, input, textarea {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  color: var(--text);
  font-family: var(--font);
  font-size: 14px;
  transition: border-color 0.15s;
}
select:focus, input:focus, textarea:focus {
  outline: none;
  border-color: var(--accent);
}
textarea { min-height: 100px; resize: vertical; }
button {
  background: var(--accent);
  color: #000;
  border: none;
  padding: 10px 24px;
  border-radius: var(--radius);
  font-family: var(--font);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}
button:hover { opacity: 0.9; }
button:disabled { opacity: 0.4; cursor: not-allowed; }

.result-box {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  margin-top: 16px;
  font-family: var(--mono);
  font-size: 13px;
  white-space: pre-wrap;
  display: none;
}

/* ── Footer ── */
footer {
  border-top: 1px solid var(--border);
  padding: 24px 0;
  margin-top: 60px;
  text-align: center;
  font-size: 13px;
  color: var(--text-dim);
}
footer a { color: var(--text-muted); }

/* ── Verify Banner ── */
.verify-banner {
  background: var(--accent-dim);
  border: 1px solid rgba(34, 197, 94, 0.25);
  border-radius: var(--radius);
  padding: 12px 16px;
  margin-bottom: 20px;
  font-size: 13px;
  color: var(--accent);
  display: flex;
  align-items: center;
  gap: 8px;
}
.verify-banner .icon { font-size: 16px; }

@media (max-width: 600px) {
  .hero h1 { font-size: 28px; }
  .hero p { font-size: 15px; }
  .container { padding: 0 16px; }
}
`;

// ── HTML Templates ──────────────────────────────────────────────────

function layout(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Acta</title>
  <meta name="description" content="A contestable, checkable, versioned public record. Protocol for epistemically accountable coordination.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
  <header>
    <div class="container">
      <a href="/" class="logo">A<span>C</span>TA</a>
      <nav>
        <a href="/">Feed</a>
        <a href="/about">Charter</a>
        <a href="https://github.com/tomjwxf/acta" target="_blank">GitHub</a>
      </nav>
    </div>
  </header>
  ${body}
  <footer>
    <div class="container">
      Built on verifiable typed contributions · Identity by <a href="https://scopeblind.com">ScopeBlind</a> · <a href="/api/charter">API</a>
    </div>
  </footer>
</body>
</html>`;
}

function homePage(data) {
    const topics = data.topics || [];
    const topicsList = topics.length > 0
        ? topics.map(t => `
        <a href="/topic/${encodeURIComponent(t.topic)}" style="text-decoration:none;color:inherit;">
          <div class="topic-item">
            <span class="topic-name">${escapeHtml(t.topic)}</span>
            <span class="topic-stats">${t.entry_count} entries · ${timeAgo(t.last_entry_at)}</span>
          </div>
        </a>`).join('')
        : `<div class="empty">
        <h3>No topics yet</h3>
        <p>Be the first to contribute. POST to <code>/api/contribute</code> with a typed contribution.</p>
      </div>`;

    return layout('Feed', `
    <main class="container">
      <div class="hero">
        <h1>The <em>public record</em></h1>
        <p>Typed contributions. Explicit burdens. Tamper-evident. Challengeable. No entity — including the operator — can silently alter the record.</p>
      </div>

      <div class="verify-banner">
        <span class="icon">⛓</span>
        Every entry is hash-chained. Verify any topic's integrity via <code>GET /api/verify?topic=…</code>
      </div>

      <h2 style="font-size:18px;font-weight:700;margin-bottom:16px;">Topics</h2>
      ${topicsList}

      <div class="contribute-section">
        <h2 style="font-size:18px;font-weight:700;margin-bottom:16px;">Contribute</h2>
        <form id="contribute-form" onsubmit="return submitContribution(event)">
          <div class="form-group">
            <label>Topic</label>
            <input type="text" id="c-topic" placeholder="e.g., scopeblind, acta-protocol, agent-identity" required>
          </div>
          <div class="form-group">
            <label>Type</label>
            <select id="c-type" onchange="updateFormFields()">
              <option value="question">Question</option>
              <option value="claim">Claim</option>
              <option value="prediction">Prediction</option>
            </select>
          </div>
          <div class="form-group">
            <label>Body</label>
            <textarea id="c-body" placeholder="Your contribution…" required></textarea>
          </div>
          <div id="claim-fields" style="display:none;">
            <div class="form-group">
              <label>Category</label>
              <select id="c-category">
                <option value="opinion">Opinion</option>
                <option value="factual">Factual</option>
                <option value="hypothesis">Hypothesis</option>
              </select>
            </div>
            <div class="form-group">
              <label>Source (URL, DOI, reference — required for factual claims)</label>
              <input type="text" id="c-source" placeholder="https://…">
            </div>
            <div class="form-group">
              <label>Uncertainty (required for opinion/hypothesis)</label>
              <textarea id="c-uncertainty" placeholder="How confident are you? What would change your mind?"></textarea>
            </div>
          </div>
          <div id="prediction-fields" style="display:none;">
            <div class="form-group">
              <label>Resolution Criteria</label>
              <textarea id="c-criteria" placeholder="How to determine if confirmed or refuted"></textarea>
            </div>
            <div class="form-group">
              <label>Resolution Date</label>
              <input type="date" id="c-date">
            </div>
            <div class="form-group">
              <label>Resolution Source</label>
              <input type="text" id="c-resolution-source" placeholder="URL of authoritative source">
            </div>
          </div>
          <button type="submit">Submit Contribution</button>
        </form>
        <div id="result" class="result-box"></div>
      </div>
    </main>
    <script>
      function updateFormFields() {
        const type = document.getElementById('c-type').value;
        document.getElementById('claim-fields').style.display = type === 'claim' ? 'block' : 'none';
        document.getElementById('prediction-fields').style.display = type === 'prediction' ? 'block' : 'none';
      }

      async function submitContribution(e) {
        e.preventDefault();
        const type = document.getElementById('c-type').value;
        const payload = { body: document.getElementById('c-body').value };

        if (type === 'claim') {
          payload.category = document.getElementById('c-category').value;
          const src = document.getElementById('c-source').value;
          if (src) payload.source = src;
          const unc = document.getElementById('c-uncertainty').value;
          if (unc) payload.uncertainty = unc;
        }

        if (type === 'prediction') {
          payload.resolution_criteria = document.getElementById('c-criteria').value;
          payload.resolution_date = new Date(document.getElementById('c-date').value).toISOString();
          payload.resolution_source = document.getElementById('c-resolution-source').value;
        }

        const res = await fetch('/api/contribute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type,
            topic: document.getElementById('c-topic').value,
            payload,
          }),
        });

        const data = await res.json();
        const el = document.getElementById('result');
        el.style.display = 'block';
        el.textContent = JSON.stringify(data, null, 2);

        if (res.ok) {
          setTimeout(() => location.reload(), 1500);
        }
      }
    </script>
  `);
}

function topicPage(data) {
    const { topic, feed } = data;
    const entries = feed.entries || [];

    const entriesHtml = entries.length > 0
        ? entries.map(e => `
        <div class="card">
          <div class="card-header">
            <span class="badge badge-${e.subtype}">${e.subtype}</span>
            ${e.state ? `<span class="badge badge-${e.state}">${e.state}</span>` : ''}
            ${e.author_type === 'agent' ? `<span class="badge badge-agent">agent</span>` : ''}
            ${(e.tags || []).map(t => `<span class="badge" style="background:var(--amber-dim);color:var(--amber);">${t}</span>`).join('')}
          </div>
          <div class="card-body">${escapeHtml(e.body_preview || 'No content')}</div>
          <div class="card-meta">
            <span>seq #${e.sequence}</span>
            <span>${timeAgo(e.timestamp)}</span>
            <span title="${e.entry_hash}">hash: ${(e.entry_hash || '').slice(0, 12)}…</span>
            ${e.category ? `<span>${e.category}</span>` : ''}
          </div>
        </div>`).join('')
        : `<div class="empty">
        <h3>No entries yet</h3>
        <p>This topic has no contributions yet.</p>
      </div>`;

    return layout(topic, `
    <main class="container" style="padding-top:40px;">
      <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">${escapeHtml(topic)}</h1>
      <p style="color:var(--text-muted);font-size:14px;margin-bottom:24px;">
        ${feed.total} entries · <a href="/api/verify?topic=${encodeURIComponent(topic)}">Verify chain integrity ⛓</a>
      </p>
      ${entriesHtml}
    </main>
  `);
}

function aboutPage() {
    const invariants = [
        { title: 'Typed Contributions', desc: 'A question has no evidence burden. A claim requires evidence. A prediction requires resolution criteria.' },
        { title: 'Provenance & History', desc: 'Who contributed it, when, in response to what, and how it has been updated — all recorded and public.' },
        { title: 'Challengeability', desc: 'No contribution and no moderation decision is beyond challenge. The mechanism is structural.' },
        { title: 'Anti-Scale-Dominance', desc: 'No entity can use volume or resources to drown out others.' },
        { title: 'Agents as Delegates', desc: 'AI agents are disclosed tools with bounded budgets, not default peers.' },
        { title: 'Record Integrity', desc: 'What was said is preserved. No entity can silently alter the record after the fact.' },
        { title: 'Explicit Lifecycle', desc: 'Resolution and supersession are visible, auditable, and challengeable.' },
    ];

    return layout('Charter', `
    <main class="container">
      <div class="charter-section">
        <div style="text-align:center;margin-bottom:40px;">
          <h1 style="font-size:32px;font-weight:800;margin-bottom:12px;">Charter</h1>
          <p style="color:var(--text-muted);font-size:16px;">These do not change. They define what Acta is.</p>
        </div>

        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:40px;">
          <h3 style="font-size:14px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px;">Mission</h3>
          <p style="font-size:22px;font-weight:700;">Shared reality for coordination.</p>
        </div>

        <h2>Permanent Invariants</h2>
        ${invariants.map((inv, i) => `
          <div class="invariant">
            <span class="invariant-num">${i + 1}</span>
            <div class="invariant-text"><strong>${inv.title}.</strong> ${inv.desc}</div>
          </div>
        `).join('')}

        <div style="margin-top:40px;padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);">
          <h3 style="font-size:14px;color:var(--text-muted);margin-bottom:12px;">How content is handled</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;font-size:13px;">
            <div>
              <div style="color:var(--accent);font-weight:600;margin-bottom:4px;">Tier 1: Deterministic</div>
              <div style="color:var(--text-muted);">Schema validation, budget checks, spam detection. Code, not judgment.</div>
            </div>
            <div>
              <div style="color:var(--amber);font-weight:600;margin-bottom:4px;">Tier 2: LLM-Assisted</div>
              <div style="color:var(--text-muted);">Classification and tagging. Never makes irreversible epistemic decisions.</div>
            </div>
            <div>
              <div style="color:var(--red);font-weight:600;margin-bottom:4px;">Tier 3: Human Review</div>
              <div style="color:var(--text-muted);">Appeals, hard-reject confirmation, edge cases. Final but challengeable.</div>
            </div>
          </div>
        </div>
      </div>
    </main>
  `);
}

function notFoundPage() {
    return layout('Not Found', `
    <main class="container">
      <div class="empty" style="padding:100px 20px;">
        <h3>404</h3>
        <p>This page doesn't exist. <a href="/">Go home</a></p>
      </div>
    </main>
  `);
}

// ── Helpers ──────────────────────────────────────────────────────────

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(isoDate) {
    if (!isoDate) return 'unknown';
    const seconds = Math.floor((Date.now() - new Date(isoDate)) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
}

// ── Export ───────────────────────────────────────────────────────────

export function renderHTML(page, data = {}) {
    switch (page) {
        case 'home': return homePage(data);
        case 'topic': return topicPage(data);
        case 'about': return aboutPage(data);
        case '404': return notFoundPage();
        default: return notFoundPage();
    }
}

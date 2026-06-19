// OddsEdge frontend: submit a Polymarket link, render the comparison, and keep
// it live over a WebSocket.

const $ = (id) => document.getElementById(id);
const form = $("trackForm");
const urlInput = $("urlInput");
const trackBtn = $("trackBtn");
const errorBox = $("error");
const results = $("results");
const placeholder = $("placeholder");
const connEl = $("conn");

let ws = null;
let currentSlug = null;
let reconnectDelay = 1000;
const prevValues = new Map(); // cellId -> decimal, for change flashing

document.querySelectorAll(".chip").forEach((c) =>
  c.addEventListener("click", () => {
    urlInput.value = c.dataset.url;
    track(c.dataset.url);
  }),
);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  track(urlInput.value.trim());
});

async function track(url) {
  if (!url) return;
  setError("");
  trackBtn.disabled = true;
  trackBtn.textContent = "Loading…";
  try {
    const res = await fetch("/api/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    currentSlug = body.slug;
    prevValues.clear();
    render(body.snapshot);
    connect(body.slug);
  } catch (err) {
    setError(err.message);
  } finally {
    trackBtn.disabled = false;
    trackBtn.textContent = "Compare odds";
  }
}

function connect(slug) {
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/stream?slug=${encodeURIComponent(slug)}`);
  setConn("connecting");
  ws.onopen = () => {
    reconnectDelay = 1000;
    setConn("live");
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "snapshot") render(msg.data);
    else if (msg.type === "error") setError(msg.message);
  };
  ws.onclose = () => {
    setConn("offline");
    if (currentSlug === slug) {
      setTimeout(() => connect(slug), reconnectDelay);
      reconnectDelay = Math.min(15000, reconnectDelay * 2);
    }
  };
}

function setConn(state) {
  connEl.textContent = state;
  connEl.className = "conn " + (state === "live" ? "live" : state === "connecting" ? "connecting" : "");
}

function setError(msg) {
  if (!msg) return errorBox.classList.add("hidden");
  errorBox.textContent = msg;
  errorBox.classList.remove("hidden");
}

// ---------- rendering ----------
const fmt = (n, dp = 2) => (n == null || !isFinite(n) ? "—" : Number(n).toFixed(dp));
const pct = (n) => (n == null ? "" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);

function heatClass(diff) {
  if (diff == null) return "heat0";
  if (diff < 3) return "heat1";
  if (diff < 8) return "heat2";
  if (diff < 15) return "heat3";
  return "heat4";
}

function feedLabel(s) {
  return {
    mock: "sample (mock)",
    "fallback-mock": "live failed → mock",
    live: "live",
    demo: "demo (offline)",
    connecting: "connecting…",
    disconnected: "reconnecting…",
    idle: "—",
    loading: "loading…",
  }[s] || s;
}

function render(snap) {
  placeholder.classList.add("hidden");
  results.classList.remove("hidden");

  const m = snap.match;
  $("matchTitle").textContent = `${m.teams.home} vs ${m.teams.away}`;
  const bits = [];
  if (m.league) bits.push(m.league);
  if (m.startDate) bits.push(formatDate(m.startDate));
  bits.push(`slug: ${m.slug}`);
  $("matchSub").innerHTML = bits.join(" · ") + ` · <a href="${m.polymarketUrl}" target="_blank" rel="noopener">open on Polymarket ↗</a>`;

  $("pmStatus").textContent = feedLabel(snap.status.polymarket);
  $("ntStatus").textContent = feedLabel(snap.status.norsktipping);
  $("pmDot").className = "dot pm " + (/live|demo/.test(snap.status.polymarket) ? "on" : "");
  $("ntDot").className = "dot nt " + (/live|mock/.test(snap.status.norsktipping) ? "on" : "");
  $("updated").textContent = "updated " + new Date(snap.generatedAt).toLocaleTimeString();

  $("summary").innerHTML = `
    ${stat(snap.counts.both, "markets on both books")}
    ${stat(snap.counts.polymarketOnly, "Polymarket only")}
    ${stat(snap.counts.norsktippingOnly, "Norsk Tipping only")}
    ${stat(snap.markets.length, "markets total")}`;

  $("marketCount").textContent = `(${snap.markets.length})`;
  renderHighlights(snap.highlights);
  renderMarkets(snap.markets);
}

const stat = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;

function renderHighlights(highlights) {
  const el = $("highlights");
  if (!highlights.length) {
    el.innerHTML = `<p class="muted">No markets are offered by both books for this match yet.</p>`;
    return;
  }
  el.innerHTML = highlights
    .map((h) => {
      const cls = h.valueSource === "polymarket" ? "pm" : "nt";
      const name = h.valueSource === "polymarket" ? "Polymarket" : "Norsk Tipping";
      return `<div class="hl">
        <div class="diff ${heatClass(h.oddsDiffPct)}">${h.oddsDiffPct.toFixed(1)}%</div>
        <div class="mkt">${escape(h.marketLabel)}</div>
        <div class="sel">${escape(h.selectionLabel)}</div>
        <div class="row"><span class="src pm">Polymarket</span><b>${fmt(h.polymarket)}</b></div>
        <div class="row"><span class="src nt">Norsk Tipping</span><b>${fmt(h.norsktipping)}</b></div>
        <span class="pill value ${cls}">Best on ${name}</span>
      </div>`;
    })
    .join("");
}

function renderMarkets(markets) {
  $("markets").innerHTML = markets.map(renderMarket).join("");
  // Flash any cell whose decimal changed since last render.
  for (const [id, val] of pendingFlash) {
    const cell = document.querySelector(`[data-cell="${id.replace(/(["\\])/g, "\\$1")}"]`);
    if (cell) {
      cell.classList.remove("flash");
      void cell.offsetWidth; // restart animation
      cell.classList.add("flash");
    }
    prevValues.set(id, val);
  }
  pendingFlash.clear();
}

const pendingFlash = new Map();

function renderMarket(m) {
  const tags = [];
  if (m.hasBoth) tags.push(`<span class="tag both">both books</span>`);
  else tags.push(`<span class="tag one">${m.sources[0] === "polymarket" ? "Polymarket only" : "Norsk Tipping only"}</span>`);
  if (m.maxOddsDiffPct != null) tags.push(`<span class="tag maxdiff">max diff ${m.maxOddsDiffPct.toFixed(1)}%</span>`);

  const rows = m.selections.map((s) => renderRow(m, s)).join("");
  return `<div class="market">
    <header>
      <span class="name">${escape(m.label)}</span>
      <span class="tags">${tags.join("")}</span>
    </header>
    <table>
      <thead><tr><th>Selection</th><th>Polymarket</th><th>Norsk Tipping</th><th>Diff</th><th>Value</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderRow(m, s) {
  const pmId = `${m.key}|${s.key}|pm`;
  const ntId = `${m.key}|${s.key}|nt`;
  flagFlash(pmId, s.polymarket?.decimal);
  flagFlash(ntId, s.norsktipping?.decimal);

  const pmCell = oddsCell(s.polymarket, "col-pm", pmId);
  const ntCell = oddsCell(s.norsktipping, "col-nt", ntId);

  let diff = `<td class="diffcell heat0">—</td>`;
  let value = `<td><span class="value flat">—</span></td>`;
  if (s.hasBoth) {
    diff = `<td class="diffcell ${heatClass(s.oddsDiffPct)}">${s.oddsDiffPct.toFixed(1)}%</td>`;
    const cls = s.valueSource === "polymarket" ? "pm" : "nt";
    const name = s.valueSource === "polymarket" ? "Polymarket" : "Norsk Tipping";
    const edge = s.edgePct != null ? ` ${pct(s.edgePct)}` : "";
    value = `<td><span class="value ${cls}">${name}${edge}</span></td>`;
  } else {
    const only = s.polymarket ? "PM only" : s.norsktipping ? "NT only" : "—";
    value = `<td><span class="value flat">${only}</span></td>`;
  }

  return `<tr><td>${escape(s.label)}</td>${pmCell}${ntCell}${diff}${value}</tr>`;
}

function oddsCell(q, cls, cellId) {
  if (!q || q.decimal == null) return `<td class="odds empty" data-cell="${cellId}">—</td>`;
  const prob = q.impliedProb != null ? `<small>${(q.impliedProb * 100).toFixed(1)}%</small>` : "";
  return `<td class="odds ${cls}" data-cell="${cellId}">${fmt(q.decimal)}${prob}</td>`;
}

function flagFlash(id, decimal) {
  if (decimal == null) return;
  const prev = prevValues.get(id);
  if (prev != null && Math.abs(prev - decimal) > 1e-9) pendingFlash.set(id, decimal);
  else prevValues.set(id, decimal);
}

function formatDate(d) {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? d + "T00:00:00" : d);
  if (isNaN(date)) return d;
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: /\d{2}:\d{2}/.test(d) ? "short" : undefined });
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

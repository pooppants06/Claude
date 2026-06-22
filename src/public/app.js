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
    disabled: "off (no API key)",
    "no-match": "no match found",
    connecting: "connecting…",
    disconnected: "reconnecting…",
    idle: "—",
    loading: "loading…",
  }[s] || s;
}

// Source metadata, including the column order.
const SOURCES = {
  polymarket: { name: "Polymarket", col: "Polymarket", cls: "pm" },
  norsktipping: { name: "Norsk Tipping", col: "Norsk Tipping", cls: "nt" },
  oddsapi: { name: "Best book", col: "Best book (Odds API)", cls: "oa" },
};
const SOURCE_ORDER = ["polymarket", "norsktipping", "oddsapi"];
let activeSources = ["polymarket", "norsktipping"];

function render(snap) {
  placeholder.classList.add("hidden");
  results.classList.remove("hidden");

  activeSources = SOURCE_ORDER.filter((s) => (snap.sources || []).includes(s));
  if (!activeSources.length) activeSources = ["polymarket", "norsktipping"];

  const m = snap.match;
  $("matchTitle").textContent = `${m.teams.home} vs ${m.teams.away}`;
  const bits = [];
  if (m.league) bits.push(m.league);
  if (m.startDate) bits.push(formatDate(m.startDate));
  bits.push(`slug: ${m.slug}`);
  $("matchSub").innerHTML = bits.join(" · ") + ` · <a href="${m.polymarketUrl}" target="_blank" rel="noopener">open on Polymarket ↗</a>`;

  // Per-source status line.
  $("feeds").innerHTML = SOURCE_ORDER.map((src) => {
    const st = snap.status[src];
    if (st == null) return "";
    const on = /live|demo|mock/.test(st) ? "on" : "";
    return `<div class="feed"><span class="dot ${SOURCES[src].cls} ${on}"></span> ${SOURCES[src].name}: <b>${feedLabel(st)}</b></div>`;
  }).join("") + `<div class="feed muted">updated ${new Date(snap.generatedAt).toLocaleTimeString()}</div>`;

  const cov = snap.coverage || {};
  $("summary").innerHTML = `
    ${stat(snap.counts.total, "markets total")}
    ${stat(snap.counts.multi, "on 2+ books")}
    ${activeSources.map((s) => stat(cov[s] ?? 0, `${SOURCES[s].name} markets`)).join("")}`;

  $("marketCount").textContent = `(${snap.markets.length})`;
  renderHighlights(snap.highlights);
  renderMarkets(snap.markets);
}

const stat = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;

function renderHighlights(highlights) {
  const el = $("highlights");
  if (!highlights.length) {
    el.innerHTML = `<p class="muted">No markets are offered by 2+ books for this match yet.</p>`;
    return;
  }
  el.innerHTML = highlights
    .map((h) => {
      const best = SOURCES[h.bestSource];
      const rows = activeSources
        .filter((src) => h.prices[src] != null)
        .map((src) => `<div class="row"><span class="src ${SOURCES[src].cls}">${SOURCES[src].name}</span><b>${fmt(h.prices[src])}</b></div>`)
        .join("");
      return `<div class="hl">
        <div class="diff ${heatClass(h.spreadPct)}">${h.spreadPct.toFixed(1)}%</div>
        <div class="mkt">${escape(h.marketLabel)}</div>
        <div class="sel">${escape(h.selectionLabel)}</div>
        ${rows}
        <span class="pill value ${best.cls}">Best on ${best.name}</span>
      </div>`;
    })
    .join("");
}

function renderMarkets(markets) {
  $("markets").innerHTML = markets.map(renderMarket).join("");
  for (const [id, val] of pendingFlash) {
    const cell = document.querySelector(`[data-cell="${id.replace(/(["\\])/g, "\\$1")}"]`);
    if (cell) {
      cell.classList.remove("flash");
      void cell.offsetWidth;
      cell.classList.add("flash");
    }
    prevValues.set(id, val);
  }
  pendingFlash.clear();
}

const pendingFlash = new Map();

function renderMarket(m) {
  const tags = [];
  if (m.sourceCount >= 2) tags.push(`<span class="tag both">${m.sourceCount} books</span>`);
  else tags.push(`<span class="tag one">${SOURCES[m.sources[0]]?.name ?? m.sources[0]} only</span>`);
  if (m.maxSpreadPct != null) tags.push(`<span class="tag maxdiff">max diff ${m.maxSpreadPct.toFixed(1)}%</span>`);

  const heads = activeSources.map((s) => `<th>${SOURCES[s].col}</th>`).join("");
  const rows = m.selections.map((s) => renderRow(m, s)).join("");
  return `<div class="market">
    <header>
      <span class="name">${escape(m.label)}</span>
      <span class="tags">${tags.join("")}</span>
    </header>
    <table>
      <thead><tr><th>Selection</th>${heads}<th>Diff</th><th>Best</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderRow(m, s) {
  const cells = activeSources
    .map((src) => {
      const id = `${m.key}|${s.key}|${src}`;
      flagFlash(id, s.quotes[src]?.decimal);
      return oddsCell(s.quotes[src], SOURCES[src].cls, id, s.bestSource === src && s.sourceCount >= 2);
    })
    .join("");

  let diff = `<td class="diffcell heat0">—</td>`;
  let best = `<td><span class="value flat">${s.sourceCount === 1 ? (SOURCES[Object.keys(s.quotes)[0]]?.name ?? "—") + " only" : "—"}</span></td>`;
  if (s.sourceCount >= 2 && s.spreadPct != null) {
    diff = `<td class="diffcell ${heatClass(s.spreadPct)}">${s.spreadPct.toFixed(1)}%</td>`;
    const b = SOURCES[s.bestSource];
    const edge = s.edgePct != null ? ` ${pct(s.edgePct)}` : "";
    best = `<td><span class="value ${b.cls}">${b.name}${edge}</span></td>`;
  }
  return `<tr><td>${escape(s.label)}</td>${cells}${diff}${best}</tr>`;
}

function oddsCell(q, cls, cellId, isBest) {
  if (!q || q.decimal == null) return `<td class="odds empty" data-cell="${cellId}">—</td>`;
  const prob = q.impliedProb != null ? `<small>${(q.impliedProb * 100).toFixed(1)}%</small>` : "";
  const book = q.meta && q.meta.book ? ` title="${escape(String(q.meta.book))}${q.meta.books ? ` · ${q.meta.books} books` : ""}"` : "";
  return `<td class="odds ${cls}${isBest ? " best" : ""}" data-cell="${cellId}"${book}>${fmt(q.decimal)}${prob}</td>`;
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

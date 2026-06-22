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
  oddsapi: { name: "Odds API", col: "Odds API", cls: "oa" },
};
const SOURCE_ORDER = ["polymarket", "norsktipping", "oddsapi"];
// The Odds API column label depends on how its books are aggregated.
const OA_COL = { average: "Average (Odds API)", median: "Median (Odds API)", best: "Best book (Odds API)" };
let oaAgg = "average";
const colLabel = (src) => (src === "oddsapi" ? OA_COL[oaAgg] || "Odds API" : SOURCES[src].col);
let activeSources = ["polymarket", "norsktipping"];
let lastSnap = null;
let selectedSources = null; // Set of source ids the user is comparing

const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };

function render(snap) {
  lastSnap = snap;
  // Detect how the Odds API column is aggregated (from any of its quotes).
  oaAgg = "average";
  for (const m of snap.markets) {
    const meta = m.selections.find((s) => s.quotes.oddsapi?.meta?.agg)?.quotes.oddsapi?.meta;
    if (meta?.agg) { oaAgg = meta.agg; break; }
  }
  const present = SOURCE_ORDER.filter((s) => (snap.sources || []).includes(s));
  if (!selectedSources) selectedSources = new Set(present);
  // Keep only sources still present; never allow an empty selection.
  selectedSources = new Set([...selectedSources].filter((s) => present.includes(s)));
  if (!selectedSources.size) selectedSources = new Set(present);

  placeholder.classList.add("hidden");
  results.classList.remove("hidden");

  const m = snap.match;
  $("matchTitle").textContent = `${m.teams.home} vs ${m.teams.away}`;
  const bits = [];
  if (m.league) bits.push(m.league);
  if (m.startDate) bits.push(formatDate(m.startDate));
  bits.push(`slug: ${m.slug}`);
  $("matchSub").innerHTML = bits.join(" · ") + ` · <a href="${m.polymarketUrl}" target="_blank" rel="noopener">open on Polymarket ↗</a>`;

  // Per-source status line (always shows every active feed).
  $("feeds").innerHTML = SOURCE_ORDER.map((src) => {
    const st = snap.status[src];
    if (st == null) return "";
    const on = /live|demo|mock/.test(st) ? "on" : "";
    return `<div class="feed"><span class="dot ${SOURCES[src].cls} ${on}"></span> ${SOURCES[src].name}: <b>${feedLabel(st)}</b></div>`;
  }).join("") + `<div class="feed muted">updated ${new Date(snap.generatedAt).toLocaleTimeString()}</div>`;

  renderToggle(snap);
  renderView();
}

/** Source selector: toggle chips per book + quick presets. */
function renderToggle(snap) {
  const present = SOURCE_ORDER.filter((s) => (snap.sources || []).includes(s));
  const el = $("sourceToggle");
  if (present.length < 2) { el.innerHTML = ""; return; }
  const chips = present.map((s) => {
    const on = selectedSources.has(s);
    return `<button class="src-chip ${SOURCES[s].cls} ${on ? "on" : "off"}" data-src="${s}"><span class="dot ${SOURCES[s].cls} ${on ? "on" : ""}"></span>${SOURCES[s].name}</button>`;
  }).join("");
  const presets = present.includes("oddsapi")
    ? `<button class="preset" data-preset="pmnt">Polymarket vs Norsk Tipping</button><button class="preset" data-preset="all">All books</button>`
    : "";
  el.innerHTML = `<span class="lbl">Compare:</span><span class="seg">${chips}</span>${presets}`;

  el.querySelectorAll(".src-chip").forEach((b) => b.onclick = () => {
    const s = b.dataset.src;
    if (selectedSources.has(s)) { if (selectedSources.size > 1) selectedSources.delete(s); }
    else selectedSources.add(s);
    renderToggle(snap); renderView();
  });
  el.querySelectorAll(".preset").forEach((b) => b.onclick = () => {
    selectedSources = b.dataset.preset === "pmnt"
      ? new Set(present.filter((s) => s === "polymarket" || s === "norsktipping"))
      : new Set(present);
    renderToggle(snap); renderView();
  });
}

function renderView() {
  if (!lastSnap) return;
  const view = deriveView(lastSnap, selectedSources);
  activeSources = view.cols.length ? view.cols : SOURCE_ORDER.filter((s) => lastSnap.sources.includes(s));

  $("summary").innerHTML = `
    ${stat(view.counts.total, "markets total")}
    ${stat(view.counts.multi, "on 2+ books")}
    ${activeSources.map((s) => stat(view.coverage[s] ?? 0, `${SOURCES[s].name} markets`)).join("")}`;
  $("marketCount").textContent = `(${view.markets.length})`;
  renderHighlights(view.highlights);
  renderMarkets(view.markets);
}

/** Recompute the comparison considering only the selected sources. */
function deriveView(snap, selSet) {
  const cols = SOURCE_ORDER.filter((s) => snap.sources.includes(s) && selSet.has(s));
  const markets = [];
  for (const m of snap.markets) {
    const selections = m.selections.map((s) => recomputeSel(s, m, cols)).filter((s) => s.sourceCount >= 1);
    if (!selections.length) continue;
    const present = cols.filter((c) => m.selections.some((s) => s.quotes[c]));
    const multi = selections.filter((s) => s.sourceCount >= 2);
    markets.push({
      ...m, selections,
      sources: present, sourceCount: present.length,
      maxSpreadPct: multi.length ? Math.max(...multi.map((s) => s.spreadPct ?? 0)) : null,
    });
  }
  markets.sort((a, b) => {
    if (a.sourceCount !== b.sourceCount) return b.sourceCount - a.sourceCount;
    return (b.maxSpreadPct ?? -1) - (a.maxSpreadPct ?? -1);
  });

  const highlights = [];
  for (const m of markets) {
    if (!m.complete) continue;
    for (const s of m.selections) {
      if (s.sourceCount >= 2 && s.spreadPct != null) {
        const prices = {};
        for (const c of cols) prices[c] = s.quotes[c]?.decimal ?? null;
        highlights.push({ marketLabel: m.label, marketKey: m.key, selectionLabel: s.label, prices, spreadPct: s.spreadPct, bestSource: s.bestSource });
      }
    }
  }
  highlights.sort((a, b) => b.spreadPct - a.spreadPct);

  const coverage = {};
  for (const c of cols) coverage[c] = markets.filter((m) => m.sources.includes(c)).length;
  return {
    cols, markets,
    highlights: highlights.slice(0, 8),
    coverage,
    counts: { total: markets.length, multi: markets.filter((m) => m.sourceCount >= 2).length },
  };
}

function recomputeSel(s, m, cols) {
  const quotes = {};
  const decimals = [];
  for (const c of cols) {
    const q = s.quotes[c];
    if (q) { quotes[c] = q; if (q.decimal > 1) decimals.push({ source: c, decimal: q.decimal }); }
  }
  let bestSource = null, bestDecimal = null, spreadPct = null, fairProb = null, edgePct = null;
  if (decimals.length) {
    const best = decimals.reduce((a, b) => (b.decimal > a.decimal ? b : a));
    const worst = decimals.reduce((a, b) => (b.decimal < a.decimal ? b : a));
    bestSource = best.source; bestDecimal = best.decimal;
    if (decimals.length >= 2) spreadPct = round(((best.decimal - worst.decimal) / worst.decimal) * 100, 2);
    if (m.complete) {
      const parts = [];
      for (const c of cols) {
        let sum = 0;
        for (const sib of m.selections) { const p = sib.quotes[c]?.impliedProb; if (p != null) sum += p; }
        const p = s.quotes[c]?.impliedProb;
        if (p != null && sum > 0) parts.push(p / sum);
      }
      if (parts.length) { fairProb = parts.reduce((a, b) => a + b, 0) / parts.length; edgePct = round((fairProb * best.decimal - 1) * 100, 2); }
    }
  }
  return { ...s, quotes, sourceCount: decimals.length, bestSource, bestDecimal, spreadPct, fairProb, edgePct };
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

  const heads = activeSources.map((s) => `<th>${colLabel(s)}</th>`).join("");
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
  let tip = "";
  if (q.meta && q.meta.agg) {
    const label = { average: "average", median: "median", best: q.meta.book ? `best (${q.meta.book})` : "best" }[q.meta.agg] || q.meta.agg;
    tip = ` title="${escape(label)} of ${q.meta.books || 0} bookmakers"`;
  }
  return `<td class="odds ${cls}${isBest ? " best" : ""}" data-cell="${cellId}"${tip}>${fmt(q.decimal)}${prob}</td>`;
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

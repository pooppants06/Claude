import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fetchPolymarketEvent } from "./src/sources/polymarket/gamma.js";
import { fetchNorskTippingOddsen } from "./src/sources/norsktipping/oddsen.js";
import { compareMarkets } from "./src/compare/compare.js";
import { teamKey } from "./src/normalize/teams.js";
import { aggregateMarket, type Aggregated } from "./src/normalize/devig.js";
import {
  fitGoalModel, firstHalfModel, matrixWinProbs, matrixOver, matrixBtts, type ScoreModel,
} from "./src/model/poisson.js";

const EXTRA: Record<string, string> = { ivorycoast: "cotedivoire", czechrepublic: "czechia", turkey: "turkiye", capeverde: "caboverde" };
const norm = (s: string) => { const k = teamKey(s); return EXTRA[k] ?? k; };
const pairKey = (a: string, b: string) => [norm(a), norm(b)].sort().join("|");
const SEL: Record<string, string[]> = { MATCH_WINNER: ["HOME", "DRAW", "AWAY"], TOTAL_GOALS: ["OVER", "UNDER"], BTTS: ["YES", "NO"] };
const baseType = (canon: string) => canon.split("#")[0]!.split("@")[0]!;
const selKeysFor = (canon: string) => SEL[baseType(canon)] ?? [];
const K_BLEND = 3; // coverage-shrinkage constant: w = effN/(effN+K)

// Collect each book's decimal odds per canonical market key (deduped per book).
function collect(books: any[], home: string, away: string) {
  const nH = norm(home), nA = norm(away);
  const side = (name: string) => { const k = norm(name); return k === nH ? "HOME" : k === nA ? "AWAY" : null; };
  const perBook: Record<string, { key: string; odds: Record<string, number> }[]> = {};
  const push = (canon: string, bk: string, odds: Record<string, number>) => {
    (perBook[canon] ??= []);
    if (perBook[canon]!.some((r) => r.key === bk)) return; // book already quoted this line
    perBook[canon]!.push({ key: bk, odds });
  };
  for (const b of books || []) {
    const bk = b.key || "?";
    for (const m of b.markets || []) {
      const oc = m.outcomes || [];
      if (m.key === "h2h" || m.key === "h2h_h1") {
        const per = m.key === "h2h_h1" ? "#1H" : "";
        const h = oc.find((o: any) => side(o.name) === "HOME"), a = oc.find((o: any) => side(o.name) === "AWAY"), d = oc.find((o: any) => o.name === "Draw");
        if (h?.price > 1 && a?.price > 1 && d?.price > 1) push("MATCH_WINNER" + per, bk, { HOME: h.price, DRAW: d.price, AWAY: a.price });
      } else if (m.key === "totals" || m.key === "alternate_totals" || m.key === "totals_h1") {
        const per = m.key === "totals_h1" ? "#1H" : "";
        const byLine: Record<string, any> = {};
        for (const o of oc) (byLine[o.point] ??= {})[String(o.name).toLowerCase()] = o.price;
        for (const [pt, ou] of Object.entries(byLine) as any)
          if (ou.over > 1 && ou.under > 1) push(`TOTAL_GOALS@${Number(pt)}` + per, bk, { OVER: ou.over, UNDER: ou.under });
      } else if (m.key === "btts") {
        const y = oc.find((o: any) => /yes/i.test(o.name)), n = oc.find((o: any) => /^no$/i.test(o.name));
        if (y?.price > 1 && n?.price > 1) push("BTTS", bk, { YES: y.price, NO: n.price });
      }
    }
  }
  return perBook;
}

interface EventModel { agg: Record<string, Aggregated>; full: ScoreModel; half: ScoreModel; home: string; away: string; }

function buildEventModel(books: any[], home: string, away: string): EventModel {
  const perBook = collect(books, home, away);
  const agg: Record<string, Aggregated> = {};
  for (const [canon, rows] of Object.entries(perBook)) {
    const a = aggregateMarket(rows, selKeysFor(canon));
    if (a) agg[canon] = a;
  }
  // Fit the goal model to the deep markets: full-match 1X2 + every full totals line.
  const targets: { key: string; prob: number; weight: number }[] = [];
  const mw = agg["MATCH_WINNER"];
  if (mw) {
    targets.push({ key: "H", prob: mw.probs.HOME!, weight: mw.effN });
    targets.push({ key: "D", prob: mw.probs.DRAW!, weight: mw.effN });
    targets.push({ key: "A", prob: mw.probs.AWAY!, weight: mw.effN });
  }
  for (const [canon, a] of Object.entries(agg)) {
    if (canon.startsWith("TOTAL_GOALS@") && !canon.includes("#")) {
      const line = Number(canon.slice("TOTAL_GOALS@".length));
      targets.push({ key: `O:${line}`, prob: a.probs.OVER!, weight: a.effN });
    }
  }
  const full = targets.length ? fitGoalModel(targets) : fitGoalModel([{ key: "O:2.5", prob: 0.5, weight: 1 }]);
  return { agg, full, half: firstHalfModel(full), home, away };
}

// Best-estimate probability for a canonical selection: blend market consensus
// (where covered) with the coherent goal model, shrinking thin coverage toward
// the model. Markets with no OA coverage still get a model-only estimate.
function fairFor(em: EventModel, canon: string, selKey: string) {
  const [base, per] = canon.split("#"); const isH = per === "1H";
  // We only have a first-half model (OA carries h2h_h1 / totals_h1). Second-half
  // markets have no independent data to anchor — refuse rather than extrapolate.
  if (per === "2H") return null;
  const wp = isH ? matrixWinProbs(em.half.M) : matrixWinProbs(em.full.M);
  const M = isH ? em.half.M : em.full.M;
  let model: number | null = null;
  if (base!.startsWith("MATCH_WINNER")) model = selKey === "HOME" ? wp.home : selKey === "DRAW" ? wp.draw : selKey === "AWAY" ? wp.away : null;
  else if (base!.startsWith("TOTAL_GOALS@")) { const L = Number(base!.slice("TOTAL_GOALS@".length)); const ov = matrixOver(M, L); model = selKey === "OVER" ? ov : selKey === "UNDER" ? 1 - ov : null; }
  else if (base === "BTTS") { const y = matrixBtts(M); model = selKey === "YES" ? y : selKey === "NO" ? 1 - y : null; }
  if (model == null) return null;
  const a = em.agg[canon];
  if (a && a.probs[selKey] != null) {
    const w = a.effN / (a.effN + K_BLEND);
    return { fair: w * a.probs[selKey]! + (1 - w) * model, model, cons: a.probs[selKey]!, effN: a.effN, disp: a.dispersion[selKey]!, nBooks: a.nBooks, w };
  }
  return { fair: model, model, cons: null as number | null, effN: 0, disp: null as number | null, nBooks: 0, w: 0 };
}

async function getJson(u: string) { try { const r = await fetch(u, { headers: { accept: "application/json" } }); if (!r.ok) return null; const t = await r.text(); return t.length > 2 ? JSON.parse(t) : null; } catch { return null; } }
async function wcSlugs() {
  let all: any[] = [];
  for (const off of [0, 500]) { const b = await getJson(`https://gamma-api.polymarket.com/events?tag_id=102232&closed=false&limit=500&offset=${off}`); if (!b || !b.length) break; all = all.concat(b); if (b.length < 500) break; }
  const re = /^fifwc-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2}$/; const seen = new Set<string>();
  return all.filter((e) => re.test(e.slug || "") && !seen.has(e.slug) && seen.add(e.slug)).map((e) => e.slug);
}
function buildIndex() {
  const bulk = JSON.parse(readFileSync("/tmp/oa_bulk.json", "utf8"));
  const byPair: Record<string, EventModel> = {};
  for (const e of bulk) {
    let books = [...(e.bookmakers || [])];
    if (existsSync(`/tmp/oa_ev/${e.id}.json`)) books = books.concat(JSON.parse(readFileSync(`/tmp/oa_ev/${e.id}.json`, "utf8")).bookmakers || []);
    byPair[pairKey(e.home_team, e.away_team)] = buildEventModel(books, e.home_team, e.away_team);
  }
  return byPair;
}

async function one(slug: string, idx: Record<string, EventModel>) {
  let ev: any; try { ev = await fetchPolymarketEvent(`https://polymarket.com/sports/world-cup/${slug}`); } catch { return []; }
  let nt: any = []; try { nt = await fetchNorskTippingOddsen(ev.meta); } catch { nt = []; }
  const snap = compareMarkets(ev.meta, [{ source: "polymarket", markets: ev.markets, status: "live" }, { source: "norsktipping", markets: nt, status: "live" }], { polymarket: "live", norsktipping: "live" });
  const em = idx[pairKey(ev.meta.teams.home, ev.meta.teams.away)];
  if (!em) return [];
  const oaH = norm(em.home), oaA = norm(em.away);
  // Match-winner: join by team identity (books disagree on home/away order).
  const oaKey = (mKey: string, s: any): string | null => {
    if (mKey.startsWith("MATCH_WINNER")) { if (s.key === "DRAW") return "DRAW"; const k = norm(s.label); return k === oaH ? "HOME" : k === oaA ? "AWAY" : null; }
    return s.key;
  };
  const out: any[] = [];
  for (const m of snap.markets) {
    if (!(baseType(m.key) in SEL)) continue; // only model-derivable markets
    const ntByKey: Record<string, number> = {};
    m.selections.forEach((s: any) => { const d = s.quotes.norsktipping?.decimal; if (d > 1) ntByKey[s.key] = d; });
    for (const s of m.selections) {
      const pm = s.quotes.polymarket?.decimal ?? null; if (!(pm && pm > 1)) continue;
      const sel = oaKey(m.key, s); if (!sel) continue;
      const f = fairFor(em, m.key, sel); if (!f) continue;
      if (f.fair < 0.02 || f.fair > 0.985) continue;
      const pmProb = 1 / pm;
      const ev_ = f.fair / pmProb - 1; // EV per unit staked if fair is the truth
      out.push({
        title: ev.meta.title, marketLabel: m.label, selectionLabel: s.label,
        pmOdds: pm, pmSpread: s.quotes.polymarket?.meta?.spread ?? null,
        ntOdds: ntByKey[s.key] ?? null,
        consOdds: f.cons ? 1 / f.cons : null, modelOdds: 1 / f.model, fairOdds: 1 / f.fair,
        fairProb: f.fair, effN: f.effN, nBooks: f.nBooks, disp: f.disp, wBlend: f.w, ev: ev_,
      });
    }
  }
  return out;
}

async function pool(items: string[], n: number, fn: any) { const out: any[] = []; let i = 0; async function w() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } } await Promise.all(Array.from({ length: n }, () => w())); return out; }

async function run() {
  const idx = buildIndex();
  const slugs = await wcSlugs();
  const scored = (await pool(slugs, 4, (s: string) => one(s, idx))).flat();
  // Only rank markets with genuine independent coverage — a fair value needs
  // data, not just a model extrapolation. effN ≥ 2 keeps everything the Odds API
  // actually prices (h2h, totals, 1H h2h/totals, BTTS) and drops the markets it
  // doesn't (2H, 1H BTTS), where any "edge" would be invented.
  const all = scored.filter((r: any) => r.effN >= 2);
  // Best value bets to BACK on Polymarket = highest positive EV under our fair estimate.
  all.sort((a: any, b: any) => b.ev - a.ev);
  const top = all.slice(0, 40);
  writeFileSync("/tmp/multi/accurate.json", JSON.stringify({ at: Date.now(), top, total: all.length }, null, 2));
  console.log(`scored outcomes: ${all.length}`);
  console.log("TOP 20 value bets (PM cheaper than best-estimate fair):");
  top.slice(0, 20).forEach((r: any, i: number) =>
    console.log(`${String(i + 1).padStart(2)}. EV ${(r.ev * 100).toFixed(1).padStart(5)}%  ${r.title.slice(0, 20).padEnd(20)} ${(r.marketLabel + "/" + r.selectionLabel).slice(0, 38).padEnd(38)} PM ${r.pmOdds.toFixed(2).padStart(6)} fair ${r.fairOdds.toFixed(2).padStart(6)} model ${r.modelOdds.toFixed(2).padStart(6)} cons ${r.consOdds ? r.consOdds.toFixed(2) : "  -- "} effN ${r.effN.toFixed(1)}`));
}
run().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

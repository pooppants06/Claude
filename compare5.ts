import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fetchPolymarketEvent } from "./src/sources/polymarket/gamma.js";
import { fetchNorskTippingOddsen } from "./src/sources/norsktipping/oddsen.js";
import { compareMarkets } from "./src/compare/compare.js";
import { shinProbabilities } from "./src/normalize/shin.js";
import { teamKey } from "./src/normalize/teams.js";

const EXTRA: Record<string, string> = { ivorycoast: "cotedivoire", czechrepublic: "czechia", turkey: "turkiye", capeverde: "caboverde" };
const norm = (s: string) => { const k = teamKey(s); return EXTRA[k] ?? k; };
const pairKey = (a: string, b: string) => [norm(a), norm(b)].sort().join("|");
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;

// OA-Shin per canonical market = AVERAGE decimal odds across all books, then Shin.
function buildEventOA(books: any[], home: string, away: string) {
  const nH = norm(home), nA = norm(away);
  const side = (name: string) => { const k = norm(name); return k === nH ? "HOME" : k === nA ? "AWAY" : null; };
  const acc: Record<string, Record<string, number[]>> = {};
  const add = (key: string, sel: string, p: number) => { ((acc[key] ??= {})[sel] ??= []).push(p); };
  for (const b of books || []) for (const m of b.markets || []) {
    const oc = m.outcomes || [];
    if (m.key === "h2h" || m.key === "h2h_h1") {
      const per = m.key === "h2h_h1" ? "#1H" : "";
      const h = oc.find((o: any) => side(o.name) === "HOME"), a = oc.find((o: any) => side(o.name) === "AWAY"), d = oc.find((o: any) => o.name === "Draw");
      if (h?.price > 1 && a?.price > 1 && d?.price > 1) { add("MATCH_WINNER" + per, "HOME", h.price); add("MATCH_WINNER" + per, "DRAW", d.price); add("MATCH_WINNER" + per, "AWAY", a.price); }
    } else if (m.key === "totals" || m.key === "alternate_totals" || m.key === "totals_h1") {
      const per = m.key === "totals_h1" ? "#1H" : "";
      const byLine: Record<string, any> = {};
      for (const o of oc) (byLine[o.point] ??= {})[String(o.name).toLowerCase()] = o.price;
      for (const [pt, ou] of Object.entries(byLine) as any) if (ou.over > 1 && ou.under > 1) { const k = `TOTAL_GOALS@${Number(pt)}` + per; add(k, "OVER", ou.over); add(k, "UNDER", ou.under); }
    } else if (m.key === "btts") {
      const y = oc.find((o: any) => /yes/i.test(o.name)), n = oc.find((o: any) => /^no$/i.test(o.name));
      if (y?.price > 1 && n?.price > 1) { add("BTTS", "YES", y.price); add("BTTS", "NO", n.price); }
    }
  }
  const out: Record<string, Record<string, { shinOdds: number; n: number }>> = {};
  for (const [key, sels] of Object.entries(acc)) {
    const sk = Object.keys(sels); if (sk.length < 2) continue;
    const decs = sk.map((k) => mean(sels[k]!)); const shin = shinProbabilities(decs);
    const n = Math.min(...sk.map((k) => sels[k]!.length));
    out[key] = {}; sk.forEach((k, i) => (out[key]![k] = { shinOdds: 1 / shin[i]!, n }));
  }
  return out;
}

function loadOA() {
  const bulk = JSON.parse(readFileSync("/tmp/oa5_bulk.json", "utf8"));
  const byPair: Record<string, any> = {};
  for (const e of bulk) {
    let books = [...(e.bookmakers || [])];
    if (existsSync(`/tmp/oa5_ev/${e.id}.json`)) books = books.concat(JSON.parse(readFileSync(`/tmp/oa5_ev/${e.id}.json`, "utf8")).bookmakers || []);
    byPair[pairKey(e.home_team, e.away_team)] = { home: e.home_team, away: e.away_team, oa: buildEventOA(books, e.home_team, e.away_team) };
  }
  return byPair;
}

// Display order + which markets to include.
const ORDER: Record<string, number> = { MATCH_WINNER: 0, DOUBLE_CHANCE: 1, BTTS: 3 };
function sortKey(m: any): number {
  const base = m.type as string;
  if (base === "TOTAL_GOALS") return 2 + (m.line ?? 0) / 100;
  return ORDER[base] ?? 9;
}
const INCLUDE = new Set(["MATCH_WINNER", "DOUBLE_CHANCE", "TOTAL_GOALS", "BTTS"]);

async function one(slug: string, oaIdx: Record<string, any>) {
  const ev: any = await fetchPolymarketEvent(`https://polymarket.com/sports/world-cup/${slug}`);
  let nt: any = []; try { nt = await fetchNorskTippingOddsen(ev.meta); } catch { nt = []; }
  const snap = compareMarkets(ev.meta, [{ source: "polymarket", markets: ev.markets, status: "live" }, { source: "norsktipping", markets: nt, status: "live" }], { polymarket: "live", norsktipping: "live" });
  const oaEv = oaIdx[pairKey(ev.meta.teams.home, ev.meta.teams.away)];
  const oaH = oaEv ? norm(oaEv.home) : "", oaA = oaEv ? norm(oaEv.away) : "";
  const oaKey = (mKey: string, s: any): string | null => {
    if (mKey.startsWith("MATCH_WINNER")) { if (s.key === "DRAW") return "DRAW"; const k = norm(s.label); return k === oaH ? "HOME" : k === oaA ? "AWAY" : null; }
    return s.key;
  };

  const markets = snap.markets
    .filter((m: any) => INCLUDE.has(m.type) && m.period == null) // full-match only for the regular view
    .filter((m: any) => m.selections.some((s: any) => s.quotes.polymarket?.decimal > 1))
    .sort((a: any, b: any) => sortKey(a) - sortKey(b));

  const rows: any[] = [];
  for (const m of markets) {
    // NT-Shin needs NT to cover the whole market.
    const ntDec = m.selections.map((s: any) => s.quotes.norsktipping?.decimal ?? null);
    const ntFull = ntDec.every((d: any) => d && d > 1);
    const ntShin = ntFull ? shinProbabilities(ntDec as number[]) : null;
    const oaM = oaEv?.oa[m.key];
    m.selections.forEach((s: any, i: number) => {
      const pm = s.quotes.polymarket?.decimal ?? null; if (!(pm && pm > 1)) return;
      const oaCell = oaM ? oaM[oaKey(m.key, s) ?? ""] : null;
      rows.push({
        market: m.label, selection: s.label,
        pm, pmSpread: s.quotes.polymarket?.meta?.spread ?? null,
        oaShin: oaCell ? oaCell.shinOdds : null, oaBooks: oaCell ? oaCell.n : null,
        nt: ntDec[i] && ntDec[i] > 1 ? ntDec[i] : null,
        ntShin: ntShin ? 1 / ntShin[i]! : null,
        firstInMarket: false,
      });
    });
    if (rows.length) {
      // mark the first row of each market for grouping lines
      const start = rows.length - m.selections.filter((s: any) => s.quotes.polymarket?.decimal > 1).length;
      if (rows[start]) rows[start].firstInMarket = true;
    }
  }
  return { title: ev.meta.title, slug, date: slug.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? "", rows };
}

async function run() {
  const oaIdx = loadOA();
  const slugs = ["fifwc-cze-mex-2026-06-24", "fifwc-jpn-swe-2026-06-25", "fifwc-tur-usa-2026-06-25", "fifwc-par-aus-2026-06-25", "fifwc-ury-esp-2026-06-26"];
  const out: any[] = [];
  for (const s of slugs) { try { out.push(await one(s, oaIdx)); } catch (e) { console.log("FAIL", s, (e as Error).message); } }
  writeFileSync("/tmp/multi/compare5.json", JSON.stringify({ at: Date.now(), matches: out }, null, 2));
  for (const m of out) console.log(`${m.title} (${m.date}) — ${m.rows.length} rows`);
}
run().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

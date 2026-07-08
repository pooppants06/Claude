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

// Loose team match: equal, or one normalized name contains the other. Handles
// club prefixes/suffixes that differ across sources (SK/FC Iberia, Egnatia vs
// Egnatia Rrogozhinë, Craiova vs Craiova CS) without a per-club alias each.
const tmatch = (a: string, b: string) =>
  !!a && !!b && (a === b || (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))));

function loadOA(): any[] {
  const bulk = JSON.parse(readFileSync("/tmp/oa5_bulk.json", "utf8"));
  return bulk.map((e: any) => {
    let books = [...(e.bookmakers || [])];
    if (existsSync(`/tmp/oa5_ev/${e.id}.json`)) books = books.concat(JSON.parse(readFileSync(`/tmp/oa5_ev/${e.id}.json`, "utf8")).bookmakers || []);
    return { home: e.home_team, away: e.away_team, hk: norm(e.home_team), ak: norm(e.away_team), oa: buildEventOA(books, e.home_team, e.away_team) };
  });
}
function findOA(oaList: any[], home: string, away: string) {
  const ph = norm(home), pa = norm(away);
  return oaList.find((o) => (tmatch(o.hk, ph) && tmatch(o.ak, pa)) || (tmatch(o.hk, pa) && tmatch(o.ak, ph)));
}

// Display order + which markets to include.
const ORDER: Record<string, number> = { MATCH_WINNER: 0, DOUBLE_CHANCE: 1, BTTS: 3 };
function sortKey(m: any): number {
  const base = m.type as string;
  if (base === "TOTAL_GOALS") return 2 + (m.line ?? 0) / 100;
  return ORDER[base] ?? 9;
}
const INCLUDE = new Set(["MATCH_WINNER", "DOUBLE_CHANCE", "TOTAL_GOALS", "BTTS"]);

async function one(slug: string, oaList: any[]) {
  const ev: any = await fetchPolymarketEvent(`https://polymarket.com/sports/world-cup/${slug}`);
  let nt: any = []; try { nt = await fetchNorskTippingOddsen(ev.meta); } catch { nt = []; }
  const snap = compareMarkets(ev.meta, [{ source: "polymarket", markets: ev.markets, status: "live" }, { source: "norsktipping", markets: nt, status: "live" }], { polymarket: "live", norsktipping: "live" });
  const oaEv = findOA(oaList, ev.meta.teams.home, ev.meta.teams.away);
  const oaH = oaEv ? norm(oaEv.home) : "", oaA = oaEv ? norm(oaEv.away) : "";
  const oaKey = (mKey: string, s: any): string | null => {
    if (mKey.startsWith("MATCH_WINNER")) { if (s.key === "DRAW") return "DRAW"; const k = norm(s.label); return tmatch(k, oaH) ? "HOME" : tmatch(k, oaA) ? "AWAY" : null; }
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
        pmTokenId: s.quotes.polymarket?.meta?.tokenId ?? null,
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
  // Executable Polymarket prices per selection from the live CLOB book:
  //   ask = what you pay buying at market NOW; bid = the highest resting limit
  //   (join it and you're first in queue if it fills). Mid overstates both.
  const priced = rows.filter((r) => r.pmTokenId);
  await Promise.all(priced.map(async (r) => {
    const px = async (side: string) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await fetch(`https://clob.polymarket.com/price?token_id=${r.pmTokenId}&side=${side}`);
          if (resp.ok) {
            const v = Number((await resp.json())?.price);
            return v > 0 && v < 1 ? v : null;
          }
        } catch { /* transient proxy failure — retry */ }
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      }
      return null;
    };
    // CLOB /price semantics: side=buy → best resting BUY order (bid);
    // side=sell → best resting SELL order (ask). So taking the market pays
    // the side=sell price, and posting a limit joins the side=buy price.
    const [bid, ask] = await Promise.all([px("buy"), px("sell")]);
    r.pmAskOdds = ask ? 1 / ask : null; // buy at market (take the ask)
    r.pmBidOdds = bid ? 1 / bid : null; // buy at highest resting limit (join the bid)
  }));
  return { title: ev.meta.title, slug, date: slug.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? "", rows };
}

async function run() {
  const oaIdx = loadOA();
  const slate = JSON.parse(readFileSync("/tmp/multi/slate.json", "utf8"));
  const slugs: string[] = slate.map((s: any) => s.slug);
  // Process matches with bounded concurrency (PM merges ~6 sibling events each).
  const results: any[] = [];
  let i = 0;
  async function worker() {
    while (i < slugs.length) {
      const idx = i++;
      try { results[idx] = await one(slugs[idx]!, oaIdx); }
      catch (e) { console.log("FAIL", slugs[idx], (e as Error).message); results[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: 5 }, () => worker()));
  const out = results.filter(Boolean);
  writeFileSync("/tmp/multi/compare5.json", JSON.stringify({ at: Date.now(), matches: out }, null, 2));
  for (const m of out) console.log(`${m.title} (${m.date}) — ${m.rows.length} rows`);
}
run().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

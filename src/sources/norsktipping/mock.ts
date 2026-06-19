/**
 * Realistic Norsk Tipping odds generator.
 *
 * Norsk Tipping has no public odds API, so out of the box we synthesise a full
 * Oddsen-style book for the match: 1X2, Double Chance, DNB, BTTS, Totals,
 * First-half goals, HT result, Odd/Even, Correct Score, HT/FT and Anytime
 * Goalscorer. All markets are derived from ONE Monte-Carlo simulation of the
 * match, so they are mutually consistent (the way a real book is), include a
 * bookmaker margin, and drift a little on every poll to emulate live odds.
 *
 * Swap this for real data by setting NORSKTIPPING_PROVIDER=http (see orako.ts).
 */

import type { Market, MatchMeta, TeamInfo } from "../../types.js";
import { emptyMarket, makeQuote, round, upsertQuote } from "../../normalize/markets.js";

// ---------- small deterministic RNG so each match has a stable identity ----------
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poissonSample(lambda: number, rnd: () => number): number {
  // Knuth's algorithm; fine for the small lambdas we use.
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rnd();
  } while (p > L);
  return k - 1;
}

const SURNAMES = [
  "Berg", "Haaland", "Silva", "Santos", "Rossi", "Müller", "Dubois", "Kovač",
  "Nakamura", "Okafor", "Hassan", "Andersson", "García", "Costa", "Mbappé", "Sørensen",
];

function pickPlayers(team: string, code: string | undefined, seed: number): string[] {
  const rng = mulberry32(seed);
  const used = new Set<number>();
  const names: string[] = [];
  const tag = (code ?? team.slice(0, 3)).toUpperCase();
  while (names.length < 3) {
    const idx = Math.floor(rng() * SURNAMES.length);
    if (used.has(idx)) continue;
    used.add(idx);
    names.push(`${SURNAMES[idx]} (${tag})`);
  }
  return names;
}

/** Convert true probabilities to decimal odds with a bookmaker margin. */
function withMargin(prob: number, overround: number): number {
  const implied = Math.min(0.985, prob * overround);
  if (implied <= 0) return 1.01;
  return round(Math.max(1.01, 1 / implied), 2);
}

interface SimResult {
  ftHome: number; ftDraw: number; ftAway: number;
  htHome: number; htDraw: number; htAway: number;
  over: Record<string, number>; under: Record<string, number>;
  fhOver: Record<string, number>; fhUnder: Record<string, number>;
  bttsYes: number; bttsNo: number;
  odd: number; even: number;
  scores: Map<string, number>;
  htft: Map<string, number>;
  homeScorers: Map<string, number>; awayScorers: Map<string, number>; noScorer: number;
  dcHX: number; dcHA: number; dcXA: number;
  dnbHome: number; dnbAway: number;
}

const TOTAL_LINES = [1.5, 2.5, 3.5];
const FH_LINES = [0.5, 1.5];

function simulate(meta: MatchMeta): SimResult {
  const { teams } = meta;
  const seed = hashString(`${teams.home}|${teams.away}`);
  const base = mulberry32(seed);

  // Seeded attacking strengths -> per-side expected goals (with home advantage).
  const homeRating = 0.9 + base() * 0.9;
  const awayRating = 0.9 + base() * 0.9;
  let lamHome = Math.min(3.2, Math.max(0.45, 1.45 * (homeRating / awayRating)));
  let lamAway = Math.min(3.0, Math.max(0.35, 1.15 * (awayRating / homeRating)));
  // Live drift: small, fresh randomness each poll so odds wiggle realistically.
  lamHome *= 1 + (Math.random() - 0.5) * 0.05;
  lamAway *= 1 + (Math.random() - 0.5) * 0.05;

  const players = {
    home: pickPlayers(teams.home, teams.homeCode, seed ^ 0x1111),
    away: pickPlayers(teams.away, teams.awayCode, seed ^ 0x2222),
  };

  const N = 12000;
  const r = Math.random; // sampling noise = live movement
  const res: SimResult = {
    ftHome: 0, ftDraw: 0, ftAway: 0, htHome: 0, htDraw: 0, htAway: 0,
    over: {}, under: {}, fhOver: {}, fhUnder: {},
    bttsYes: 0, bttsNo: 0, odd: 0, even: 0,
    scores: new Map(), htft: new Map(),
    homeScorers: new Map(), awayScorers: new Map(), noScorer: 0,
    dcHX: 0, dcHA: 0, dcXA: 0, dnbHome: 0, dnbAway: 0,
  };
  for (const l of TOTAL_LINES) { res.over[l] = 0; res.under[l] = 0; }
  for (const l of FH_LINES) { res.fhOver[l] = 0; res.fhUnder[l] = 0; }

  const code = (side: "H" | "D" | "A") => (side === "H" ? "1" : side === "D" ? "X" : "2");
  const result = (h: number, a: number): "H" | "D" | "A" => (h > a ? "H" : h < a ? "A" : "D");

  for (let s = 0; s < N; s++) {
    const h1 = poissonSample(lamHome * 0.45, r);
    const a1 = poissonSample(lamAway * 0.45, r);
    const h2 = poissonSample(lamHome * 0.55, r);
    const a2 = poissonSample(lamAway * 0.55, r);
    const home = h1 + h2;
    const away = a1 + a2;
    const total = home + away;

    const ft = result(home, away);
    const ht = result(h1, a1);
    if (ft === "H") res.ftHome++; else if (ft === "D") res.ftDraw++; else res.ftAway++;
    if (ht === "H") res.htHome++; else if (ht === "D") res.htDraw++; else res.htAway++;

    if (ft !== "A") res.dcHX++;          // 1X
    if (ft !== "D") res.dcHA++;          // 12
    if (ft !== "H") res.dcXA++;          // X2
    if (ft === "H") res.dnbHome++; else if (ft === "A") res.dnbAway++;

    for (const l of TOTAL_LINES) { if (total > l) res.over[l]!++; else res.under[l]!++; }
    const fhTotal = h1 + a1;
    for (const l of FH_LINES) { if (fhTotal > l) res.fhOver[l]!++; else res.fhUnder[l]!++; }

    if (home >= 1 && away >= 1) res.bttsYes++; else res.bttsNo++;
    if (total % 2 === 1) res.odd++; else res.even++;

    const scoreKey = `${Math.min(home, 9)}-${Math.min(away, 9)}`;
    res.scores.set(scoreKey, (res.scores.get(scoreKey) ?? 0) + 1);

    const htft = `${code(ht)}/${code(ft)}`;
    res.htft.set(htft, (res.htft.get(htft) ?? 0) + 1);

    // Goalscorers: attribute each goal to a weighted random player on that side.
    const scoredHome = new Set<string>();
    for (let g = 0; g < home; g++) scoredHome.add(weightedPlayer(players.home, r));
    const scoredAway = new Set<string>();
    for (let g = 0; g < away; g++) scoredAway.add(weightedPlayer(players.away, r));
    for (const p of scoredHome) res.homeScorers.set(p, (res.homeScorers.get(p) ?? 0) + 1);
    for (const p of scoredAway) res.awayScorers.set(p, (res.awayScorers.get(p) ?? 0) + 1);
    if (total === 0) res.noScorer++;
  }
  return res;
}

/** Strikers (index 0) score more often than midfielders. */
function weightedPlayer(players: string[], r: () => number): string {
  const weights = [0.5, 0.3, 0.2];
  let x = r();
  for (let i = 0; i < players.length; i++) {
    if (x < weights[i]!) return players[i]!;
    x -= weights[i]!;
  }
  return players[players.length - 1]!;
}

export function generateNorskTippingMarkets(meta: MatchMeta): Market[] {
  const sim = simulate(meta);
  const N = 12000;
  const teams = meta.teams;
  const markets: Market[] = [];
  const add = (m: Market) => markets.push(m);

  const sideSel = (s: "HOME" | "DRAW" | "AWAY") =>
    s === "HOME" ? { key: "HOME", label: teams.home, order: 0 }
    : s === "DRAW" ? { key: "DRAW", label: "Draw", order: 1 }
    : { key: "AWAY", label: teams.away, order: 2 };

  // 1X2
  {
    const m = emptyMarket("MATCH_WINNER");
    upsertQuote(m, sideSel("HOME"), q(sim.ftHome / N, 1.06));
    upsertQuote(m, sideSel("DRAW"), q(sim.ftDraw / N, 1.06));
    upsertQuote(m, sideSel("AWAY"), q(sim.ftAway / N, 1.06));
    add(m);
  }
  // Double chance
  {
    const m = emptyMarket("DOUBLE_CHANCE");
    upsertQuote(m, { key: "1X", label: `${teams.home} or Draw`, order: 0 }, q(sim.dcHX / N, 1.05));
    upsertQuote(m, { key: "12", label: `${teams.home} or ${teams.away}`, order: 1 }, q(sim.dcHA / N, 1.05));
    upsertQuote(m, { key: "X2", label: `Draw or ${teams.away}`, order: 2 }, q(sim.dcXA / N, 1.05));
    add(m);
  }
  // Draw no bet
  {
    const denom = sim.dnbHome + sim.dnbAway;
    const m = emptyMarket("DRAW_NO_BET");
    upsertQuote(m, { key: "HOME", label: teams.home, order: 0 }, q(sim.dnbHome / denom, 1.04));
    upsertQuote(m, { key: "AWAY", label: teams.away, order: 1 }, q(sim.dnbAway / denom, 1.04));
    add(m);
  }
  // BTTS
  {
    const m = emptyMarket("BTTS");
    upsertQuote(m, { key: "YES", label: "Yes", order: 0 }, q(sim.bttsYes / N, 1.07));
    upsertQuote(m, { key: "NO", label: "No", order: 1 }, q(sim.bttsNo / N, 1.07));
    add(m);
  }
  // Totals
  for (const l of TOTAL_LINES) {
    const m = emptyMarket("TOTAL_GOALS", l);
    upsertQuote(m, { key: "OVER", label: `Over ${l}`, order: 0 }, q(sim.over[l]! / N, 1.07));
    upsertQuote(m, { key: "UNDER", label: `Under ${l}`, order: 1 }, q(sim.under[l]! / N, 1.07));
    add(m);
  }
  // First-half totals
  for (const l of FH_LINES) {
    const m = emptyMarket("FIRST_HALF_GOALS", l);
    upsertQuote(m, { key: "OVER", label: `Over ${l}`, order: 0 }, q(sim.fhOver[l]! / N, 1.08));
    upsertQuote(m, { key: "UNDER", label: `Under ${l}`, order: 1 }, q(sim.fhUnder[l]! / N, 1.08));
    add(m);
  }
  // Half-time result
  {
    const m = emptyMarket("HT_RESULT");
    upsertQuote(m, sideSel("HOME"), q(sim.htHome / N, 1.08));
    upsertQuote(m, sideSel("DRAW"), q(sim.htDraw / N, 1.08));
    upsertQuote(m, sideSel("AWAY"), q(sim.htAway / N, 1.08));
    add(m);
  }
  // Odd / even
  {
    const m = emptyMarket("ODD_EVEN");
    upsertQuote(m, { key: "ODD", label: "Odd", order: 0 }, q(sim.odd / N, 1.06));
    upsertQuote(m, { key: "EVEN", label: "Even", order: 1 }, q(sim.even / N, 1.06));
    add(m);
  }
  // Correct score (top 14)
  {
    const m = emptyMarket("CORRECT_SCORE");
    const top = [...sim.scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
    top.forEach(([score, count], i) => {
      upsertQuote(m, { key: score, label: score.replace("-", "–"), order: i }, q(count / N, 1.25));
    });
    add(m);
  }
  // Half-time / Full-time (all 9 combos)
  {
    const m = emptyMarket("HT_FT");
    const combos = ["1/1", "1/X", "1/2", "X/1", "X/X", "X/2", "2/1", "2/X", "2/2"];
    const label = (c: string) =>
      c.split("/").map((x) => (x === "1" ? teams.home : x === "2" ? teams.away : "Draw")).join(" / ");
    combos.forEach((c, i) => {
      upsertQuote(m, { key: c, label: label(c), order: i }, q((sim.htft.get(c) ?? 0) / N, 1.2));
    });
    add(m);
  }
  // Anytime goalscorer
  {
    const m = emptyMarket("ANYTIME_GOALSCORER");
    const entries = [...sim.homeScorers.entries(), ...sim.awayScorers.entries()].sort(
      (a, b) => b[1] - a[1],
    );
    entries.forEach(([player, count], i) => {
      upsertQuote(m, { key: `p:${player.toLowerCase().replace(/[^a-z0-9]/g, "")}`, label: player, order: i }, q(count / N, 1.15));
    });
    add(m);
  }

  return markets;

  function q(prob: number, overround: number) {
    return makeQuote("norsktipping", { decimal: withMargin(prob, overround), prob: Math.min(0.985, prob * overround) });
  }
}

/** Stable identity check used by callers that cache by match. */
export function mockMatchId(teams: TeamInfo): number {
  return hashString(`${teams.home}|${teams.away}`);
}

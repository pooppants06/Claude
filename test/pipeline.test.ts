import { test } from "node:test";
import assert from "node:assert/strict";

import {
  probToDecimal,
  decimalToProb,
  emptyMarket,
  upsertQuote,
  makeQuote,
} from "../src/normalize/markets.js";
import { parseSlug, classifyTeamSide, teamKey } from "../src/normalize/teams.js";
import {
  classifyPolymarketMarket,
  type RawPolymarketMarket,
} from "../src/sources/polymarket/classify.js";
import {
  buildPolymarketMarkets,
  extractSlug,
  matchCore,
  sameMatch,
} from "../src/sources/polymarket/gamma.js";
import { generateNorskTippingMarkets } from "../src/sources/norsktipping/mock.js";
import { compareMarkets } from "../src/compare/compare.js";
import { buildOrientation } from "../src/sources/norsktipping/oddsen.js";
import type { MatchMeta, TeamInfo } from "../src/types.js";

const teams: TeamInfo = { home: "Brazil", away: "Haiti", homeCode: "bra", awayCode: "hai" };
const meta: MatchMeta = {
  slug: "fifwc-bra-hai-2026-06-19",
  title: "Brazil vs Haiti",
  teams,
  polymarketUrl: "https://polymarket.com/sports/world-cup/fifwc-bra-hai-2026-06-19",
};

test("extractSlug pulls the slug from a full URL", () => {
  assert.equal(
    extractSlug("https://polymarket.com/sports/world-cup/fifwc-bra-hai-2026-06-19"),
    "fifwc-bra-hai-2026-06-19",
  );
  assert.equal(extractSlug("fifwc-bra-hai-2026-06-19"), "fifwc-bra-hai-2026-06-19");
});

test("parseSlug splits league, teams and date", () => {
  const p = parseSlug("fifwc-bra-hai-2026-06-19");
  assert.equal(p.homeCode, "bra");
  assert.equal(p.awayCode, "hai");
  assert.equal(p.date, "2026-06-19");
});

test("odds math round-trips", () => {
  assert.ok(Math.abs(probToDecimal(0.5) - 2) < 1e-9);
  assert.ok(Math.abs(decimalToProb(2) - 0.5) < 1e-9);
});

test("classifies a 3-way moneyline market", () => {
  const raw: RawPolymarketMarket = {
    question: "Brazil vs. Haiti",
    sportsMarketType: "moneyline",
    outcomes: JSON.stringify(["Brazil", "Draw", "Haiti"]),
    outcomePrices: JSON.stringify(["0.7", "0.2", "0.1"]),
    clobTokenIds: JSON.stringify(["t-home", "t-draw", "t-away"]),
  };
  const sels = classifyPolymarketMarket(raw, teams);
  assert.equal(sels.length, 3);
  assert.deepEqual(
    sels.map((s) => s.selectionKey).sort(),
    ["AWAY", "DRAW", "HOME"],
  );
  assert.equal(sels.every((s) => s.type === "MATCH_WINNER"), true);
});

test("classifies a binary Over/Under totals market with a line", () => {
  const raw: RawPolymarketMarket = {
    groupItemTitle: "Over 2.5",
    question: "Will there be over 2.5 goals?",
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify(["0.55", "0.45"]),
    clobTokenIds: JSON.stringify(["t-over", "t-under"]),
  };
  const sels = classifyPolymarketMarket(raw, teams);
  assert.equal(sels.length, 2);
  assert.equal(sels[0]!.type, "TOTAL_GOALS");
  assert.equal(sels[0]!.line, 2.5);
  assert.deepEqual(sels.map((s) => s.selectionKey).sort(), ["OVER", "UNDER"]);
});

test("buildPolymarketMarkets merges binary team-to-win sub-markets into one 1X2", () => {
  const raw: RawPolymarketMarket[] = [
    {
      groupItemTitle: "Brazil",
      question: "Will Brazil win?",
      outcomes: JSON.stringify(["Yes", "No"]),
      outcomePrices: JSON.stringify(["0.7", "0.3"]),
      clobTokenIds: JSON.stringify(["bra-yes", "bra-no"]),
    },
    {
      groupItemTitle: "Haiti",
      question: "Will Haiti win?",
      outcomes: JSON.stringify(["Yes", "No"]),
      outcomePrices: JSON.stringify(["0.1", "0.9"]),
      clobTokenIds: JSON.stringify(["hai-yes", "hai-no"]),
    },
    {
      groupItemTitle: "Draw",
      question: "Will the match be a draw?",
      outcomes: JSON.stringify(["Yes", "No"]),
      outcomePrices: JSON.stringify(["0.2", "0.8"]),
      clobTokenIds: JSON.stringify(["draw-yes", "draw-no"]),
    },
  ];
  const { markets, tokenIds } = buildPolymarketMarkets(raw, teams);
  const mw = markets.find((m) => m.type === "MATCH_WINNER");
  assert.ok(mw, "expected a MATCH_WINNER market");
  assert.deepEqual(mw!.selections.map((s) => s.key).sort(), ["AWAY", "DRAW", "HOME"]);
  // Each Yes token should be subscribed to for live updates.
  assert.ok(tokenIds.includes("bra-yes") && tokenIds.includes("draw-yes"));
});

test("mock Norsk Tipping book covers the major market types", () => {
  const markets = generateNorskTippingMarkets(meta);
  const types = new Set(markets.map((m) => m.type));
  for (const t of ["MATCH_WINNER", "DOUBLE_CHANCE", "BTTS", "TOTAL_GOALS", "CORRECT_SCORE", "HT_FT", "ANYTIME_GOALSCORER"]) {
    assert.ok(types.has(t as any), `mock should include ${t}`);
  }
  const mw = markets.find((m) => m.type === "MATCH_WINNER")!;
  // 1X2 implied probabilities should sum to a bit over 1 (the margin).
  const sum = mw.selections.reduce((a, s) => a + (s.quotes.norsktipping!.impliedProb ?? 0), 0);
  assert.ok(sum > 1.0 && sum < 1.2, `overround out of range: ${sum}`);
});

test("compareMarkets merges both books and ranks by biggest difference", () => {
  const pmRaw: RawPolymarketMarket[] = [
    {
      question: "Brazil vs. Haiti",
      sportsMarketType: "moneyline",
      outcomes: JSON.stringify(["Brazil", "Draw", "Haiti"]),
      outcomePrices: JSON.stringify(["0.7", "0.2", "0.1"]),
      clobTokenIds: JSON.stringify(["t-home", "t-draw", "t-away"]),
    },
  ];
  const { markets: pmMarkets } = buildPolymarketMarkets(pmRaw, teams);
  const ntMarkets = generateNorskTippingMarkets(meta);
  const snap = compareMarkets(
    meta,
    [
      { source: "polymarket", markets: pmMarkets, status: "live" },
      { source: "norsktipping", markets: ntMarkets, status: "mock" },
    ],
    { polymarket: "live", norsktipping: "mock" },
  );

  const mw = snap.markets.find((m) => m.type === "MATCH_WINNER")!;
  assert.ok(mw.sourceCount >= 2);
  for (const s of mw.selections) {
    assert.ok(s.quotes.polymarket && s.quotes.norsktipping, `both quotes expected for ${s.key}`);
    assert.ok(s.spreadPct != null && s.bestSource);
  }
  // Highlights are sorted by descending spread.
  for (let i = 1; i < snap.highlights.length; i++) {
    assert.ok(snap.highlights[i - 1]!.spreadPct >= snap.highlights[i]!.spreadPct);
  }
  // Multi-book markets must sort ahead of single-book ones.
  const firstSingle = snap.markets.findIndex((m) => m.sourceCount < 2);
  const lastMulti = snap.markets.map((m) => m.sourceCount >= 2).lastIndexOf(true);
  if (firstSingle !== -1) assert.ok(lastMulti < firstSingle);
});

test("de-vig ignores a book that prices only one side of a market", () => {
  // Polymarket prices the full Over/Under 2.5 line; Norsk Tipping only lists the
  // Over. A naive per-book de-vig would normalise NT's lone Over to ~100% and
  // poison the consensus fair prob (inventing a huge phantom edge). The fair prob
  // for Over must stay near Polymarket's real ~1.6%, not jump to ~50%.
  const pmMkt = emptyMarket("TOTAL_GOALS", 2.5);
  upsertQuote(pmMkt, { key: "OVER", label: "Over 2.5", order: 0 }, makeQuote("polymarket", { decimal: 64.516 }));
  upsertQuote(pmMkt, { key: "UNDER", label: "Under 2.5", order: 1 }, makeQuote("polymarket", { decimal: 1.016 }));

  const ntMkt = emptyMarket("TOTAL_GOALS", 2.5);
  upsertQuote(ntMkt, { key: "OVER", label: "Over 2.5", order: 0 }, makeQuote("norsktipping", { decimal: 25 }));

  const snap = compareMarkets(
    meta,
    [
      { source: "polymarket", markets: [pmMkt], status: "live" },
      { source: "norsktipping", markets: [ntMkt], status: "live" },
    ],
    { polymarket: "live", norsktipping: "live" },
  );

  const over = snap.markets[0]!.selections.find((s) => s.key === "OVER")!;
  assert.ok(over.fairProb != null && over.fairProb < 0.1, `fair prob poisoned: ${over.fairProb}`);
  assert.ok(over.edgePct != null && over.edgePct < 50, `phantom edge not contained: ${over.edgePct}`);
});

test("teamKey collapses 'and' / '&' spellings", () => {
  assert.equal(teamKey("Bosnia and Herzegovina"), teamKey("Bosnia-Herzegovina"));
  assert.equal(teamKey("Trinidad & Tobago"), teamKey("Trinidad and Tobago"));
});

test("teamKey maps Norwegian spellings to the same key as English", () => {
  const pairs: [string, string][] = [
    ["Skottland", "Scotland"], ["Tyrkia", "Türkiye"], ["Norge", "Norway"],
    ["Sør-Afrika", "South Africa"], ["Sør-Korea", "Korea Republic"], ["Brasil", "Brazil"],
    ["Tyskland", "Germany"], ["Elfenbenskysten", "Côte d'Ivoire"], ["Østerrike", "Austria"],
    ["Kapp Verde", "Cabo Verde"], ["USA", "United States"],
  ];
  for (const [no, en] of pairs) assert.equal(teamKey(no), teamKey(en), `${no} ≠ ${en}`);
});

test("a home team total is not misclassified as the full-match total when team spelling differs", () => {
  // Polymarket spells the team "Bosnia and Herzegovina" on the moneyline but
  // "Bosnia-Herzegovina" on the totals. The home team total must stay separate
  // from the full-match total, or its price corrupts the match total.
  const bihTeams: TeamInfo = {
    home: "Bosnia and Herzegovina",
    away: "Qatar",
    homeCode: "bih",
    awayCode: "qat",
  };
  const raw: RawPolymarketMarket[] = [
    {
      groupItemTitle: "O/U 2.5",
      question: "Bosnia-Herzegovina vs. Qatar: O/U 2.5",
      outcomes: JSON.stringify(["Over 2.5", "Under 2.5"]),
      outcomePrices: JSON.stringify(["0.60", "0.40"]),
      clobTokenIds: JSON.stringify(["ft-over", "ft-under"]),
    },
    {
      groupItemTitle: "Bosnia-Herzegovina O/U 2.5",
      question: "Bosnia-Herzegovina vs. Qatar: Bosnia-Herzegovina O/U 2.5",
      outcomes: JSON.stringify(["Over 2.5", "Under 2.5"]),
      outcomePrices: JSON.stringify(["0.39", "0.61"]),
      clobTokenIds: JSON.stringify(["tt-over", "tt-under"]),
    },
  ];
  const { markets } = buildPolymarketMarkets(raw, bihTeams);
  const ft = markets.find((m) => m.type === "TOTAL_GOALS" && m.line === 2.5);
  const tt = markets.find((m) => m.type === "TEAM_TOTAL_HOME" && m.line === 2.5);
  assert.ok(ft, "expected a full-match TOTAL_GOALS@2.5");
  assert.ok(tt, "expected a TEAM_TOTAL_HOME@2.5");
  // The full-match Over price must be its own 0.60, not corrupted to the team total's 0.39.
  const ftOver = ft!.selections.find((s) => s.key === "OVER");
  assert.ok(Math.abs((ftOver!.quotes.polymarket!.impliedProb ?? 0) - 0.6) < 1e-6, "match total corrupted by team total");
});

test("a Norsk Tipping team total is detected by its native (un-aliased) name", () => {
  // Cross-book alias maps NT "Usbekistan" → "uzbekistan", but the NT market NAME
  // keeps "Usbekistan". sideForName must still recognise the team total (else it
  // leaks into the full-match total and scrambles the goal-line ladder).
  const meta: MatchMeta = {
    slug: "fifwc-prt-uzb-2026-06-23",
    title: "Portugal vs Uzbekistan",
    teams: { home: "Portugal", away: "Uzbekistan", homeCode: "prt", awayCode: "uzb" },
    polymarketUrl: "x",
  };
  const o = buildOrientation(meta, { eventId: "1", homeParticipant: "Portugal", awayParticipant: "Usbekistan" });
  assert.equal(o.sideForName("Usbekistan - totalt antall mål - over/under 1.5"), "AWAY");
  assert.equal(o.sideForName("Portugal - totalt antall mål - over/under 1.5"), "HOME");
  assert.equal(o.sideForName("Totalt antall mål - over/under 1.5"), null);
});

test("buildOrientation realigns Norsk Tipping's reversed home/away", () => {
  // Polymarket has Côte d'Ivoire home, Curaçao away; Norsk Tipping lists the
  // same fixture with the sides reversed (and the favourite spelled in Norwegian).
  const civMeta: MatchMeta = {
    slug: "fifwc-civ-cuw-2026-06-25",
    title: "Côte d'Ivoire vs Curaçao",
    teams: { home: "Côte d'Ivoire", away: "Curaçao", homeCode: "civ", awayCode: "cuw" },
    polymarketUrl: "x",
  };
  const flipped = buildOrientation(civMeta, {
    eventId: "1",
    homeParticipant: "Curaçao",
    awayParticipant: "Elfenbenskysten",
  });
  assert.equal(flipped.flip, true);
  // NT's home participant (Curaçao) must resolve to our canonical AWAY side.
  assert.equal(flipped.sideForName("Curaçao"), "AWAY");

  // A book that already agrees on orientation must not be flipped.
  const aligned = buildOrientation(meta, {
    eventId: "2",
    homeParticipant: "Brazil",
    awayParticipant: "Haiti",
  });
  assert.equal(aligned.flip, false);
  assert.equal(aligned.sideForName("Brazil"), "HOME");
  assert.equal(aligned.sideForName("Haiti"), "AWAY");
});

test("matchCore + sameMatch group a match's sibling events but exclude others", () => {
  const base = "fifwc-bra-hai-2026-06-19";
  const core = matchCore(base);
  assert.equal(core, "bra-hai-2026-06-19");
  // Same match (sibling market events) -> kept.
  assert.equal(sameMatch("fifwc-bra-hai-2026-06-19", base, core), true);
  assert.equal(sameMatch("fifwc-bra-hai-2026-06-19-exact-score", base, core), true);
  assert.equal(sameMatch("bra-hai-2026-06-19-total-goals", base, core), true);
  // Different match / tournament-wide events -> excluded.
  assert.equal(sameMatch("fifwc-usa-aus-2026-06-19-exact-score", base, core), false);
  assert.equal(sameMatch("world-cup-player-to-score", base, core), false);
  assert.equal(sameMatch("fifwc-bra-hai-2026-06-20", base, core), false);
});

test("classifyTeamSide resolves codes and names", () => {
  assert.equal(classifyTeamSide("Brazil", teams), "HOME");
  assert.equal(classifyTeamSide("Haiti", teams), "AWAY");
  assert.equal(classifyTeamSide("Draw", teams), "DRAW");
});

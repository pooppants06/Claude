import { test } from "node:test";
import assert from "node:assert/strict";

import { probToDecimal, decimalToProb } from "../src/normalize/markets.js";
import { parseSlug, classifyTeamSide } from "../src/normalize/teams.js";
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

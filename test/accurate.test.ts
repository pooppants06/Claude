import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateMarket, bookWeight } from "../src/normalize/devig.js";
import {
  fitGoalModel, scoreMatrix, matrixWinProbs, matrixOver, matrixBtts, firstHalfModel,
} from "../src/model/poisson.js";

test("bookWeight: sharp books outweigh soft books", () => {
  assert.ok(bookWeight("pinnacle") > bookWeight("williamhill"));
  assert.ok(bookWeight("betfair_ex_eu") > bookWeight("coolbet"));
  assert.equal(bookWeight("some_unknown_book"), 1);
});

test("aggregateMarket: probabilities sum to 1 and de-vig removes margin", () => {
  // Two books, ~5% overround each on a 2-way market.
  const agg = aggregateMarket(
    [
      { key: "pinnacle", odds: { OVER: 1.9, UNDER: 1.9 } },
      { key: "coolbet", odds: { OVER: 1.95, UNDER: 1.87 } },
    ],
    ["OVER", "UNDER"],
  )!;
  assert.ok(agg);
  const sum = agg.probs.OVER! + agg.probs.UNDER!;
  assert.ok(Math.abs(sum - 1) < 1e-9, `sum ${sum}`);
  // Pinnacle (1.9/1.9 → .50) dominates; Coolbet leans under, so fair OVER sits
  // just below .50 and well under the vigged 1/1.9 = .526 implied.
  assert.ok(agg.probs.OVER! > 0.47 && agg.probs.OVER! < 0.51, `over ${agg.probs.OVER}`);
  assert.equal(agg.nBooks, 2);
});

test("aggregateMarket: a book missing a selection is dropped", () => {
  const agg = aggregateMarket(
    [
      { key: "pinnacle", odds: { HOME: 1.8, DRAW: 3.6, AWAY: 4.5 } },
      { key: "soft", odds: { HOME: 1.85, DRAW: 3.5 } }, // no AWAY → dropped
    ],
    ["HOME", "DRAW", "AWAY"],
  )!;
  assert.equal(agg.nBooks, 1);
});

test("aggregateMarket: sharp book pulls consensus toward its price", () => {
  const sel = ["HOME", "AWAY"];
  const agg = aggregateMarket(
    [
      { key: "pinnacle", odds: { HOME: 1.5, AWAY: 2.7 } }, // home ~.66 fair
      { key: "softa", odds: { HOME: 2.2, AWAY: 1.75 } },
      { key: "softb", odds: { HOME: 2.2, AWAY: 1.75 } },
    ],
    sel,
  )!;
  // Despite two soft books favouring AWAY, weighted home prob stays elevated.
  assert.ok(agg.probs.HOME! > 0.5, `home ${agg.probs.HOME}`);
});

test("scoreMatrix: normalised and reproduces independent-Poisson totals", () => {
  const M = scoreMatrix(1.4, 1.1, 0);
  let s = 0;
  for (const row of M) for (const p of row) s += p;
  assert.ok(Math.abs(s - 1) < 1e-9, `matrix sum ${s}`);
  // With rho=0, P(total>2.5) ~ Poisson(2.5) tail.
  const over25 = matrixOver(M, 2.5);
  assert.ok(over25 > 0.4 && over25 < 0.6, `over2.5 ${over25}`);
});

test("fitGoalModel: recovers a favourite + total from clean targets", () => {
  // Build synthetic 'truth', read its probs, then check the fit recovers them.
  const truth = scoreMatrix(1.8, 0.8, -0.05);
  const w = matrixWinProbs(truth);
  const targets = [
    { key: "H", prob: w.home, weight: 10 },
    { key: "D", prob: w.draw, weight: 10 },
    { key: "A", prob: w.away, weight: 10 },
    { key: "O:1.5", prob: matrixOver(truth, 1.5), weight: 5 },
    { key: "O:2.5", prob: matrixOver(truth, 2.5), weight: 5 },
    { key: "O:3.5", prob: matrixOver(truth, 3.5), weight: 5 },
  ];
  const fit = fitGoalModel(targets);
  const fw = matrixWinProbs(fit.M);
  assert.ok(Math.abs(fw.home - w.home) < 0.02, `home ${fw.home} vs ${w.home}`);
  assert.ok(Math.abs(fw.draw - w.draw) < 0.02, `draw ${fw.draw} vs ${w.draw}`);
  assert.ok(Math.abs(matrixOver(fit.M, 2.5) - matrixOver(truth, 2.5)) < 0.02);
});

test("firstHalfModel: fewer goals than full match", () => {
  const full = fitGoalModel([
    { key: "H", prob: 0.45, weight: 10 },
    { key: "D", prob: 0.27, weight: 10 },
    { key: "A", prob: 0.28, weight: 10 },
    { key: "O:2.5", prob: 0.52, weight: 5 },
  ]);
  const fh = firstHalfModel(full);
  assert.ok(matrixOver(fh.M, 1.5) < matrixOver(full.M, 1.5));
  assert.ok(matrixBtts(fh.M) < matrixBtts(full.M));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { kellyStake, sharesFor, acceptableFill, roundToTick } from "../src/trade/sizing.js";

const P = { bankroll: 1000, kellyMult: 0.25, maxStakePerBet: 50 };

test("kellyStake: quarter-Kelly on a clear edge, capped", () => {
  // fair .60, price .50 → fullKelly = .10/.50 = .20; quarter = .05; ×1000 = 50.
  assert.ok(Math.abs(kellyStake(0.6, 0.5, P) - 50) < 1e-6); // hits the $50 cap
  // Smaller edge stays under cap: fair .55 price .50 → fk .10, qk .025, $25.
  assert.equal(Math.round(kellyStake(0.55, 0.5, { ...P, maxStakePerBet: 999 })), 25);
});

test("kellyStake: no edge or bad inputs → 0", () => {
  assert.equal(kellyStake(0.45, 0.5, P), 0);   // fair below price
  assert.equal(kellyStake(0.5, 0.5, P), 0);    // no edge
  assert.equal(kellyStake(0.6, 1, P), 0);      // degenerate price
  assert.equal(kellyStake(0.6, 0, P), 0);
});

test("sharesFor: floor of stake/price", () => {
  assert.equal(sharesFor(50, 0.5), 100);
  assert.equal(sharesFor(10, 0.3), 33); // 33.3 → 33
  assert.equal(sharesFor(10, 0), 0);
});

test("acceptableFill: needs residual edge after the ask", () => {
  assert.equal(acceptableFill(0.6, 0.55, 0.02), true);  // 5pp left ≥ 2pp
  assert.equal(acceptableFill(0.6, 0.59, 0.02), false); // only 1pp left
  assert.equal(acceptableFill(0.6, 1.2, 0.02), false);  // invalid ask
});

test("roundToTick: snaps to tick grid, floors at one tick", () => {
  assert.equal(roundToTick(0.5234, 0.01), 0.52);
  assert.equal(roundToTick(0.5267, 0.01), 0.53);
  assert.equal(roundToTick(0.0004, 0.001), 0.001); // never below a tick
  assert.equal(roundToTick(0.12345, 0.001), 0.123);
});

/**
 * Per-book de-vigging and sharp-weighted aggregation.
 *
 * The accurate way to build a market consensus is NOT to average decimal odds
 * and de-vig once (averaging odds is biased — 1/x is convex). Instead we:
 *   1. de-vig EACH bookmaker individually (Shin), giving that book's fair probs;
 *   2. take a WEIGHTED MEAN of those probabilities across books.
 * Weights reward sharp / low-margin books, whose lines are the best public
 * predictors — a crowd of soft books copying each other shouldn't out-vote
 * Pinnacle or the Betfair exchange.
 */

import { shinProbabilities } from "./shin.js";

/**
 * Sharpness tier by Odds-API bookmaker key. Exchanges and the recognised sharp
 * books carry the most weight; everything unlisted defaults to a soft 1.
 */
const BOOK_WEIGHT: Record<string, number> = {
  pinnacle: 6,
  betfair_ex_eu: 6, betfair_ex_uk: 6, betfair: 5,
  smarkets: 5, matchbook: 5,
  marathonbet: 3, betonlineag: 2.5, lowvig: 3, bookmaker: 3, circasports: 3,
  sbobet: 3, betanysports: 2,
};

export function bookWeight(key: string): number {
  return BOOK_WEIGHT[key.toLowerCase()] ?? 1;
}

export interface Aggregated {
  /** Weighted consensus probability per selection key (sums to 1). */
  probs: Record<string, number>;
  /** Weighted standard deviation of the per-book probability (disagreement). */
  dispersion: Record<string, number>;
  /** Number of books that quoted the full market. */
  nBooks: number;
  /** Effective sample size (Σw)²/Σw² — deep+sharp coverage → higher. */
  effN: number;
}

/**
 * Aggregate one market across books. `perBook` gives each book's decimal odds
 * keyed by selection; a book only counts if it covers every selection (so the
 * de-vig sees the full outcome space). Weight = sharpness × a mild inverse-
 * margin bonus (a tighter book on this market is pricing it more seriously).
 */
export function aggregateMarket(
  perBook: { key: string; odds: Record<string, number> }[],
  selKeys: string[],
): Aggregated | null {
  const rows: { w: number; p: Record<string, number> }[] = [];
  for (const b of perBook) {
    const decs = selKeys.map((k) => b.odds[k] ?? 0);
    if (decs.some((d) => !(d > 1))) continue;
    const overround = decs.reduce((a, d) => a + 1 / d, 0);
    const fair = shinProbabilities(decs);
    // Inverse-margin bonus, capped so a near-zero-margin exchange can't run away.
    const marginBonus = Math.min(2, 0.06 / Math.max(0.01, overround - 1));
    const w = bookWeight(b.key) * (1 + marginBonus);
    const p: Record<string, number> = {};
    selKeys.forEach((k, i) => (p[k] = fair[i]!));
    rows.push({ w, p });
  }
  if (rows.length === 0) return null;
  const W = rows.reduce((a, r) => a + r.w, 0);
  const probs: Record<string, number> = {};
  const dispersion: Record<string, number> = {};
  for (const k of selKeys) {
    probs[k] = rows.reduce((a, r) => a + r.w * r.p[k]!, 0) / W;
  }
  for (const k of selKeys) {
    const v = rows.reduce((a, r) => a + r.w * (r.p[k]! - probs[k]!) ** 2, 0) / W;
    dispersion[k] = Math.sqrt(v);
  }
  const effN = (W * W) / rows.reduce((a, r) => a + r.w * r.w, 0);
  return { probs, dispersion, nBooks: rows.length, effN };
}

/**
 * Stake sizing and fill validation for Polymarket order placement. Kept pure
 * (no network, no key) so it can be unit-tested; the CLI in trade.ts wires this
 * to the CLOB client and the interactive confirmation prompt.
 *
 * Polymarket outcome tokens trade in probability units: buying a share at price
 * p costs $p and pays $1 if the outcome resolves yes, i.e. decimal odds 1/p.
 * Profit on a winning $S stake is S·(1/p − 1).
 */

export interface SizingParams {
  bankroll: number;       // total USDC you're allocating
  kellyMult: number;      // fraction of full Kelly (0.25 = quarter-Kelly)
  maxStakePerBet: number; // hard $ cap per bet
}

/**
 * Fractional-Kelly stake (USDC) for a binary outcome you believe is `fairProb`
 * likely, buyable at `price`. Full Kelly for a binary at decimal odds d=1/p is
 * f* = (fairProb − p)/(1 − p). Never returns more than the per-bet cap, and 0
 * when there's no edge.
 */
export function kellyStake(fairProb: number, price: number, p: SizingParams): number {
  if (!(price > 0 && price < 1) || !(fairProb > 0 && fairProb < 1)) return 0;
  const edge = fairProb - price;
  if (edge <= 0) return 0;
  const fullKelly = edge / (1 - price); // = (fairProb−p)/(1−p)
  const frac = Math.max(0, fullKelly) * p.kellyMult;
  const stake = p.bankroll * frac;
  return Math.min(stake, p.maxStakePerBet);
}

/** Whole shares purchasable for `stake` USDC at `price` (cost = shares·price). */
export function sharesFor(stake: number, price: number): number {
  if (!(price > 0)) return 0;
  return Math.floor(stake / price);
}

/**
 * Is buying at `askPrice` still worth it given our `fairProb`? Require a minimum
 * residual edge after paying the ask, so we don't chase a price up to our own
 * fair estimate and net ~zero.
 */
export function acceptableFill(fairProb: number, askPrice: number, requiredEdge: number): boolean {
  if (!(askPrice > 0 && askPrice < 1)) return false;
  return fairProb - askPrice >= requiredEdge;
}

/** Round a price to the market tick (e.g. 0.01 or 0.001), never below one tick. */
export function roundToTick(price: number, tick: number): number {
  if (!(tick > 0)) return price;
  const r = Math.round(price / tick) * tick;
  const dp = Math.max(0, Math.ceil(-Math.log10(tick)));
  return Math.max(tick, Number(r.toFixed(dp)));
}

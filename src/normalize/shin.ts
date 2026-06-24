/**
 * Shin (1992/1993) de-vigging. Recovers "true" outcome probabilities from a
 * bookmaker's over-round decimal odds by modelling a proportion z of inside
 * (informed) traders. Unlike proportional / multiplicative normalisation, Shin
 * corrects the favourite–longshot bias: it strips relatively more margin from
 * longshots, so their true probability comes out lower (and favourites higher)
 * than a flat rescale.
 *
 * For quoted decimal odds oᵢ, let πᵢ = 1/oᵢ and B = Σ πᵢ (the book sum, > 1 when
 * there is a margin). The true probability is
 *     pᵢ(z) = ( √(z² + 4(1−z)·πᵢ²/B) − z ) / ( 2(1−z) )
 * with z chosen so Σ pᵢ = 1. Σpᵢ(0)=√B>1 and decreases in z, so a unique root
 * exists; we bisect for it. Reference: H.S. Shin, "Measuring the Incidence of
 * Insider Trading in a Market for State-Contingent Claims" (1993); the `implied`
 * R package uses the identical formulation.
 */

function solveZ(inv: number[], B: number): number {
  const sumAt = (z: number) =>
    inv.reduce((acc, q) => acc + (Math.sqrt(z * z + 4 * (1 - z) * (q * q) / B) - z) / (2 * (1 - z)), 0);
  // f(0) = √B − 1 > 0, f(1⁻) = Σπ²/B − 1 < 0 → root in (0,1).
  let lo = 0, hi = 0.999999;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) - 1 > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Shin "true" probabilities for a market's decimal odds (sum to 1). */
export function shinProbabilities(decimals: number[]): number[] {
  const inv = decimals.map((d) => (d > 1 ? 1 / d : 0));
  const B = inv.reduce((a, b) => a + b, 0);
  if (!(B > 0)) return inv.map(() => 0);
  if (B <= 1) return inv.map((p) => p / B); // no over-round → nothing to de-vig
  const z = solveZ(inv, B);
  const raw = inv.map((q) => (Math.sqrt(z * z + 4 * (1 - z) * (q * q) / B) - z) / (2 * (1 - z)));
  const s = raw.reduce((a, b) => a + b, 0);
  return raw.map((x) => x / s); // kill any bisection residual
}

/** Estimated proportion of inside traders (Shin's z) implied by the odds. */
export function shinZ(decimals: number[]): number {
  const inv = decimals.map((d) => (d > 1 ? 1 / d : 0));
  const B = inv.reduce((a, b) => a + b, 0);
  return B > 1 ? solveZ(inv, B) : 0;
}

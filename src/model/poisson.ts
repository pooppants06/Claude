/**
 * Bivariate-Poisson goal model with a Dixon–Coles low-score correction, fitted
 * to a match's market-implied probabilities.
 *
 * Why: de-vigging each betting line in isolation ignores that they all describe
 * ONE match. Over 0.5 / 1.5 / 2.5 … and the 1X2 must come from a single goal
 * distribution. Fitting (λ_home, λ_away) to the deeply-covered markets (1X2 +
 * main totals) and then reading every line off the fitted model:
 *   • enforces coherence across lines,
 *   • lets a thin 2-book total borrow strength from the 25-book moneyline,
 *   • smooths quote noise.
 * The Dixon–Coles ρ nudges the low-score cells so the model can reproduce the
 * draw rate that independent Poisson slightly under-predicts.
 */

const LOG_FACT: number[] = (() => {
  const a = [0];
  for (let i = 1; i <= 30; i++) a[i] = a[i - 1]! + Math.log(i);
  return a;
})();

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(k * Math.log(lambda) - lambda - LOG_FACT[k]!);
}

const MAX_GOALS = 10;

/** Dixon–Coles τ adjustment on the four low-score cells. */
function tau(x: number, y: number, lh: number, la: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

export interface ScoreModel {
  lh: number;
  la: number;
  rho: number;
  /** Joint score probability matrix M[x][y], normalised. */
  M: number[][];
}

/** Build the normalised score matrix for given parameters. */
export function scoreMatrix(lh: number, la: number, rho: number): number[][] {
  const ph: number[] = [];
  const pa: number[] = [];
  for (let i = 0; i <= MAX_GOALS; i++) {
    ph[i] = poissonPmf(i, lh);
    pa[i] = poissonPmf(i, la);
  }
  const M: number[][] = [];
  let s = 0;
  for (let x = 0; x <= MAX_GOALS; x++) {
    M[x] = [];
    for (let y = 0; y <= MAX_GOALS; y++) {
      const p = ph[x]! * pa[y]! * tau(x, y, lh, la, rho);
      M[x]![y] = p;
      s += p;
    }
  }
  for (let x = 0; x <= MAX_GOALS; x++)
    for (let y = 0; y <= MAX_GOALS; y++) M[x]![y]! /= s;
  return M;
}

/** P(home win), P(draw), P(away win) from a score matrix. */
export function matrixWinProbs(M: number[][]): { home: number; draw: number; away: number } {
  let home = 0, draw = 0, away = 0;
  for (let x = 0; x < M.length; x++)
    for (let y = 0; y < M[x]!.length; y++) {
      const p = M[x]![y]!;
      if (x > y) home += p;
      else if (x === y) draw += p;
      else away += p;
    }
  return { home, draw, away };
}

/** P(total goals > line) for a .5 line. */
export function matrixOver(M: number[][], line: number): number {
  let over = 0;
  for (let x = 0; x < M.length; x++)
    for (let y = 0; y < M[x]!.length; y++) if (x + y > line) over += M[x]![y]!;
  return over;
}

/** P(both teams score). */
export function matrixBtts(M: number[][]): number {
  let yes = 0;
  for (let x = 1; x < M.length; x++)
    for (let y = 1; y < M[x]!.length; y++) yes += M[x]![y]!;
  return yes;
}

export interface FitTarget {
  /** "H"|"D"|"A" for 1X2, or "O:<line>" for an over probability. */
  key: string;
  prob: number;
  weight: number;
}

/**
 * Fit (λ_home, λ_away, ρ) by minimising weighted squared error against the
 * supplied market-implied probabilities. Coarse grid + local refine — cheap and
 * robust (no gradient pathologies). Targets are weighted by coverage so the
 * deep markets dominate and thin lines only nudge.
 */
export function fitGoalModel(targets: FitTarget[]): ScoreModel {
  const sse = (lh: number, la: number, rho: number): number => {
    const M = scoreMatrix(lh, la, rho);
    const w = matrixWinProbs(M);
    let e = 0;
    for (const t of targets) {
      let model: number;
      if (t.key === "H") model = w.home;
      else if (t.key === "D") model = w.draw;
      else if (t.key === "A") model = w.away;
      else if (t.key.startsWith("O:")) model = matrixOver(M, Number(t.key.slice(2)));
      else continue;
      e += t.weight * (model - t.prob) ** 2;
    }
    return e;
  };

  let best = { lh: 1.3, la: 1.1, rho: 0, e: Infinity };
  // Coarse grid.
  for (let lh = 0.2; lh <= 3.4; lh += 0.1)
    for (let la = 0.2; la <= 3.4; la += 0.1)
      for (const rho of [-0.15, -0.1, -0.05, 0, 0.05]) {
        const e = sse(lh, la, rho);
        if (e < best.e) best = { lh, la, rho, e };
      }
  // Local refine around the grid optimum.
  for (let lh = best.lh - 0.08; lh <= best.lh + 0.08; lh += 0.02)
    for (let la = best.la - 0.08; la <= best.la + 0.08; la += 0.02)
      for (const rho of [best.rho - 0.03, best.rho, best.rho + 0.03]) {
        const e = sse(Math.max(0.05, lh), Math.max(0.05, la), rho);
        if (e < best.e) best = { lh: Math.max(0.05, lh), la: Math.max(0.05, la), rho, e };
      }
  return { lh: best.lh, la: best.la, rho: best.rho, M: scoreMatrix(best.lh, best.la, best.rho) };
}

/** First-half model: goals arrive slower early; ~0.45 of a match's goals fall
 * in the first half. Scale both rates and rebuild the matrix. */
export function firstHalfModel(m: ScoreModel, frac = 0.45): ScoreModel {
  return {
    lh: m.lh * frac,
    la: m.la * frac,
    rho: m.rho,
    M: scoreMatrix(m.lh * frac, m.la * frac, m.rho),
  };
}

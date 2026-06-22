/**
 * Odds math + canonical market/selection helpers shared by every adapter.
 */

import type { CanonicalMarketType, Market, Period, Quote, SourceId } from "../types.js";

/** Clamp a probability into (0,1) so we never divide by zero. */
export function clampProb(p: number): number {
  if (!Number.isFinite(p)) return NaN;
  return Math.min(0.999, Math.max(0.001, p));
}

/** Probability (0..1) → decimal odds. */
export function probToDecimal(p: number): number {
  return 1 / clampProb(p);
}

/** Decimal odds → implied probability (0..1). */
export function decimalToProb(d: number): number {
  if (!Number.isFinite(d) || d <= 1) return NaN;
  return 1 / d;
}

/** Round to n decimals, returning a number. */
export function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function makeQuote(
  source: SourceId,
  opts: { decimal?: number | null; prob?: number | null; meta?: Record<string, unknown> },
): Quote {
  let decimal = opts.decimal ?? null;
  let prob = opts.prob ?? null;
  if (decimal == null && prob != null) decimal = round(probToDecimal(prob), 3);
  if (prob == null && decimal != null) prob = round(decimalToProb(decimal), 4);
  return {
    source,
    decimal: decimal != null && Number.isFinite(decimal) ? decimal : null,
    impliedProb: prob != null && Number.isFinite(prob) ? prob : null,
    updatedAt: Date.now(),
    meta: opts.meta,
  };
}

/** Build the stable de-dup key for a market (type, optional line, optional period). */
export function marketKey(type: CanonicalMarketType, line?: number, period?: Period): string {
  const base = line == null ? type : `${type}@${line}`;
  return period ? `${base}#${period}` : base;
}

const TYPE_LABELS: Record<CanonicalMarketType, string> = {
  MATCH_WINNER: "Match Winner (1X2)",
  DOUBLE_CHANCE: "Double Chance",
  DRAW_NO_BET: "Draw No Bet",
  BTTS: "Both Teams To Score",
  TOTAL_GOALS: "Total Goals",
  TEAM_TOTAL_HOME: "Home Team Total Goals",
  TEAM_TOTAL_AWAY: "Away Team Total Goals",
  SPREAD: "Goal Handicap",
  ODD_EVEN: "Total Goals Odd/Even",
  CORRECT_SCORE: "Correct Score",
  HT_RESULT: "Half-Time Result (1X2)",
  HT_FT: "Half-Time / Full-Time",
  FIRST_HALF_GOALS: "First Half Total Goals",
  FIRST_TEAM_TO_SCORE: "First Team To Score",
  ANYTIME_GOALSCORER: "Anytime Goalscorer",
  FIRST_GOALSCORER: "First Goalscorer",
  UNKNOWN: "Other",
};

const PERIOD_LABELS: Record<Period, string> = { "1H": "1st Half", "2H": "2nd Half" };

export function defaultMarketLabel(
  type: CanonicalMarketType,
  line?: number,
  period?: Period,
): string {
  let base = TYPE_LABELS[type];
  if (line != null) {
    base += type === "SPREAD" ? ` ${line > 0 ? "+" : ""}${line}` : ` — Over/Under ${line}`;
  }
  return period ? `${base} (${PERIOD_LABELS[period]})` : base;
}

/** A new, empty canonical market. */
export function emptyMarket(
  type: CanonicalMarketType,
  line?: number,
  label?: string,
  period?: Period,
): Market {
  return {
    type,
    line,
    period,
    key: marketKey(type, line, period),
    label: label ?? defaultMarketLabel(type, line, period),
    selections: [],
    sources: [],
  };
}

/**
 * Merge a quote into a market: find or create the selection by key, attach the
 * quote under its source, and record the source on the market.
 */
export function upsertQuote(
  market: Market,
  selection: { key: string; label: string; order?: number },
  quote: Quote,
): void {
  let sel = market.selections.find((s) => s.key === selection.key);
  if (!sel) {
    sel = { key: selection.key, label: selection.label, order: selection.order, quotes: {} };
    market.selections.push(sel);
  }
  // Prefer a more descriptive label if we get one later.
  if (selection.label && selection.label.length > sel.label.length) sel.label = selection.label;
  sel.quotes[quote.source] = quote;
  if (!market.sources.includes(quote.source)) market.sources.push(quote.source);
}

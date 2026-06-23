/**
 * Comparison engine. Merges any number of books (Polymarket, Norsk Tipping, The
 * Odds API, …) by canonical market key, and for each selection computes the
 * price spread across books, the best-paying book, a vig-removed consensus
 * "fair" probability and the value/edge on the best price. Markets are ranked by
 * the biggest spread — the whole point of the app.
 */

import type {
  CanonicalMarketType,
  Market,
  MatchMeta,
  Period,
  Selection,
  SourceId,
} from "../types.js";
import { round } from "../normalize/markets.js";

export interface ComparedQuote {
  decimal: number | null;
  impliedProb: number | null;
  updatedAt: number;
  meta?: Record<string, unknown>;
}

export interface ComparedSelection {
  key: string;
  label: string;
  order: number;
  quotes: Partial<Record<SourceId, ComparedQuote>>;
  sourceCount: number;
  /** Book paying the highest decimal odds for this pick. */
  bestSource: SourceId | null;
  bestDecimal: number | null;
  /** Relative gap between the highest and lowest decimal across books, in %. */
  spreadPct: number | null;
  /** Vig-removed consensus probability across the books quoting this market. */
  fairProb: number | null;
  /** Value on the best price vs the consensus fair prob, in %. */
  edgePct: number | null;
}

export interface ComparedMarket {
  type: CanonicalMarketType;
  key: string;
  line?: number;
  period?: Period;
  label: string;
  /** True when selections cover the whole outcome space (de-vig/edge is valid). */
  complete: boolean;
  sources: SourceId[];
  sourceCount: number;
  maxSpreadPct: number | null;
  bestEdgePct: number | null;
  bestSource: SourceId | null;
  selections: ComparedSelection[];
}

export interface Highlight {
  marketLabel: string;
  marketKey: string;
  selectionLabel: string;
  prices: Partial<Record<SourceId, number | null>>;
  spreadPct: number;
  bestSource: SourceId;
}

export interface ComparisonSnapshot {
  match: MatchMeta;
  sources: SourceId[];
  status: Partial<Record<SourceId, string>>;
  coverage: Partial<Record<SourceId, number>>;
  counts: { total: number; multi: number };
  highlights: Highlight[];
  markets: ComparedMarket[];
  generatedAt: number;
}

export interface Book {
  source: SourceId;
  markets: Market[];
  status: string;
}

const TYPE_ORDER: CanonicalMarketType[] = [
  "MATCH_WINNER", "DOUBLE_CHANCE", "DRAW_NO_BET", "TOTAL_GOALS", "BTTS",
  "SPREAD", "HT_RESULT", "FIRST_HALF_GOALS", "ODD_EVEN", "TEAM_TOTAL_HOME",
  "TEAM_TOTAL_AWAY", "FIRST_TEAM_TO_SCORE", "CORRECT_SCORE", "HT_FT",
  "ANYTIME_GOALSCORER", "FIRST_GOALSCORER", "UNKNOWN",
];

/** Markets whose selections cover the whole outcome space (so de-vigging is valid). */
const COMPLETE_MARKETS = new Set<CanonicalMarketType>([
  "MATCH_WINNER", "DOUBLE_CHANCE", "DRAW_NO_BET", "BTTS", "TOTAL_GOALS",
  "TEAM_TOTAL_HOME", "TEAM_TOTAL_AWAY", "SPREAD", "ODD_EVEN", "HT_RESULT",
  "FIRST_HALF_GOALS", "FIRST_TEAM_TO_SCORE",
]);

function toCompared(sel: Selection | undefined, source: SourceId): ComparedQuote | null {
  const q = sel?.quotes[source];
  if (!q) return null;
  return { decimal: q.decimal, impliedProb: q.impliedProb, updatedAt: q.updatedAt, meta: q.meta };
}

/** Vig-removed probabilities for one source's selections within a market. */
function fairProbs(market: Market | undefined, source: SourceId): Map<string, number> {
  const out = new Map<string, number>();
  if (!market) return out;
  let sum = 0;
  for (const s of market.selections) {
    const p = s.quotes[source]?.impliedProb;
    if (p != null) sum += p;
  }
  if (sum <= 0) return out;
  for (const s of market.selections) {
    const p = s.quotes[source]?.impliedProb;
    if (p != null) out.set(s.key, p / sum);
  }
  return out;
}

function mergeOne(key: string, bySource: Map<SourceId, Market>): ComparedMarket {
  const ref = [...bySource.values()][0]!;
  const complete = COMPLETE_MARKETS.has(ref.type);

  // Union of selection keys across all books, preserving first-seen order.
  const selKeys: string[] = [];
  const seen = new Set<string>();
  for (const mkt of bySource.values())
    for (const s of mkt.selections)
      if (!seen.has(s.key)) { seen.add(s.key); selKeys.push(s.key); }

  // De-vig is only valid when a book prices the WHOLE outcome space. A book that
  // quotes just one side of a line (e.g. Over but not Under) would normalise that
  // lone selection to ~100%, poisoning the consensus fair prob (and inventing huge
  // phantom edges). So only let a book feed the consensus if it covers every
  // selection in the union.
  const fair = new Map<SourceId, Map<string, number>>();
  for (const [src, mkt] of bySource) {
    const coversAll =
      complete &&
      selKeys.every((k) => {
        const s = mkt.selections.find((x) => x.key === k);
        return s?.quotes[src]?.impliedProb != null;
      });
    fair.set(src, coversAll ? fairProbs(mkt, src) : new Map());
  }

  const selections: ComparedSelection[] = selKeys.map((sk) => {
    const quotes: Partial<Record<SourceId, ComparedQuote>> = {};
    let labels = "";
    let order = 0;
    const decimals: { source: SourceId; decimal: number }[] = [];
    const fairParts: number[] = [];

    for (const [src, mkt] of bySource) {
      const sel = mkt.selections.find((s) => s.key === sk);
      const cq = toCompared(sel, src);
      if (cq) {
        quotes[src] = cq;
        if (cq.decimal && cq.decimal > 1) decimals.push({ source: src, decimal: cq.decimal });
        if ((sel?.label?.length ?? 0) > labels.length) { labels = sel!.label; order = sel!.order ?? 0; }
        const fp = fair.get(src)?.get(sk);
        if (fp != null) fairParts.push(fp);
      }
    }

    let bestSource: SourceId | null = null;
    let bestDecimal: number | null = null;
    let spreadPct: number | null = null;
    let fairProb: number | null = null;
    let edgePct: number | null = null;

    if (decimals.length) {
      const best = decimals.reduce((a, b) => (b.decimal > a.decimal ? b : a));
      const worst = decimals.reduce((a, b) => (b.decimal < a.decimal ? b : a));
      bestSource = best.source;
      bestDecimal = best.decimal;
      if (decimals.length >= 2) spreadPct = round(((best.decimal - worst.decimal) / worst.decimal) * 100, 2);
      if (fairParts.length) {
        fairProb = round(fairParts.reduce((a, b) => a + b, 0) / fairParts.length, 4);
        edgePct = round((fairProb * best.decimal - 1) * 100, 2);
      }
    }

    return {
      key: sk, label: labels || sk, order,
      quotes, sourceCount: decimals.length,
      bestSource, bestDecimal, spreadPct, fairProb, edgePct,
    };
  });

  selections.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));

  const multi = selections.filter((s) => s.sourceCount >= 2);
  const maxSpreadPct = multi.length ? Math.max(...multi.map((s) => s.spreadPct ?? 0)) : null;
  let bestEdgePct: number | null = null;
  let bestSource: SourceId | null = null;
  for (const s of multi) {
    if (s.edgePct != null && (bestEdgePct == null || s.edgePct > bestEdgePct)) {
      bestEdgePct = s.edgePct;
      bestSource = s.bestSource;
    }
  }

  const sources = [...bySource.keys()];
  return {
    type: ref.type, key, line: ref.line, period: ref.period, label: ref.label,
    complete, sources, sourceCount: sources.length,
    maxSpreadPct, bestEdgePct, bestSource, selections,
  };
}

export function compareMarkets(
  match: MatchMeta,
  books: Book[],
  status: Partial<Record<SourceId, string>>,
): ComparisonSnapshot {
  const activeSources = books.filter((b) => b.markets.length).map((b) => b.source);

  // marketKey -> (source -> Market)
  const grouped = new Map<string, Map<SourceId, Market>>();
  for (const book of books) {
    for (const m of book.markets) {
      let g = grouped.get(m.key);
      if (!g) { g = new Map(); grouped.set(m.key, g); }
      g.set(book.source, m);
    }
  }

  const markets = [...grouped.entries()].map(([k, bySource]) => mergeOne(k, bySource));

  markets.sort((a, b) => {
    if (a.sourceCount !== b.sourceCount) return b.sourceCount - a.sourceCount;
    const da = a.maxSpreadPct ?? -1;
    const db = b.maxSpreadPct ?? -1;
    if (db !== da) return db - da;
    const ta = TYPE_ORDER.indexOf(a.type);
    const tb = TYPE_ORDER.indexOf(b.type);
    if (ta !== tb) return ta - tb;
    return (a.line ?? 0) - (b.line ?? 0);
  });

  const coverage: Partial<Record<SourceId, number>> = {};
  for (const b of books) coverage[b.source] = b.markets.length;
  const counts = {
    total: markets.length,
    multi: markets.filter((m) => m.sourceCount >= 2).length,
  };

  const highlights: Highlight[] = markets
    .filter((m) => COMPLETE_MARKETS.has(m.type)) // skip partial markets (correct score, goalscorers) where a big gap isn't real value
    .flatMap((m) =>
      m.selections
        .filter((s) => s.sourceCount >= 2 && s.spreadPct != null)
        .map((s) => {
          const prices: Partial<Record<SourceId, number | null>> = {};
          for (const src of activeSources) prices[src] = s.quotes[src]?.decimal ?? null;
          return {
            marketLabel: m.label,
            marketKey: m.key,
            selectionLabel: s.label,
            prices,
            spreadPct: s.spreadPct as number,
            bestSource: s.bestSource as SourceId,
          };
        }),
    )
    .sort((a, b) => b.spreadPct - a.spreadPct)
    .slice(0, 8);

  return {
    match,
    sources: activeSources,
    status,
    coverage,
    counts,
    highlights,
    markets,
    generatedAt: Date.now(),
  };
}

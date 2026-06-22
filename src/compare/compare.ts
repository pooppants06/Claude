/**
 * Comparison engine. Merges Polymarket and Norsk Tipping markets by canonical
 * key, computes the odds difference per selection, a vig-removed "fair"
 * probability and a value/edge estimate, then ranks bet types by the biggest
 * difference — which is the whole point of the app.
 */

import type {
  CanonicalMarketType,
  Market,
  MatchMeta,
  Selection,
  SourceId,
} from "../types.js";
import { round } from "../normalize/markets.js";

export interface ComparedQuote {
  decimal: number | null;
  impliedProb: number | null;
  updatedAt: number;
}

export interface ComparedSelection {
  key: string;
  label: string;
  order: number;
  polymarket: ComparedQuote | null;
  norsktipping: ComparedQuote | null;
  hasBoth: boolean;
  /** Relative gap between the two decimal prices, in %. */
  oddsDiffPct: number | null;
  oddsDiffAbs: number | null;
  /** Book offering the higher (better-for-bettor) decimal odds. */
  valueSource: SourceId | null;
  /** Vig-removed consensus probability across the two books. */
  fairProb: number | null;
  /** Value on the better side vs the consensus fair prob, in %. */
  edgePct: number | null;
}

export interface ComparedMarket {
  type: CanonicalMarketType;
  key: string;
  line?: number;
  label: string;
  sources: SourceId[];
  hasBoth: boolean;
  maxOddsDiffPct: number | null;
  bestEdgePct: number | null;
  bestValueSource: SourceId | null;
  selections: ComparedSelection[];
}

export interface Highlight {
  marketLabel: string;
  marketKey: string;
  selectionLabel: string;
  polymarket: number | null;
  norsktipping: number | null;
  oddsDiffPct: number;
  valueSource: SourceId;
}

export interface ComparisonSnapshot {
  match: MatchMeta;
  status: {
    polymarket: string;
    norsktipping: string;
  };
  counts: { both: number; polymarketOnly: number; norsktippingOnly: number };
  highlights: Highlight[];
  markets: ComparedMarket[];
  generatedAt: number;
}

const TYPE_ORDER: CanonicalMarketType[] = [
  "MATCH_WINNER", "DOUBLE_CHANCE", "DRAW_NO_BET", "TOTAL_GOALS", "BTTS",
  "SPREAD", "HT_RESULT", "FIRST_HALF_GOALS", "ODD_EVEN", "TEAM_TOTAL_HOME",
  "TEAM_TOTAL_AWAY", "FIRST_TEAM_TO_SCORE", "CORRECT_SCORE", "HT_FT",
  "ANYTIME_GOALSCORER", "FIRST_GOALSCORER", "UNKNOWN",
];

/**
 * Markets whose listed selections cover the whole outcome space, so removing
 * the vig by normalising their implied probabilities is valid. For markets like
 * Correct Score or Goalscorer we only list a subset, so a "fair" value / edge
 * would be misleading and we skip it.
 */
const COMPLETE_MARKETS = new Set<CanonicalMarketType>([
  "MATCH_WINNER", "DOUBLE_CHANCE", "DRAW_NO_BET", "BTTS", "TOTAL_GOALS",
  "TEAM_TOTAL_HOME", "TEAM_TOTAL_AWAY", "SPREAD", "ODD_EVEN", "HT_RESULT",
  "FIRST_HALF_GOALS", "FIRST_TEAM_TO_SCORE",
]);

function toCompared(sel: Selection | undefined, source: SourceId): ComparedQuote | null {
  const q = sel?.quotes[source];
  if (!q) return null;
  return { decimal: q.decimal, impliedProb: q.impliedProb, updatedAt: q.updatedAt };
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

function mergeOne(
  key: string,
  pm: Market | undefined,
  nt: Market | undefined,
): ComparedMarket {
  const ref = (pm ?? nt)!;
  const complete = COMPLETE_MARKETS.has(ref.type);
  const fairPm = complete ? fairProbs(pm, "polymarket") : new Map<string, number>();
  const fairNt = complete ? fairProbs(nt, "norsktipping") : new Map<string, number>();

  const selKeys: string[] = [];
  const seen = new Set<string>();
  for (const s of [...(pm?.selections ?? []), ...(nt?.selections ?? [])]) {
    if (!seen.has(s.key)) {
      seen.add(s.key);
      selKeys.push(s.key);
    }
  }

  const selections: ComparedSelection[] = selKeys.map((sk) => {
    const pmSel = pm?.selections.find((s) => s.key === sk);
    const ntSel = nt?.selections.find((s) => s.key === sk);
    const pmQ = toCompared(pmSel, "polymarket");
    const ntQ = toCompared(ntSel, "norsktipping");
    const hasBoth = !!(pmQ?.decimal && ntQ?.decimal);

    let oddsDiffPct: number | null = null;
    let oddsDiffAbs: number | null = null;
    let valueSource: SourceId | null = null;
    let fairProb: number | null = null;
    let edgePct: number | null = null;

    const dp = pmQ?.decimal ?? null;
    const dn = ntQ?.decimal ?? null;
    if (dp && dn) {
      oddsDiffAbs = round(Math.abs(dp - dn), 3);
      oddsDiffPct = round((Math.abs(dp - dn) / Math.min(dp, dn)) * 100, 2);
      valueSource = dp >= dn ? "polymarket" : "norsktipping";

      const fp = fairPm.get(sk);
      const fn = fairNt.get(sk);
      const parts = [fp, fn].filter((x): x is number => x != null);
      if (parts.length) {
        fairProb = round(parts.reduce((a, b) => a + b, 0) / parts.length, 4);
        const best = Math.max(dp, dn);
        edgePct = round((fairProb * best - 1) * 100, 2);
      }
    } else if (dp || dn) {
      valueSource = dp ? "polymarket" : "norsktipping";
    }

    const label = (pmSel?.label?.length ?? 0) >= (ntSel?.label?.length ?? 0)
      ? pmSel?.label ?? ntSel?.label ?? sk
      : ntSel?.label ?? sk;
    const order = pmSel?.order ?? ntSel?.order ?? 0;

    return {
      key: sk, label, order,
      polymarket: pmQ, norsktipping: ntQ,
      hasBoth, oddsDiffPct, oddsDiffAbs, valueSource, fairProb, edgePct,
    };
  });

  selections.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));

  const bothSels = selections.filter((s) => s.hasBoth);
  const maxOddsDiffPct = bothSels.length
    ? Math.max(...bothSels.map((s) => s.oddsDiffPct ?? 0))
    : null;
  let bestEdgePct: number | null = null;
  let bestValueSource: SourceId | null = null;
  for (const s of bothSels) {
    if (s.edgePct != null && (bestEdgePct == null || s.edgePct > bestEdgePct)) {
      bestEdgePct = s.edgePct;
      bestValueSource = s.valueSource;
    }
  }

  const sources: SourceId[] = [];
  if (pm) sources.push("polymarket");
  if (nt) sources.push("norsktipping");

  return {
    type: ref.type, key, line: ref.line, label: ref.label,
    sources, hasBoth: !!(pm && nt),
    maxOddsDiffPct, bestEdgePct, bestValueSource, selections,
  };
}

export function compareMarkets(
  match: MatchMeta,
  pmMarkets: Market[],
  ntMarkets: Market[],
  status: { polymarket: string; norsktipping: string },
): ComparisonSnapshot {
  const pmByKey = new Map(pmMarkets.map((m) => [m.key, m]));
  const ntByKey = new Map(ntMarkets.map((m) => [m.key, m]));
  const keys = new Set([...pmByKey.keys(), ...ntByKey.keys()]);

  const markets: ComparedMarket[] = [...keys].map((k) =>
    mergeOne(k, pmByKey.get(k), ntByKey.get(k)),
  );

  // Sort: markets with both books first, then biggest difference, then a stable
  // canonical type order.
  markets.sort((a, b) => {
    if (a.hasBoth !== b.hasBoth) return a.hasBoth ? -1 : 1;
    const da = a.maxOddsDiffPct ?? -1;
    const db = b.maxOddsDiffPct ?? -1;
    if (db !== da) return db - da;
    const ta = TYPE_ORDER.indexOf(a.type);
    const tb = TYPE_ORDER.indexOf(b.type);
    if (ta !== tb) return ta - tb;
    return (a.line ?? 0) - (b.line ?? 0);
  });

  const counts = { both: 0, polymarketOnly: 0, norsktippingOnly: 0 };
  for (const m of markets) {
    if (m.hasBoth) counts.both++;
    else if (m.sources[0] === "polymarket") counts.polymarketOnly++;
    else counts.norsktippingOnly++;
  }

  const highlights: Highlight[] = markets
    .flatMap((m) =>
      m.selections
        .filter((s) => s.hasBoth && s.oddsDiffPct != null)
        .map((s) => ({
          marketLabel: m.label,
          marketKey: m.key,
          selectionLabel: s.label,
          polymarket: s.polymarket?.decimal ?? null,
          norsktipping: s.norsktipping?.decimal ?? null,
          oddsDiffPct: s.oddsDiffPct as number,
          valueSource: s.valueSource as SourceId,
        })),
    )
    .sort((a, b) => b.oddsDiffPct - a.oddsDiffPct)
    .slice(0, 8);

  return {
    match,
    status,
    counts,
    highlights,
    markets,
    generatedAt: Date.now(),
  };
}

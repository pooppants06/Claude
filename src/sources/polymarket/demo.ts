/**
 * Offline Polymarket book. Used when POLYMARKET_PROVIDER=demo (or as a fallback
 * when the real Gamma API can't be reached). It derives a plausible Polymarket
 * order book from the same match model as Norsk Tipping, then applies a small
 * per-selection disagreement and a near-zero vig (prediction-market style) so
 * the comparison shows realistic differences. Clearly flagged as demo data.
 *
 * Polymarket only lists a subset of markets for soccer, so we keep the common
 * ones — which also exercises the "Norsk Tipping only" parts of the UI.
 */

import type { Market, MatchMeta } from "../../types.js";
import { emptyMarket, makeQuote, upsertQuote, clampProb } from "../../normalize/markets.js";
import { codeToName, parseSlug } from "../../normalize/teams.js";
import { extractSlug } from "./gamma.js";
import { generateNorskTippingMarkets } from "../norsktipping/mock.js";

const PM_SOCCER_TYPES = new Set([
  "MATCH_WINNER",
  "TOTAL_GOALS",
  "BTTS",
  "DOUBLE_CHANCE",
  "CORRECT_SCORE",
]);

export function demoMeta(slugOrUrl: string): MatchMeta {
  const slug = extractSlug(slugOrUrl);
  const { league, homeCode, awayCode, date } = parseSlug(slug);
  const home = homeCode ? codeToName(homeCode) : "Home";
  const away = awayCode ? codeToName(awayCode) : "Away";
  return {
    slug,
    title: `${home} vs ${away}`,
    teams: { home, away, homeCode, awayCode },
    startDate: date,
    league,
    polymarketUrl: slugOrUrl.startsWith("http") ? slugOrUrl : `https://polymarket.com/event/${slug}`,
  };
}

/** Build a demo Polymarket book for the match (fresh disagreement each call). */
export function generatePolymarketDemo(meta: MatchMeta): Market[] {
  const ntBook = generateNorskTippingMarkets(meta);
  const out: Market[] = [];

  for (const m of ntBook) {
    if (!PM_SOCCER_TYPES.has(m.type)) continue;
    const pm = emptyMarket(m.type, m.line, m.label);
    for (const s of m.selections) {
      const ntProb = s.quotes.norsktipping?.impliedProb;
      if (ntProb == null) continue;
      // Strip most of NT's margin to approximate a fair price, then disagree a bit.
      const fair = ntProb / 1.07;
      const skew = 1 + (Math.random() - 0.5) * 0.16; // ±8% disagreement
      const prob = clampProb(fair * skew);
      upsertQuote(
        pm,
        { key: s.key, label: s.label, order: s.order },
        makeQuote("polymarket", { prob }),
      );
    }
    if (pm.selections.length) out.push(pm);
  }
  return out;
}

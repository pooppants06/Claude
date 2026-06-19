/**
 * Real Norsk Tipping odds via HTTP (NORSKTIPPING_PROVIDER=http).
 *
 * Norsk Tipping's sportsbook runs on Sportradar ORAKO and has no documented
 * public API. There are two practical ways to feed this app real odds:
 *
 *  A) Point NORSKTIPPING_HTTP_URL at a small proxy/scraper YOU run that returns
 *     the canonical JSON contract below. This is the cleanest path and what
 *     parseNorskTippingResponse() understands by default:
 *
 *       {
 *         "markets": [
 *           { "type": "MATCH_WINNER", "line": null,
 *             "selections": [
 *               { "key": "HOME", "label": "Brazil", "decimal": 1.55 },
 *               { "key": "DRAW", "label": "Draw",   "decimal": 4.10 },
 *               { "key": "AWAY", "label": "Haiti",  "decimal": 6.50 }
 *             ] },
 *           { "type": "TOTAL_GOALS", "line": 2.5,
 *             "selections": [
 *               { "key": "OVER",  "label": "Over 2.5",  "decimal": 1.72 },
 *               { "key": "UNDER", "label": "Under 2.5", "decimal": 2.05 }
 *             ] }
 *         ]
 *       }
 *
 *     `type` must be one of the CanonicalMarketType values; `key` must match the
 *     selection keys this app uses (HOME/DRAW/AWAY, OVER/UNDER, YES/NO, "2-1",
 *     1X/12/X2, ODD/EVEN, "1/1".."2/2", or "p:<player>"). See src/types.ts.
 *
 *  B) Point it straight at Norsk Tipping's internal endpoint (capture it from
 *     your browser's DevTools → Network tab on norsk-tipping.no/sport while a
 *     match page is open) and extend parseRawOrako() to map their payload.
 */

import { config } from "../../config.js";
import type { CanonicalMarketType, Market, MatchMeta } from "../../types.js";
import { emptyMarket, makeQuote, upsertQuote } from "../../normalize/markets.js";

const CANONICAL_TYPES = new Set<CanonicalMarketType>([
  "MATCH_WINNER", "DOUBLE_CHANCE", "DRAW_NO_BET", "BTTS", "TOTAL_GOALS",
  "TEAM_TOTAL_HOME", "TEAM_TOTAL_AWAY", "ODD_EVEN", "CORRECT_SCORE",
  "HT_RESULT", "HT_FT", "FIRST_HALF_GOALS", "ANYTIME_GOALSCORER",
  "FIRST_GOALSCORER", "UNKNOWN",
]);

function buildUrl(template: string, meta: MatchMeta): string {
  return template
    .replaceAll("{slug}", encodeURIComponent(meta.slug))
    .replaceAll("{home}", encodeURIComponent(meta.teams.home))
    .replaceAll("{away}", encodeURIComponent(meta.teams.away));
}

export async function fetchNorskTippingHttp(meta: MatchMeta): Promise<Market[]> {
  const template = config.norskTipping.httpUrl;
  if (!template) {
    throw new Error(
      "NORSKTIPPING_PROVIDER=http but NORSKTIPPING_HTTP_URL is empty. Set it (see .env.example / src/sources/norsktipping/orako.ts).",
    );
  }
  const url = buildUrl(template, meta);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", ...config.norskTipping.httpHeaders },
    });
    if (!res.ok) throw new Error(`Norsk Tipping endpoint returned HTTP ${res.status}`);
    const json = await res.json();
    return parseNorskTippingResponse(json, meta);
  } finally {
    clearTimeout(timer);
  }
}

/** Entry point: try the canonical contract first, then the raw-ORAKO mapper. */
export function parseNorskTippingResponse(json: unknown, meta: MatchMeta): Market[] {
  const obj = json as any;
  if (obj && Array.isArray(obj.markets) && looksCanonical(obj.markets)) {
    return parseCanonical(obj.markets);
  }
  return parseRawOrako(json, meta);
}

function looksCanonical(markets: any[]): boolean {
  return markets.every((m) => m && typeof m.type === "string" && Array.isArray(m.selections));
}

function parseCanonical(rawMarkets: any[]): Market[] {
  const out: Market[] = [];
  for (const rm of rawMarkets) {
    const type = rm.type as CanonicalMarketType;
    if (!CANONICAL_TYPES.has(type)) continue;
    const line = typeof rm.line === "number" ? rm.line : undefined;
    const market = emptyMarket(type, line, rm.label);
    for (const s of rm.selections ?? []) {
      const decimal = Number(s.decimal);
      if (!Number.isFinite(decimal) || decimal <= 1) continue;
      upsertQuote(
        market,
        { key: String(s.key), label: String(s.label ?? s.key), order: s.order },
        makeQuote("norsktipping", { decimal }),
      );
    }
    if (market.selections.length) out.push(market);
  }
  return out;
}

/**
 * Map Norsk Tipping's raw ORAKO/Sportradar payload here.
 *
 * Left intentionally unimplemented because the exact shape depends on the
 * endpoint you capture. Inspect the payload, then translate each of their
 * markets/outcomes into emptyMarket()/upsertQuote() calls like parseCanonical()
 * above. Until then, configuring an unknown shape throws a clear error so the
 * caller can fall back to the mock provider.
 */
function parseRawOrako(_json: unknown, _meta: MatchMeta): Market[] {
  throw new Error(
    "Norsk Tipping response was not in the canonical contract and parseRawOrako() is not implemented. " +
      "Adapt src/sources/norsktipping/orako.ts to your captured payload, or return the canonical JSON contract.",
  );
}

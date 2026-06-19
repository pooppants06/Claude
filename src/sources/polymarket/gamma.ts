/**
 * Polymarket Gamma REST adapter: resolve an event by slug and turn its markets
 * into our canonical model, recording which CLOB token id backs each selection
 * (so the WebSocket layer can update prices live).
 */

import { config } from "../../config.js";
import type { MatchMeta, Market, TeamInfo } from "../../types.js";
import { emptyMarket, makeQuote, upsertQuote } from "../../normalize/markets.js";
import { codeToName, parseSlug, teamKey } from "../../normalize/teams.js";
import {
  classifyPolymarketMarket,
  parseJsonArray,
  type RawPolymarketMarket,
} from "./classify.js";

export interface TokenRef {
  marketKey: string;
  selectionKey: string;
}

export interface PolymarketEvent {
  meta: MatchMeta;
  markets: Market[];
  /** CLOB token id -> where its price lives in `markets`. */
  tokenIndex: Map<string, TokenRef>;
  /** All token ids to subscribe to over the WebSocket. */
  tokenIds: string[];
}

/** Pull the event slug out of a Polymarket URL (or accept a bare slug). */
export function extractSlug(input: string): string {
  const raw = input.trim();
  if (!raw.includes("/")) return raw.replace(/[?#].*$/, "");
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const segs = url.pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] ?? raw;
  } catch {
    return raw.replace(/[?#].*$/, "");
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "OddsEdge/1.0" },
    });
    if (!res.ok) {
      throw new Error(
        `Gamma API returned HTTP ${res.status} for ${url}. ` +
          (res.status === 403
            ? "Polymarket may be blocking this network/IP — run the app from a normal internet connection."
            : ""),
      );
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Find the moneyline market and read the two team display names from it. */
function resolveTeams(rawMarkets: RawPolymarketMarket[], slug: string, title: string): TeamInfo {
  const { homeCode, awayCode } = parseSlug(slug);
  const teams: TeamInfo = {
    home: homeCode ? codeToName(homeCode) : "Home",
    away: awayCode ? codeToName(awayCode) : "Away",
    homeCode,
    awayCode,
  };

  // Candidate names: non-draw / non-over-under outcomes from a 2-3 outcome market.
  const candidates: string[] = [];
  for (const m of rawMarkets) {
    const outs = parseJsonArray(m.outcomes);
    if (outs.length < 2 || outs.length > 3) continue;
    const names = outs.filter(
      (o) => !/^(draw|tie|x|uavgjort|yes|no|ja|nei|over|under)$/i.test(o.trim()),
    );
    if (names.length === 2) {
      candidates.push(...names);
      break;
    }
  }

  // Also try "A vs B" from the title as a secondary source.
  const titleMatch = title.match(/(.+?)\s+(?:vs\.?|v|—|-)\s+(.+)/i);
  if (candidates.length !== 2 && titleMatch?.[1] && titleMatch[2]) {
    candidates.push(titleMatch[1].trim(), titleMatch[2].trim());
  }

  if (candidates.length === 2) {
    const [a, b] = candidates;
    const hk = homeCode ? teamKey(codeToName(homeCode)) : "";
    const ak = awayCode ? teamKey(codeToName(awayCode)) : "";
    const ka = teamKey(a!);
    const kb = teamKey(b!);
    // Assign by matching to slug codes; otherwise trust listed order (home first).
    if (hk && (ka === hk || ka.includes(hk) || hk.includes(ka))) {
      teams.home = a!;
      teams.away = b!;
    } else if (ak && (ka === ak || ka.includes(ak) || ak.includes(ka))) {
      teams.home = b!;
      teams.away = a!;
    } else {
      teams.home = a!;
      teams.away = b!;
    }
  }
  return teams;
}

/**
 * Pure (network-free) transform: raw Gamma markets + resolved teams -> our
 * canonical markets, plus the token id -> selection index for the live feed.
 */
export function buildPolymarketMarkets(
  rawMarkets: RawPolymarketMarket[],
  teams: TeamInfo,
): { markets: Market[]; tokenIndex: Map<string, TokenRef>; tokenIds: string[] } {
  const byKey = new Map<string, Market>();
  const tokenIndex = new Map<string, TokenRef>();
  const tokenIds: string[] = [];

  for (const rm of rawMarkets) {
    const classified = classifyPolymarketMarket(rm, teams);
    for (const c of classified) {
      let market = byKey.get(`${c.type}${c.line == null ? "" : `@${c.line}`}`);
      if (!market) {
        market = emptyMarket(c.type, c.line);
        byKey.set(market.key, market);
      }
      const quote = makeQuote("polymarket", {
        prob: c.prob,
        meta: c.tokenId ? { tokenId: c.tokenId } : undefined,
      });
      upsertQuote(
        market,
        { key: c.selectionKey, label: c.selectionLabel, order: c.order },
        quote,
      );
      if (c.tokenId) {
        tokenIndex.set(c.tokenId, { marketKey: market.key, selectionKey: c.selectionKey });
        tokenIds.push(c.tokenId);
      }
    }
  }

  return { markets: [...byKey.values()], tokenIndex, tokenIds };
}

export async function fetchPolymarketEvent(slugOrUrl: string): Promise<PolymarketEvent> {
  const slug = extractSlug(slugOrUrl);
  const url = `${config.polymarket.gammaUrl}/events?slug=${encodeURIComponent(slug)}`;
  const data = await fetchJson(url);
  const events = Array.isArray(data) ? data : (data as any)?.events ?? [];
  const event = events[0];
  if (!event) {
    throw new Error(
      `No Polymarket event found for slug "${slug}". Double-check the link (it should look like https://polymarket.com/sports/.../<slug>).`,
    );
  }

  const rawMarkets: RawPolymarketMarket[] = Array.isArray(event.markets) ? event.markets : [];
  const title: string = event.title ?? slug;
  const teams = resolveTeams(rawMarkets, slug, title);
  const { league, date } = parseSlug(slug);

  const meta: MatchMeta = {
    slug,
    title: title || `${teams.home} vs ${teams.away}`,
    teams,
    startDate: event.startDate ?? event.startTime ?? (date ? `${date}` : undefined),
    league: event.series?.[0]?.title ?? event.league ?? league,
    polymarketUrl: slugOrUrl.startsWith("http")
      ? slugOrUrl
      : `https://polymarket.com/event/${slug}`,
  };

  const { markets, tokenIndex, tokenIds } = buildPolymarketMarkets(rawMarkets, teams);
  return { meta, markets, tokenIndex, tokenIds };
}

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

export interface BuildStats {
  /** Count of canonical markets by type. */
  byType: Record<string, number>;
  /** Questions of raw Gamma markets we couldn't classify (for refinement). */
  unclassified: string[];
}

export interface PolymarketEvent {
  meta: MatchMeta;
  markets: Market[];
  /** CLOB token id -> where its price lives in `markets`. */
  tokenIndex: Map<string, TokenRef>;
  /** All token ids to subscribe to over the WebSocket. */
  tokenIds: string[];
  /** Slugs of every Polymarket event we merged markets from. */
  eventSlugs?: string[];
  stats?: BuildStats;
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

function asEvents(data: unknown): any[] {
  if (Array.isArray(data)) return data;
  return (data as any)?.events ?? [];
}

async function fetchEventsBySlug(slug: string): Promise<any[]> {
  return asEvents(await fetchJson(`${config.polymarket.gammaUrl}/events?slug=${encodeURIComponent(slug)}`));
}

/** Like fetchEventsBySlug but never throws (used for speculative probing). */
async function tryFetchEvents(url: string): Promise<any[]> {
  try {
    return asEvents(await fetchJson(url));
  } catch {
    return [];
  }
}

/** Extract the "<home>-<away>-YYYY-MM-DD" core that identifies a match. */
export function matchCore(slug: string): string | null {
  const m = slug.match(/([a-z]{2,4})-([a-z]{2,4})-(\d{4}-\d{2}-\d{2})/i);
  return m ? `${m[1]}-${m[2]}-${m[3]}`.toLowerCase() : null;
}

/** Does a candidate event slug belong to the same match as the base slug? */
export function sameMatch(candidate: string, baseSlug: string, baseCore: string | null): boolean {
  if (!candidate) return false;
  if (candidate === baseSlug) return true;
  if (candidate.startsWith(`${baseSlug}-`)) return true;
  return baseCore != null && matchCore(candidate) === baseCore;
}

/** Numeric series/tag ids on a base event, used to discover sibling events. */
function collectGroupIds(event: any): { seriesIds: number[]; tagIds: number[] } {
  const seriesIds: number[] = [];
  const tagIds: number[] = [];
  for (const s of event?.series ?? []) {
    const id = Number(s?.id);
    if (Number.isFinite(id)) seriesIds.push(id);
  }
  for (const t of event?.tags ?? []) {
    const id = Number(t?.id);
    if (Number.isFinite(id)) tagIds.push(id);
  }
  return { seriesIds, tagIds };
}

/**
 * Find every Polymarket event for this match. The pasted slug is usually only
 * the match-winner market; the rest (exact score, totals, …) live in sibling
 * events. We discover them by (a) probing common slug suffixes and (b) querying
 * the base event's series/tag groups, keeping only events for the same match.
 */
async function discoverRelatedEvents(baseSlug: string, baseEvent: any): Promise<any[]> {
  const collected = new Map<string, any>();
  const add = (ev: any) => {
    if (ev?.slug && !collected.has(ev.slug)) collected.set(ev.slug, ev);
  };
  add(baseEvent);
  if (!config.polymarket.fetchRelated) return [...collected.values()];

  const baseCore = matchCore(baseSlug);
  let budget = config.polymarket.maxRelatedFetches;

  // (a) Targeted slug-suffix probing.
  const probeSlugs = config.polymarket.relatedSuffixes
    .map((suf) => `${baseSlug}${suf}`)
    .slice(0, budget);
  budget -= probeSlugs.length;
  const probed = await Promise.allSettled(
    probeSlugs.map((s) =>
      tryFetchEvents(`${config.polymarket.gammaUrl}/events?slug=${encodeURIComponent(s)}`),
    ),
  );
  for (const r of probed) {
    if (r.status !== "fulfilled") continue;
    for (const ev of r.value) if (sameMatch(ev.slug, baseSlug, baseCore)) add(ev);
  }

  // (b) Series / tag group discovery (filtered to this match).
  if (budget > 0) {
    const { seriesIds, tagIds } = collectGroupIds(baseEvent);
    const queries = [
      ...seriesIds.map((id) => `series_id=${id}`),
      ...tagIds.map((id) => `tag_id=${id}`),
    ].slice(0, budget);
    const grouped = await Promise.allSettled(
      queries.map((q) =>
        tryFetchEvents(`${config.polymarket.gammaUrl}/events?${q}&closed=false&limit=200`),
      ),
    );
    for (const r of grouped) {
      if (r.status !== "fulfilled") continue;
      for (const ev of r.value) if (sameMatch(ev.slug, baseSlug, baseCore)) add(ev);
    }
  }

  return [...collected.values()];
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
): { markets: Market[]; tokenIndex: Map<string, TokenRef>; tokenIds: string[]; stats: BuildStats } {
  const byKey = new Map<string, Market>();
  const tokenIndex = new Map<string, TokenRef>();
  const tokenIds: string[] = [];
  const unclassified: string[] = [];

  for (const rm of rawMarkets) {
    const classified = classifyPolymarketMarket(rm, teams);
    if (classified.length === 0 || classified.every((c) => c.type === "UNKNOWN")) {
      unclassified.push(rm.question ?? rm.groupItemTitle ?? "(unnamed market)");
    }
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

  const markets = [...byKey.values()];
  const byType: Record<string, number> = {};
  for (const m of markets) byType[m.type] = (byType[m.type] ?? 0) + 1;
  return { markets, tokenIndex, tokenIds, stats: { byType, unclassified } };
}

export async function fetchPolymarketEvent(slugOrUrl: string): Promise<PolymarketEvent> {
  const slug = extractSlug(slugOrUrl);
  const baseEvents = await fetchEventsBySlug(slug);
  const baseEvent = baseEvents[0];
  if (!baseEvent) {
    throw new Error(
      `No Polymarket event found for slug "${slug}". Double-check the link (it should look like https://polymarket.com/sports/.../<slug>).`,
    );
  }

  // Pull in the match's sibling events (exact score, totals, …) and merge them.
  const events = await discoverRelatedEvents(slug, baseEvent);
  const rawMarkets: RawPolymarketMarket[] = events.flatMap((e) =>
    Array.isArray(e.markets) ? e.markets : [],
  );

  const title: string = baseEvent.title ?? slug;
  const teams = resolveTeams(rawMarkets, slug, title);
  const { league, date } = parseSlug(slug);

  const meta: MatchMeta = {
    slug,
    title: title || `${teams.home} vs ${teams.away}`,
    teams,
    startDate: baseEvent.startDate ?? baseEvent.startTime ?? (date ? `${date}` : undefined),
    league: baseEvent.series?.[0]?.title ?? baseEvent.league ?? league,
    polymarketUrl: slugOrUrl.startsWith("http")
      ? slugOrUrl
      : `https://polymarket.com/event/${slug}`,
  };

  const { markets, tokenIndex, tokenIds, stats } = buildPolymarketMarkets(rawMarkets, teams);
  const eventSlugs = events.map((e) => e.slug);

  // Logging — this is what shows in `npm start` and tells us how to refine.
  console.log(
    `[polymarket] ${slug}: merged ${events.length} event(s), ${rawMarkets.length} raw market(s) → ${markets.length} canonical`,
  );
  console.log(`[polymarket]   events: ${eventSlugs.join(", ")}`);
  console.log(
    `[polymarket]   types: ${Object.entries(stats.byType).map(([k, v]) => `${k}:${v}`).join(", ") || "(none)"}`,
  );
  if (stats.unclassified.length) {
    console.log(
      `[polymarket]   unclassified (${stats.unclassified.length}): ${stats.unclassified.slice(0, 10).join(" | ")}`,
    );
  }

  return { meta, markets, tokenIndex, tokenIds, eventSlugs, stats };
}

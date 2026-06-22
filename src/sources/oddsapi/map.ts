/**
 * Map a The Odds API event-odds payload into our canonical markets.
 *
 * The Odds API returns one entry per bookmaker; we collapse them into a single
 * "oddsapi" book by keeping the BEST (highest) decimal price for each selection
 * across all bookmakers — i.e. the best price a bettor could actually get — and
 * record which book offered it (and how many quoted it) in the quote meta.
 */

import type { Market, Period, TeamInfo } from "../../types.js";
import { emptyMarket, makeQuote, marketKey, upsertQuote } from "../../normalize/markets.js";
import { classifyTeamSide } from "../../normalize/teams.js";

export interface OAOutcome { name: string; price: number; point?: number; description?: string }
export interface OAMarket { key: string; outcomes?: OAOutcome[] }
export interface OABook { key: string; title?: string; markets?: OAMarket[] }
export interface OAEvent {
  id: string;
  home_team?: string;
  away_team?: string;
  commence_time?: string;
  bookmakers?: OABook[];
}

interface Mapped {
  type: Market["type"];
  line?: number;
  period?: Period;
  selKey: string;
  selLabel: string;
  selOrder: number;
}

/** Translate one (market key, outcome) pair into a canonical selection, or null. */
function mapOutcome(oaKey: string, o: OAOutcome, teams: TeamInfo): Mapped | null {
  const half = oaKey.match(/_h([12])$/);
  const period: Period | undefined = half ? (half[1] === "1" ? "1H" : "2H") : undefined;
  const base = oaKey.replace(/_h[12]$/, "");
  const sideOf = (s: string) => classifyTeamSide(s, teams);

  if (base === "h2h") {
    const side = sideOf(o.name);
    if (side === "HOME") return { type: "MATCH_WINNER", period, selKey: "HOME", selLabel: teams.home, selOrder: 0 };
    if (side === "DRAW") return { type: "MATCH_WINNER", period, selKey: "DRAW", selLabel: "Draw", selOrder: 1 };
    if (side === "AWAY") return { type: "MATCH_WINNER", period, selKey: "AWAY", selLabel: teams.away, selOrder: 2 };
    return null;
  }
  if (base === "totals") {
    const over = /over/i.test(o.name);
    return {
      type: "TOTAL_GOALS", line: o.point, period,
      selKey: over ? "OVER" : "UNDER",
      selLabel: `${over ? "Over" : "Under"} ${o.point ?? ""}`.trim(),
      selOrder: over ? 0 : 1,
    };
  }
  if (base === "team_totals") {
    const side = sideOf(o.description ?? "");
    if (side !== "HOME" && side !== "AWAY") return null;
    const over = /over/i.test(o.name);
    return {
      type: side === "HOME" ? "TEAM_TOTAL_HOME" : "TEAM_TOTAL_AWAY", line: o.point, period,
      selKey: over ? "OVER" : "UNDER",
      selLabel: `${over ? "Over" : "Under"} ${o.point ?? ""}`.trim(),
      selOrder: over ? 0 : 1,
    };
  }
  if (base === "spreads") {
    const side = sideOf(o.name);
    if (side !== "HOME" && side !== "AWAY" || o.point == null) return null;
    // Express the line from the home team's perspective for a stable key.
    const homeLine = side === "HOME" ? o.point : -o.point;
    const teamLine = side === "HOME" ? homeLine : -homeLine;
    const name = side === "HOME" ? teams.home : teams.away;
    return {
      type: "SPREAD", line: homeLine, period,
      selKey: side, selLabel: `${name} ${teamLine > 0 ? "+" : ""}${teamLine}`,
      selOrder: side === "HOME" ? 0 : 1,
    };
  }
  if (base === "btts") {
    const yes = /^yes$/i.test(o.name);
    return { type: "BTTS", period, selKey: yes ? "YES" : "NO", selLabel: yes ? "Yes" : "No", selOrder: yes ? 0 : 1 };
  }
  return null;
}

export function buildOddsApiMarkets(ev: OAEvent, teams: TeamInfo): Market[] {
  // (marketKey, selKey) -> every book's price, so we can pick the best + count.
  const byKey = new Map<string, Market>();
  const prices = new Map<string, { decimal: number; book: string }[]>();
  const selMeta = new Map<string, { sel: Mapped; market: Market }>();

  for (const b of ev.bookmakers ?? []) {
    for (const m of b.markets ?? []) {
      for (const o of m.outcomes ?? []) {
        if (!(o.price > 1)) continue;
        const mapped = mapOutcome(m.key, o, teams);
        if (!mapped) continue;
        const mk = marketKey(mapped.type, mapped.line, mapped.period);
        let market = byKey.get(mk);
        if (!market) { market = emptyMarket(mapped.type, mapped.line, undefined, mapped.period); byKey.set(mk, market); }
        const id = `${mk}|${mapped.selKey}`;
        if (!prices.has(id)) prices.set(id, []);
        prices.get(id)!.push({ decimal: o.price, book: b.title ?? b.key });
        selMeta.set(id, { sel: mapped, market });
      }
    }
  }

  for (const [id, list] of prices) {
    const { sel, market } = selMeta.get(id)!;
    const best = list.reduce((a, b) => (b.decimal > a.decimal ? b : a));
    upsertQuote(
      market,
      { key: sel.selKey, label: sel.selLabel, order: sel.selOrder },
      makeQuote("oddsapi", { decimal: best.decimal, meta: { book: best.book, books: list.length } }),
    );
  }

  return [...byKey.values()];
}

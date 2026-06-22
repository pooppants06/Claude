/**
 * Unified domain model.
 *
 * Both Polymarket and Norsk Tipping are normalised into this shape so the
 * comparison engine never has to know where the odds came from. A "market"
 * is one bet type (e.g. Match Winner, Total Goals 2.5). A "selection" is one
 * pickable outcome within it (e.g. Home, Over, "2-1").
 */

export type SourceId = "polymarket" | "norsktipping" | "oddsapi";

/**
 * Canonical bet-type identifiers. The string values are stable keys used for
 * matching the same market across the two books.
 */
export type CanonicalMarketType =
  | "MATCH_WINNER" // 1X2 (Home / Draw / Away)
  | "DOUBLE_CHANCE" // 1X / 12 / X2
  | "DRAW_NO_BET" // Home or Away, stake back on draw
  | "BTTS" // Both teams to score (Yes / No)
  | "TOTAL_GOALS" // Over / Under a goal line
  | "TEAM_TOTAL_HOME" // Home team Over / Under
  | "TEAM_TOTAL_AWAY" // Away team Over / Under
  | "SPREAD" // Goal handicap (home-team line; e.g. -1.5)
  | "ODD_EVEN" // Total goals odd or even
  | "CORRECT_SCORE" // Exact final score
  | "HT_RESULT" // Half-time 1X2 (legacy; superseded by period="1H")
  | "HT_FT" // Half-time / Full-time combination
  | "FIRST_HALF_GOALS" // Over / Under goals in first half (legacy)
  | "FIRST_TEAM_TO_SCORE" // Which team scores first (Home / Away / Neither)
  | "ANYTIME_GOALSCORER" // A named player to score at any time
  | "FIRST_GOALSCORER" // A named player to score first
  | "UNKNOWN"; // Could not be classified; shown verbatim

/**
 * Match segment a market applies to. Undefined means the full match. Lets the
 * same bet type (totals, BTTS, team totals, result) exist once per segment
 * without colliding — Polymarket lists all three.
 */
export type Period = "1H" | "2H";

/** A single price for one selection from one book. */
export interface Quote {
  source: SourceId;
  /** Decimal odds (what 1 unit returns, stake included). null if unavailable. */
  decimal: number | null;
  /** Raw implied probability from this book's price (includes the book's vig). */
  impliedProb: number | null;
  updatedAt: number;
  /** Source-specific extras, kept for debugging / drill-down. */
  meta?: Record<string, unknown>;
}

/** One pickable outcome within a market, with a quote per book. */
export interface Selection {
  /** Canonical, source-independent key (e.g. "HOME", "OVER", "2-1", "p:messi"). */
  key: string;
  label: string;
  /** Optional ordering hint for stable display. */
  order?: number;
  quotes: Partial<Record<SourceId, Quote>>;
}

/** One bet type, holding all of its selections. */
export interface Market {
  type: CanonicalMarketType;
  /** Goal line for totals/handicaps (e.g. 2.5, or -1.5 for a spread). */
  line?: number;
  /** Match segment; undefined = full match. */
  period?: Period;
  /** Free-form discriminator for source-specific markets that have no canonical
   *  type (e.g. Norsk Tipping corners/cards) so they keep distinct keys. */
  variant?: string;
  /** Human label, e.g. "Total Goals — Over/Under 2.5". */
  label: string;
  /** Stable de-duplication key, e.g. "TOTAL_GOALS@2.5" or "BTTS#1H". */
  key: string;
  selections: Selection[];
  /** Which books contributed at least one quote to this market. */
  sources: SourceId[];
}

export interface TeamInfo {
  home: string;
  away: string;
  homeCode?: string;
  awayCode?: string;
}

export interface MatchMeta {
  slug: string;
  title: string;
  teams: TeamInfo;
  startDate?: string;
  league?: string;
  polymarketUrl: string;
}

/** A bundle of markets coming from one source. */
export interface SourceOdds {
  source: SourceId;
  fetchedAt: number;
  markets: Market[];
}

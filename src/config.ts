/**
 * Centralised runtime configuration. Reads from environment variables with
 * safe defaults so the app runs with zero configuration.
 */

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export type NorskTippingProvider = "mock" | "http" | "oddsen";
export type PolymarketProvider = "gamma" | "demo";

// Polymarket splits one match across several events (the pasted slug is usually
// just the match-winner market). These suffixes are appended to the base slug to
// discover the sibling events (exact score, totals, …). Refine via env once we
// see the real slugs in the logs / debug endpoint.
const DEFAULT_RELATED_SUFFIXES = [
  // Polymarket packs spreads, totals, team totals, BTTS and the half markets
  // into one "-more-markets" sibling event; the rest are their own events.
  "-more-markets",
  "-exact-score", "-correct-score", "-total-goals", "-total", "-over-under",
  "-both-teams-to-score", "-btts", "-double-chance", "-draw-no-bet",
  "-halftime-result", "-half-time-result", "-second-half-result",
  "-half-time", "-halftime", "-first-half", "-1st-half", "-2nd-half",
  "-odd-even", "-clean-sheet", "-to-score", "-first-to-score",
  "-anytime-goalscorer", "-first-goalscorer", "-player-to-score",
].join(",");

export const config = {
  port: num("PORT", 3000),
  snapshotIntervalMs: num("SNAPSHOT_INTERVAL_MS", 1000),

  polymarket: {
    // "gamma" = real public API (default). "demo" = synthesise an offline book
    // from the slug so the UI works with no internet / when Polymarket is blocked.
    provider: env("POLYMARKET_PROVIDER", "gamma") as PolymarketProvider,
    // If a real Gamma fetch fails, fall back to the demo book instead of erroring.
    demoOnError: env("POLYMARKET_DEMO_ON_ERROR", "false") === "true",
    gammaUrl: env("POLYMARKET_GAMMA_URL", "https://gamma-api.polymarket.com"),
    wsUrl: env(
      "POLYMARKET_WS_URL",
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    ),
    demoJitterMs: num("POLYMARKET_DEMO_JITTER_MS", 2500),
    // Discover & merge the match's sibling events (exact score, totals, …).
    fetchRelated: env("POLYMARKET_FETCH_RELATED", "true") !== "false",
    relatedSuffixes: env("POLYMARKET_RELATED_SLUGS", DEFAULT_RELATED_SUFFIXES)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxRelatedFetches: num("POLYMARKET_MAX_RELATED", 28),
  },

  norskTipping: {
    // "oddsen" = real public Oddsen API (recommended), "http" = your own proxy
    // returning the canonical contract, "mock" = offline simulation.
    provider: env("NORSKTIPPING_PROVIDER", "mock") as NorskTippingProvider,
    httpUrl: env("NORSKTIPPING_HTTP_URL", ""),
    httpHeaders: parseHeaders(env("NORSKTIPPING_HTTP_HEADERS", "")),
    oddsenUrl: env("NORSKTIPPING_ODDSEN_URL", "https://api.norsk-tipping.no/OddsenGameInfo/v1/api"),
    pollMs: num("NORSKTIPPING_POLL_MS", 4000),
  },

  // The Odds API (https://the-odds-api.com) — real third source aggregating
  // dozens of bookmakers. Enabled only when ODDS_API_KEY is set. Quota is
  // limited (cost = markets × regions per refresh), so it polls slowly.
  oddsApi: {
    apiKey: env("ODDS_API_KEY", ""),
    baseUrl: env("ODDS_API_BASE_URL", "https://api.the-odds-api.com/v4"),
    // Sport key; defaults to the World Cup since the app is World-Cup-centric.
    sport: env("ODDS_API_SPORT", "soccer_fifa_world_cup"),
    regions: env("ODDS_API_REGIONS", "eu,uk"),
    // Markets we can map to canonical types (kept lean to save quota).
    markets: env(
      "ODDS_API_MARKETS",
      "h2h,totals,spreads,btts,h2h_h1,h2h_h2,totals_h1,totals_h2,team_totals",
    ),
    pollMs: num("ODDS_API_POLL_MS", 120000),
  },
};

function parseHeaders(raw: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  } catch {
    console.warn("[config] NORSKTIPPING_HTTP_HEADERS is not valid JSON; ignoring.");
  }
  return {};
}

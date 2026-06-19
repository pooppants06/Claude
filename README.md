# OddsEdge — Polymarket vs Norsk Tipping

Paste a **Polymarket** soccer-match link and OddsEdge pulls that match's odds,
lines them up against **Norsk Tipping**'s book, and shows **which bet types have
the biggest odds differences** — updating **live** as prices move.

It compares every market the two books share: Match Winner (1X2), Double Chance,
Draw No Bet, Both Teams To Score, Total Goals (multiple lines), First-Half goals,
Half-Time result, Odd/Even, Correct Score, Half-Time/Full-Time and Anytime
Goalscorer. Markets only one book offers are shown too (clearly tagged), so you
always see the full picture.

![flow](https://img.shields.io/badge/Polymarket-CLOB%20WebSocket-6f7bff) ![flow](https://img.shields.io/badge/Norsk%20Tipping-Oddsen-19c37d)

---

## Quick start

```bash
npm install
npm start
# open http://localhost:3000  →  paste a Polymarket link  →  "Compare odds"
```

Example links (from the brief):

```
https://polymarket.com/sports/world-cup/fifwc-usa-aus-2026-06-19
https://polymarket.com/sports/world-cup/fifwc-sco-mar-2026-06-19
https://polymarket.com/sports/world-cup/fifwc-bra-hai-2026-06-19
```

> **Just want to see it work, offline?**
> `POLYMARKET_PROVIDER=demo npm start` synthesises both books locally — no
> internet required. Great for a first look or a blocked network.

---

## How it works

```
 Browser (live dashboard)
    │  POST /api/track {url}        WS /stream?slug=…  (live snapshots)
    ▼
 Express + WebSocket server  ──►  Tracker (one per match)
                                    ├── PolymarketSource
                                    │     ├── Gamma REST  (event + markets by slug)
                                    │     └── CLOB WS      (live prices per token)
                                    └── NorskTippingSource
                                          ├── mock  (default, full Oddsen-style book)
                                          └── http  (your real endpoint / proxy)
                                    └── Comparison engine → ranked snapshot
```

1. **Resolve the match.** The slug is taken from the URL
   (`…/fifwc-bra-hai-2026-06-19`) and looked up on Polymarket's public **Gamma
   API** (`/events?slug=…`). Team names are resolved from the event and the slug.
2. **Normalise.** Both books are mapped into one canonical model
   (`src/types.ts`) so a "Total Goals 2.5 — Over" from either side lines up.
   Polymarket prices are probabilities, converted to decimal odds (`1 / price`);
   Norsk Tipping odds are decimal already.
3. **Go live.** Polymarket prices stream over the CLOB **market WebSocket**
   (`book` / `price_change` events). Norsk Tipping is polled on an interval. Any
   move recomputes the comparison and pushes a fresh snapshot to the browser.
4. **Compare & rank.** For every shared selection we compute the odds gap and a
   vig-removed "fair" value, then sort bet types by the **largest difference**.

### Reading the dashboard

| Column / term | Meaning |
|---|---|
| **Polymarket / Norsk Tipping** | Decimal odds; small % underneath is that book's implied probability (includes its margin). |
| **Diff** | How much higher the better book's decimal odds are for that pick (relative %). Bigger = more disagreement. |
| **Value** | The book paying more, with an estimated **edge** vs the two-book consensus probability (after removing each book's vig). |
| **Biggest odds differences** | Top picks across all markets, ranked by Diff — the headline of the app. |
| Market tags | `both books`, `Polymarket only` / `Norsk Tipping only`, and the market's `max diff`. |

---

## Data sources — important & honest

**Polymarket** has a documented public API, so that side is real:
- REST: `https://gamma-api.polymarket.com/events?slug=<slug>`
- WebSocket: `wss://ws-subscriptions-clob.polymarket.com/ws/market`

**Norsk Tipping has no public odds API.** Their sportsbook runs on Sportradar's
ORAKO platform, and odds are served from internal endpoints that require their
own session/keys. So OddsEdge ships with a **pluggable Norsk Tipping adapter**
and three honest options:

| `NORSKTIPPING_PROVIDER` | What you get |
|---|---|
| `mock` *(default)* | A realistic, self-contained Oddsen-style book generated from a single Monte-Carlo simulation of the match — internally consistent across **all** market types, with a bookmaker margin, and it drifts live. Lets you run and demo everything with zero setup. |
| `http` | Real odds from a JSON endpoint **you** provide (see below). |

### Wiring real Norsk Tipping odds (`http` mode)

Set `NORSKTIPPING_PROVIDER=http` and `NORSKTIPPING_HTTP_URL`. There are two paths:

1. **Easiest — return the canonical contract.** Stand up a tiny proxy/scraper
   that outputs the JSON shape documented at the top of
   `src/sources/norsktipping/orako.ts`:

   ```json
   {
     "markets": [
       { "type": "MATCH_WINNER",
         "selections": [
           { "key": "HOME", "label": "Brazil", "decimal": 1.55 },
           { "key": "DRAW", "label": "Draw",   "decimal": 4.10 },
           { "key": "AWAY", "label": "Haiti",  "decimal": 6.50 }
         ] }
     ]
   }
   ```
   OddsEdge consumes this directly.

2. **Point straight at Norsk Tipping.** Open a match on
   [norsk-tipping.no/sport](https://www.norsk-tipping.no/sport) with your
   browser's **DevTools → Network** tab, find the JSON request that carries the
   odds, and use that URL/headers. Then implement `parseRawOrako()` in
   `src/sources/norsktipping/orako.ts` to map their payload (the function is
   stubbed with guidance). If a real call fails, OddsEdge **falls back to the
   mock** so the dashboard never goes blank.

> The canonical selection keys to match are listed in `src/types.ts`
> (`HOME/DRAW/AWAY`, `OVER/UNDER`, `YES/NO`, `"2-1"`, `1X/12/X2`, `ODD/EVEN`,
> `"1/1"…"2/2"`, `p:<player>`).

---

## Configuration

All optional — copy `.env.example` to `.env` to change anything.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `SNAPSHOT_INTERVAL_MS` | `1000` | Max push rate to the browser |
| `POLYMARKET_PROVIDER` | `gamma` | `gamma` (real) or `demo` (offline) |
| `POLYMARKET_DEMO_ON_ERROR` | `false` | Use the demo book if a real fetch fails |
| `NORSKTIPPING_PROVIDER` | `mock` | `mock` or `http` |
| `NORSKTIPPING_HTTP_URL` | — | Endpoint template (`{slug}`,`{home}`,`{away}`) for `http` mode |
| `NORSKTIPPING_HTTP_HEADERS` | — | JSON object of extra request headers |
| `NORSKTIPPING_POLL_MS` | `4000` | Norsk Tipping refresh interval |

---

## Project structure

```
src/
  server.ts                 HTTP + WebSocket hub
  tracker.ts                One live match: both feeds → debounced snapshots
  types.ts                  Canonical domain model
  config.ts                 Env config
  normalize/                Team-name + odds-math helpers
  sources/
    polymarket/             Gamma REST, CLOB WebSocket, market classifier, demo
    norsktipping/           mock generator, real HTTP adapter, provider switch
  compare/compare.ts        Merge + diff + vig-removal + ranking
  public/                   Single-page dashboard (no build step)
test/pipeline.test.ts       Offline tests for the whole pipeline
```

## Scripts

```bash
npm start       # run the server (tsx, no build step)
npm run dev     # run with auto-reload
npm test        # unit tests (offline, no network)
npm run typecheck
```

## Troubleshooting: "Polymarket is missing exact score / over-under / etc."

Polymarket splits a single match across **several events** — the link you paste
is usually just the **match-winner** market, while exact score, totals,
player-to-score and so on are **separate events** with their own slugs (e.g.
`…-exact-score`). The app discovers and merges these automatically
(`POLYMARKET_FETCH_RELATED=true`).

If some are still missing, the sibling slug didn't match the built-in suffix
list. To see exactly what Polymarket returns for a match, open:

```
http://localhost:3000/api/debug/polymarket?slug=<the-slug>
```

It lists every event/market found and anything that couldn't be classified. Add
any missing suffixes via `POLYMARKET_RELATED_SLUGS` in `.env` (no code change
needed). The same summary is printed to the terminal on every match load.

## Notes & limitations

- Odds comparison is for information only — not betting advice.
- Polymarket lists fewer markets for soccer than a full sportsbook, so expect
  several "Norsk Tipping only" rows; that's expected and handled.
- The `mock`/`demo` providers are clearly labelled in the UI (`sample (mock)`,
  `demo (offline)`) so synthetic data is never mistaken for live odds.
```

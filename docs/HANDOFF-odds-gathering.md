# Hand-off: How the odds are gathered

This document explains, end to end, how OddsEdge collects betting odds from the
three sources, reconciles them onto a common model, removes the bookmaker
margin, and produces the per-match and combined comparisons. It is written for
whoever picks this project up next.

The whole thing is a **comparison engine**: pull the same match's prices from a
sharp prediction market (Polymarket), a soft retail bookmaker (Norsk Tipping),
and a ~40-book aggregator (The Odds API); convert everything to one canonical
shape; strip the vig; and rank where the prices disagree.

---

## 1. The three sources at a glance

| Source | What it is | Role | Auth | Freshness |
|---|---|---|---|---|
| **Polymarket** | Real-money prediction market (Polygon) | The "sharp" reference price | none (public) | live |
| **Norsk Tipping** | Norwegian state bookmaker (Oddsen) | A soft/retail book, for context | none (public) | live |
| **The Odds API** | Aggregator of ~40 bookmakers | The "market consensus" (de-vigged) | API key | snapshot |

Polymarket and Norsk Tipping are fetched **live on every refresh** (free).
The Odds API is **rate-limited**, so we pull it deliberately and cache it.

---

## 2. Polymarket (Gamma API)

**Base:** `https://gamma-api.polymarket.com`
**Code:** `src/sources/polymarket/gamma.ts`, `classify.ts`, `ws.ts`

### Discovery
- World Cup events carry tag id **`102232`**:
  `GET /events?tag_id=102232&closed=false&limit=500`
- Each match is a slug: **`fifwc-{home}-{away}-{YYYY-MM-DD}`** (3-letter codes,
  e.g. `fifwc-che-can-2026-06-24`).
- **Kickoff time** is on the event as **`gameStartTime`** (and on its markets).
  The event `startDate` is the *listing* date (often months earlier) — **do not
  sort by it**. `scripts/fetch-slate.mjs` sorts by `gameStartTime` to get the
  true "next N" matches.

### One match = several events (must be merged)
Polymarket splits a single match across multiple sibling events. The slug you
paste is usually just the moneyline; totals, exact score, halves, first-to-score
live in separate events discovered by appending suffixes (see
`DEFAULT_RELATED_SUFFIXES` in `src/config.ts`): `-more-markets`, `-exact-score`,
`-halftime-result`, `-second-half-result`, `-first-to-score`, etc.
`fetchPolymarketEvent()` discovers and **merges** them into one canonical set.

### Per-market fields we use
From each Gamma market object:
- `outcomes`, `outcomePrices` (stringified JSON arrays) → implied prices
- `clobTokenIds` → the **ERC-1155 token id per selection** (this is the bridge
  to actually placing an order on the CLOB)
- `bestBid` / `bestAsk` / `spread` → the **order-book spread** (surfaced as the
  "Spread" column; see `classify.ts`, threaded into the quote `meta`)

Prices are the Gamma mid; the WS feed (`ws.ts`) can refresh live level-2 mids.

### Gotchas
- **Team-total vs match-total collisions.** A "Bosnia & Herzegovina O/U 2.5"
  market can be mistaken for the full-match total. Fixed in `teams.ts`
  (`normalizeKey` drops connectors like "and"/"&") and `classifyTeamSide`.
- **Home/away orientation differs between books** — see §5.

---

## 3. Norsk Tipping (Oddsen API)

**Base:** `https://api.norsk-tipping.no/OddsenGameInfo/v1/api`
**Code:** `src/sources/norsktipping/oddsen.ts`

### Endpoints
- Pre-match list: `GET /events/{sportId}/{from}/{to}` where `sportId = FBL`
  (football). The time window must end at `2359`.
- **Live (in-play): `GET /liveevents/FBL`** — when a match kicks off, Norsk
  Tipping moves it to a *separate live feed under a NEW event id*. If you only
  read the pre-match feed it looks like the match vanished. `resolveEventId`
  falls back to the live feed.
- Markets for an event: `GET /markets/{eventId}`.

### Gotchas
- **Norwegian team names**: Tyrkia→Türkiye, Skottland→Scotland, Sør-Afrika→South
  Africa, Elfenbenskysten→Côte d'Ivoire, etc. Handled by `TEAM_ALIASES` in
  `src/normalize/teams.ts`.
- **Home/away can be reversed** vs Polymarket — `buildOrientation()` computes a
  `flip` flag so selections line up (see §5).
- Within-NT market-name matching uses the *raw Norwegian* spelling
  (`normalizeKey`, no aliasing), because a long market-name string keeps its
  native spelling while a bare team name would be canonicalised.

---

## 4. The Odds API (aggregator)

**Base:** `https://api.the-odds-api.com/v4` · **sport:** `soccer_fifa_world_cup`
**Code:** `src/sources/oddsapi/index.ts`, `map.ts`; pull script
`scripts/fetch-oddsapi.mjs`

### Two kinds of request
1. **Bulk** (one call, all events, *featured* markets only):
   `GET /sports/soccer_fifa_world_cup/odds?regions=eu,uk&markets=h2h,totals`
2. **Per-event** (additional markets):
   `GET /sports/soccer_fifa_world_cup/events/{id}/odds?regions=eu,uk&markets=alternate_totals,btts,h2h_h1,totals_h1`

### Cost / quota (important)
- **Cost = (markets × regions) per request.** Header **`x-requests-remaining`**
  reports the monthly balance (free tier = **500**).
- A full 5-match pull ≈ `4` (bulk) + `5 × 8` (per-event) ≈ **44 credits**, so one
  key ≈ **10 full refreshes**. Rotate keys when low.
- **Not available for soccer:** first-to-score, 2nd-half markets. Coverage is
  deep on h2h (~40 books) and main totals (~13), thin (2–3 books) on btts,
  halves and alternate totals — **the book count matters for trust**.
- Transient proxy `403`s happen on per-event calls; the script retries 3×.

The API key is read from `ODDS_API_KEY` (env) — **never hard-code it**.

---

## 5. Normalisation — putting three books on one model

**Code:** `src/normalize/teams.ts`, `src/normalize/markets.ts`

### Team identity
- `normalizeKey(name)` — lowercase, strip accents (ø→o, æ→ae, å→a), drop
  connectors. Used for **matching within a single book**.
- `teamKey(name)` — `normalizeKey` + cross-language aliases. Used for **matching
  across books** (Norwegian↔English↔FIFA-code).
- A small `EXTRA` map in the scripts folds remaining Odds-API spellings
  (Ivory Coast→Côte d'Ivoire, Czech Republic→Czechia, Turkey→Türkiye).

### Canonical markets
Every selection is keyed by a stable string (`marketKey()`):
`MATCH_WINNER`, `DOUBLE_CHANCE`, `BTTS`, `TOTAL_GOALS@{line}`, plus a period
suffix `#1H` for first-half variants (e.g. `TOTAL_GOALS@2.5#1H`).

### Orientation (the recurring bug)
Polymarket, Norsk Tipping and the Odds API **don't agree on which team is
"home"**. For totals/BTTS this doesn't matter (Over/Under/Yes/No are symmetric),
but for the **match winner you must join by TEAM IDENTITY, not by position** —
otherwise the favourite gets paired with the underdog's odds. Every join maps a
selection's team through `norm()` and asks "is this OA's home or away?" rather
than assuming HOME==HOME. (This bit us on Curaçao vs Côte d'Ivoire repeatedly.)

---

## 6. De-vigging — recovering "true" probabilities

Bookmaker odds include an over-round (margin). We strip it three ways:

1. **Shin (1993)** — `src/normalize/shin.ts`. Models a fraction *z* of insider
   traders; corrects the favourite–longshot bias (shrinks longshots more than a
   flat rescale). This is the default de-vig for both NT and the Odds API.
   - **NT-Shin** = Shin applied to Norsk Tipping's odds.
   - **OA-Shin (the "regular" definition used in the comparison)** = take the
     **average decimal odds across all ~40 books** per selection, then Shin.
     See `buildEventOA()` in `compare5.ts`.

2. **Per-book sharp-weighted consensus** — `src/normalize/devig.ts`. The more
   accurate method: de-vig **each book individually**, then take a
   **weighted mean of probabilities** (Pinnacle / Betfair exchange weighted
   higher than soft books). Reports dispersion + effective coverage (`effN`).
   Used by `accurate.ts`.

3. **Dixon–Coles bivariate-Poisson goal model** — `src/model/poisson.ts`. Fits
   (λ_home, λ_away, ρ) to a match's deep markets (1X2 + totals) so every line is
   *coherent* and thin lines borrow strength from deep ones. Used by
   `accurate.ts` for the "best estimate" blend.

> The per-match / combined sheets in the recent work use **OA-Shin (method 1)**.
> `accurate.ts` is the more sophisticated estimator (methods 2 + 3).

---

## 7. Comparison & the EV metric

**Code:** `src/compare/compare.ts` (`compareMarkets` → `ComparisonSnapshot`).

For each canonical selection we line up: PM odds, PM spread, OA-Shin odds (+book
count), NT odds, NT-Shin odds.

**EV** (the "value" number) is the edge from backing the bet on Polymarket if the
OA-Shin consensus is the true price:

```
EV = (PM decimal odds) / (OA-Shin decimal odds) − 1
```

Positive EV = Polymarket pays *longer* than fair. It is a **relative** measure,
so a small gap on a longshot can outrank a larger gap on a favourite — which is
why deep longshots (50:1 totals on 3 books) can show huge but meaningless EV.
**Always read EV alongside the book count and spread.**

A de-vig only counts a book toward the consensus if it covers the **full**
outcome space (`coversAll` guard in `compare.ts`) — otherwise a one-sided quote
(e.g. NT lists Over but not Under) poisons the fair probabilities.

---

## 8. Running a refresh (the actual workflow)

Everything writes to `/tmp` (scratch) and renders PNG tables via puppeteer.

```bash
# 1. Discover the next-5 slate by real kickoff time → /tmp/multi/slate.json
node scripts/fetch-slate.mjs                 # N=8 CUTOFF=2026-06-25 to override

# 2. Pull The Odds API for that slate (spends ~44 credits) → /tmp/oa5_bulk.json + /tmp/oa5_ev/
ODDS_API_KEY=your_key node scripts/fetch-oddsapi.mjs

# 3. Build the comparison: fetches PM + NT live, joins to the cached OA data
#    → /tmp/multi/compare5.json
PUPPETEER_CACHE_DIR=/tmp/pptr-cache npx tsx compare5.ts

# 4. Render the per-match tables (one PNG per match, sorted by EV)
PUPPETEER_CACHE_DIR=/tmp/pptr-cache npx tsx render-compare5.ts

# 5. Render the combined sheet (all matches, every positive-EV row, sorted)
PUPPETEER_CACHE_DIR=/tmp/pptr-cache npx tsx render-top-combined.ts
```

**Cheap refresh (conserve quota):** skip step 2 — steps 3–5 reuse the cached
Odds-API data while still pulling Polymarket + Norsk Tipping live. The ~40-book
consensus barely moves minute-to-minute, so this is fine between full pulls.

### Other entry points
- `accurate.ts` — the model-based best-estimate EV ranking (per-book devig +
  Poisson), across all upcoming matches. Renders via `render-accurate.ts`.
- `trade.ts` / `src/trade-server.ts` — turn picks into Polymarket orders with
  manual approval (see the trading `.env` keys in `.env.example`).

---

## 9. Lessons learned (read before changing things)

- **Sort matches by `gameStartTime`, never `startDate`.** The latter is the
  listing date and silently gives the wrong slate.
- **Join the match winner by team identity, not home/away position.** The three
  books disagree on orientation; position joins swap favourite/underdog.
- **A de-vig needs the full outcome space.** Guard against one-sided coverage.
- **Average probabilities, not decimal odds** (`1/x` is convex). The "regular"
  OA-Shin averages odds for simplicity; `devig.ts` does it correctly.
- **Book count is the trust signal.** Big EV on a 3-book, 50:1 line is noise.
- **The Odds API has no first-to-score and no 2nd-half markets for soccer** —
  don't try to model what there's no data for.
- **Quota is real.** ~44 credits per full 5-match pull; rotate keys.

---

## 10. File map

```
src/sources/polymarket/      Gamma fetch, market classification, WS live prices
src/sources/norsktipping/    Oddsen pre-match + live feeds
src/sources/oddsapi/         The Odds API client
src/normalize/teams.ts       Team-name aliasing + side classification
src/normalize/markets.ts     Canonical market keys + odds math
src/normalize/shin.ts        Shin de-vig
src/normalize/devig.ts       Per-book sharp-weighted consensus
src/model/poisson.ts         Dixon–Coles goal model
src/compare/compare.ts       compareMarkets → ComparisonSnapshot
scripts/fetch-slate.mjs      Discover next-N slate (kickoff order)
scripts/fetch-oddsapi.mjs    Pull + cache The Odds API for the slate
compare5.ts                  Build the per-match comparison (PM+NT live + OA cache)
render-compare5.ts           Per-match PNG tables (EV-sorted)
render-top-combined.ts       Combined all-positive-EV PNG sheet
accurate.ts                  Model-based best-estimate EV ranking
trade.ts / src/trade-server  Manual-approve Polymarket order placement + dashboard
```

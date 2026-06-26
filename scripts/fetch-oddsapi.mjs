/**
 * Pull The Odds API data for the matches in slate.json and cache it for
 * compare5.ts. Reads the API key from the env (NEVER hard-code it).
 *
 *   ODDS_API_KEY=xxxx node scripts/fetch-oddsapi.mjs
 *
 * Cost model: each request costs (markets × regions) credits, and the response
 * header `x-requests-remaining` reports your monthly balance (free tier = 500).
 *   - 1 bulk call:   h2h,totals × eu,uk           = 4 credits, returns ALL events
 *   - 1 per-event:   4 markets   × eu,uk           = 8 credits each
 * So a full 5-match pull ≈ 4 + 5×8 = ~44 credits ≈ 10 full refreshes per key.
 *
 * Output:
 *   /tmp/oa5_bulk.json        ← the 5 matched events with h2h + totals
 *   /tmp/oa5_ev/<id>.json     ← per-event alternate_totals, btts, h2h_h1, totals_h1
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const KEY = process.env.ODDS_API_KEY;
if (!KEY) { console.error("Set ODDS_API_KEY in the environment."); process.exit(1); }
const SPORT = "soccer_fifa_world_cup";
const REGIONS = process.env.OA_REGIONS ?? "eu,uk";
const EVENT_MARKETS = process.env.OA_EVENT_MARKETS ?? "alternate_totals,btts,h2h_h1,totals_h1";
const SLATE = process.env.SLATE_PATH ?? "/tmp/multi/slate.json";

// Fold spelling differences so Odds-API team names line up with Polymarket's.
const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
const ALIAS = { turkey: "turkiye", unitedstates: "usa", czechrepublic: "czechia", ivorycoast: "cotedivoire", bosniaherzegovina: "bosnia", korearepublic: "southkorea", capeverde: "caboverde", iriran: "iran", iran: "iran" };
const k = (s) => { const x = norm(s); return ALIAS[x] ?? x; };

const slate = JSON.parse(readFileSync(SLATE, "utf8"));
const want = slate.map((s) => [k(s.home), k(s.away)].sort().join("|"));

async function gj(u) { const r = await fetch(u); return { ok: r.ok, status: r.status, rem: r.headers.get("x-requests-remaining"), body: r.ok ? await r.json() : await r.text() }; }

// 1) One bulk call returns every event with the featured markets (h2h, totals).
const bulk = await gj(`https://api.the-odds-api.com/v4/sports/${SPORT}/odds?apiKey=${KEY}&regions=${REGIONS}&markets=h2h,totals&oddsFormat=decimal`);
if (!bulk.ok) { console.error("bulk FAIL", bulk.status, String(bulk.body).slice(0, 200)); process.exit(1); }

const pick = bulk.body.filter((e) => want.includes([k(e.home_team), k(e.away_team)].sort().join("|")));
console.log(`bulk: ${bulk.body.length} events, matched ${pick.length}/${slate.length}, quota ${bulk.rem}`);
pick.forEach((e) => console.log(`  ${e.id}  ${e.home_team} vs ${e.away_team}  ${e.bookmakers.length}bk`));
const missing = want.filter((w) => !pick.some((e) => [k(e.home_team), k(e.away_team)].sort().join("|") === w));
if (missing.length) console.log("  MISSING:", missing.join("  "));

writeFileSync("/tmp/oa5_bulk.json", JSON.stringify(pick));
mkdirSync("/tmp/oa5_ev", { recursive: true });

// 2) Per-event call adds the additional markets the bulk endpoint can't return.
let rem = bulk.rem;
for (const e of pick) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const pe = await gj(`https://api.the-odds-api.com/v4/sports/${SPORT}/events/${e.id}/odds?apiKey=${KEY}&regions=${REGIONS}&markets=${EVENT_MARKETS}&oddsFormat=decimal`);
    if (pe.ok) { writeFileSync(`/tmp/oa5_ev/${e.id}.json`, JSON.stringify(pe.body)); rem = pe.rem; break; }
    if (attempt === 2) console.log(`  per-event FAIL ${e.id} ${pe.status}`); // transient proxy 403s happen; 3 tries
  }
}
console.log(`done. quota remaining ~ ${rem}`);

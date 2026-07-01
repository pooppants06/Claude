/**
 * Discover the upcoming FIFA World Cup match slate from Polymarket and write the
 * next N matches (by real kickoff time) to slate.json, which compare5.ts reads.
 *
 *   node scripts/fetch-slate.mjs            # next 5, cutoff = today
 *   N=8 CUTOFF=2026-06-25 node scripts/fetch-slate.mjs
 *
 * Output: /tmp/multi/slate.json  →  [{ slug, gst, home, away, title }]
 *
 * Why kickoff time (gameStartTime), not the slug date: Polymarket lists several
 * matches on the same calendar day, and the event `startDate` is the LISTING
 * date (months earlier), not kickoff. Sorting by gameStartTime is the only way
 * to get the true "next 5".
 */
import { writeFileSync, mkdirSync } from "node:fs";

const TAG_FIFA_WC = 102232;
const N = Number(process.env.N ?? "5");
// Default cutoff = today (UTC). Only override via CUTOFF for backfills/testing.
const CUTOFF = process.env.CUTOFF ?? new Date().toISOString().slice(0, 10);
const OUT = process.env.SLATE_PATH ?? "/tmp/multi/slate.json";

async function gj(u) { const r = await fetch(u, { headers: { accept: "application/json" } }); return r.ok ? r.json() : null; }

const b = await gj(`https://gamma-api.polymarket.com/events?tag_id=${TAG_FIFA_WC}&closed=false&limit=500`);
if (!b) { console.error("gamma fetch failed"); process.exit(1); }

const re = /^fifwc-([a-z]+)-([a-z]+)-(\d{4}-\d{2}-\d{2})$/;
const seen = new Set();
const rows = [];
for (const e of b) {
  const m = (e.slug || "").match(re);
  if (!m || seen.has(e.slug)) continue;
  seen.add(e.slug);
  const gst = e.gameStartTime || (e.markets || []).map((x) => x.gameStartTime).find(Boolean) || (m[3] + "T99:00:00+00");
  const t = (e.title || "").split(/\s+vs\.?\s+/i);
  rows.push({ slug: e.slug, gst, home: (t[0] || "").trim(), away: (t[1] || "").trim(), title: e.title });
}
rows.sort((a, b) => String(a.gst).localeCompare(String(b.gst)));
const upcoming = rows.filter((r) => r.gst >= CUTOFF);

let next;
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS ?? "0");
if (WINDOW_HOURS > 0 && upcoming.length) {
  // All matches kicking off within WINDOW_HOURS of the soonest upcoming one.
  const parse = (g) => Date.parse(String(g).replace(" ", "T").replace(/\+00$/, "+00:00"));
  const start = parse(upcoming[0].gst);
  const end = start + WINDOW_HOURS * 3600 * 1000;
  next = upcoming.filter((r) => { const t = parse(r.gst); return t >= start && t < end; });
} else {
  next = upcoming.slice(0, N);
}

mkdirSync(OUT.replace(/\/[^/]+$/, ""), { recursive: true });
writeFileSync(OUT, JSON.stringify(next, null, 2));
next.forEach((r, i) => console.log(`${i + 1}. ${r.gst}  ${r.slug} | ${r.title}`));
console.log(`wrote ${next.length} matches → ${OUT}`);

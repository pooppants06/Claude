/**
 * Team-name normalisation. Polymarket slugs use short codes (usa, aus, sco);
 * the two books also spell country/club names differently. We resolve a
 * canonical display name and provide fuzzy matching so "USA", "United States"
 * and "usa" all line up.
 */

import type { TeamInfo } from "../types.js";

/** FIFA-style 3-letter codes → display names. Extend freely. */
const CODE_TO_NAME: Record<string, string> = {
  usa: "United States",
  aus: "Australia",
  sco: "Scotland",
  mar: "Morocco",
  bra: "Brazil",
  hai: "Haiti",
  arg: "Argentina",
  fra: "France",
  eng: "England",
  ger: "Germany",
  esp: "Spain",
  por: "Portugal",
  ned: "Netherlands",
  ita: "Italy",
  bel: "Belgium",
  cro: "Croatia",
  mex: "Mexico",
  can: "Canada",
  jpn: "Japan",
  kor: "South Korea",
  nor: "Norway",
  swe: "Sweden",
  den: "Denmark",
  sui: "Switzerland",
  uru: "Uruguay",
  col: "Colombia",
  nga: "Nigeria",
  sen: "Senegal",
  gha: "Ghana",
  cmr: "Cameroon",
  egy: "Egypt",
  ksa: "Saudi Arabia",
  irn: "Iran",
  aut: "Austria",
  pol: "Poland",
  wal: "Wales",
  ire: "Ireland",
  nzl: "New Zealand",
  rsa: "South Africa",
};

export function codeToName(code: string): string {
  const c = code.toLowerCase();
  return CODE_TO_NAME[c] ?? code.toUpperCase();
}

/**
 * Parse a Polymarket sports slug like "fifwc-usa-aus-2026-06-19" into the two
 * team codes and a probable kickoff date. Falls back gracefully.
 */
export function parseSlug(slug: string): {
  league?: string;
  homeCode?: string;
  awayCode?: string;
  date?: string;
} {
  const parts = slug.split("-").filter(Boolean);
  // Trailing YYYY-MM-DD (three numeric parts).
  let date: string | undefined;
  const tail = parts.slice(-3);
  if (tail.length === 3 && tail.every((p) => /^\d+$/.test(p))) {
    date = tail.join("-");
    parts.splice(-3, 3);
  }
  // Remaining: [league?, homeCode, awayCode]
  let league: string | undefined;
  let homeCode: string | undefined;
  let awayCode: string | undefined;
  if (parts.length >= 3) {
    league = parts[0];
    homeCode = parts[1];
    awayCode = parts[2];
  } else if (parts.length === 2) {
    homeCode = parts[0];
    awayCode = parts[1];
  }
  return { league, homeCode, awayCode, date };
}

/**
 * Cross-language / spelling aliases → a single canonical key, so the two books
 * line up (Norsk Tipping spells countries in Norwegian: Tyrkia, Skottland, Sør-
 * Afrika, …). Keys are already lower-cased, accent/connector-stripped, with
 * ø→o, æ→ae, å→a applied.
 */
const TEAM_ALIASES: Record<string, string> = {
  usbekistan: "uzbekistan",
  kroatia: "croatia",
  sveits: "switzerland",
  drkongo: "drcongo", kongo: "congo",
  marokko: "morocco",
  skottland: "scotland",
  brasil: "brazil",
  sorafrika: "southafrica",
  sorkorea: "southkorea", korearepublic: "southkorea", korearepublikk: "southkorea",
  tsjekkia: "czechia",
  elfenbenskysten: "cotedivoire",
  tyskland: "germany",
  nederland: "netherlands",
  sverige: "sweden",
  tyrkia: "turkiye",
  norge: "norway",
  frankrike: "france",
  irak: "iraq", iriran: "iran",
  kappverde: "caboverde", kappverd: "caboverde",
  spania: "spain",
  belgia: "belgium",
  algerie: "algeria",
  osterrike: "austria",
  unitedstates: "usa",
  hercegovina: "bosnia", bosniahercegovina: "bosnia", bosniaherzegovina: "bosnia",
  qairat: "kairat", // Kazakh club: Q/K transliteration (Polymarket "Qairat" vs books "Kairat")
  mlviciebsk: "vitebsk", viciebsk: "vitebsk", // Belarusian club: Viciebsk (BE) vs Vitebsk (RU)
};

/**
 * Loose key WITHOUT cross-language aliasing. Use this for matching names within
 * a single book (e.g. does a Norwegian market name contain the Norwegian team
 * name) — aliasing there would mismatch, since a long market-name string keeps
 * its native spelling while a bare team name would be canonicalised.
 */
export function normalizeKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .replace(/ø/g, "o").replace(/æ/g, "ae").replace(/å/g, "a")
    // Drop noise words and connectors so spellings like "Bosnia and Herzegovina"
    // and "Bosnia-Herzegovina" collapse to the same key (otherwise a team-total
    // market can fail team detection and leak into the full-match total).
    .replace(/\b(fc|fk|sc|cf|afc|the|and|og|und)\b/g, "")
    .replace(/&/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/** Loose key for comparing names ACROSS books (folds Norwegian↔English spellings). */
export function teamKey(name: string): string {
  const k = normalizeKey(name);
  return TEAM_ALIASES[k] ?? k;
}

/**
 * Decide whether a free-text outcome label refers to the home team, away team
 * or a draw, given the resolved match teams.
 */
export function classifyTeamSide(
  label: string,
  teams: TeamInfo,
): "HOME" | "AWAY" | "DRAW" | null {
  const k = teamKey(label);
  if (!k) return null;
  const lower = label.trim().toLowerCase();
  if (/^(draw|tie|x|uavgjort|unentschieden)$/.test(lower)) return "DRAW";
  // A draw keyword anywhere in the label takes priority over a team name that
  // also appears in it, e.g. Polymarket's "Draw (Argentina vs. Austria)" group
  // title — otherwise the embedded "Argentina" would mis-resolve it to HOME.
  if (/\b(draw|uavgjort|unentschieden)\b/.test(lower)) return "DRAW";

  const home = teamKey(teams.home);
  const away = teamKey(teams.away);
  const homeCode = teams.homeCode ? teamKey(codeToName(teams.homeCode)) : "";
  const awayCode = teams.awayCode ? teamKey(codeToName(teams.awayCode)) : "";

  if (k === home || (homeCode && k === homeCode)) return "HOME";
  if (k === away || (awayCode && k === awayCode)) return "AWAY";
  // Substring fallback (handles "USA Women", "United States O/U 2.5", etc.) using
  // NON-aliased keys: a long label keeps its native spelling ("United States"),
  // so the canonical alias ("usa") wouldn't be found inside it.
  const kRaw = normalizeKey(label);
  const homeRaw = normalizeKey(teams.home);
  const awayRaw = normalizeKey(teams.away);
  if (homeRaw && (kRaw.includes(homeRaw) || homeRaw.includes(kRaw))) return "HOME";
  if (awayRaw && (kRaw.includes(awayRaw) || awayRaw.includes(kRaw))) return "AWAY";
  return null;
}

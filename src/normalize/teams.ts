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

/** Loose key for comparing names across books. */
export function teamKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents
    .replace(/\b(fc|sc|cf|afc|the)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
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
  if (/^(draw|tie|x|uavgjort|unentschieden)$/.test(label.trim().toLowerCase()))
    return "DRAW";

  const home = teamKey(teams.home);
  const away = teamKey(teams.away);
  const homeCode = teams.homeCode ? teamKey(codeToName(teams.homeCode)) : "";
  const awayCode = teams.awayCode ? teamKey(codeToName(teams.awayCode)) : "";

  if (k === home || (homeCode && k === homeCode)) return "HOME";
  if (k === away || (awayCode && k === awayCode)) return "AWAY";
  // Substring fallback (handles "USA Women", "Brazil U23", etc.)
  if (home && (k.includes(home) || home.includes(k))) return "HOME";
  if (away && (k.includes(away) || away.includes(k))) return "AWAY";
  return null;
}

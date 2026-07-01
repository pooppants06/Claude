/**
 * Classify a raw Polymarket Gamma market into our canonical model.
 *
 * Polymarket exposes sports odds in two shapes that we both support:
 *   1. A single market with N outcomes, e.g. ["United States","Australia","Draw"].
 *   2. Several binary Yes/No markets grouped under one event, where the subject
 *      lives in `groupItemTitle`/`question` (e.g. groupItemTitle "Over 2.5").
 * Each emitted entry is one canonical selection with its own CLOB token id.
 */

import type { CanonicalMarketType, Period, TeamInfo } from "../../types.js";
import { classifyTeamSide } from "../../normalize/teams.js";

export interface RawPolymarketMarket {
  question?: string;
  groupItemTitle?: string;
  sportsMarketType?: string;
  line?: number | string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
  bestBid?: number | string;
  bestAsk?: number | string;
  spread?: number | string;
  lastTradePrice?: number | string;
}

export interface ClassifiedSelection {
  type: CanonicalMarketType;
  line?: number;
  period?: Period;
  selectionKey: string;
  selectionLabel: string;
  order?: number;
  prob: number | null; // initial implied probability from Gamma
  tokenId?: string;
  spread?: number | null; // CLOB order-book spread (bestAsk − bestBid), 0..1
}

/** Parse Gamma's stringified-JSON arrays (or pass through real arrays). */
export function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* fall through */
    }
  }
  return [];
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull a goal line out of a totals subject. Prefers the "O/U N" or
 * "Over/Under N" number so it isn't fooled by ordinals like "1st Half".
 */
function extractLine(text: string, raw: RawPolymarketMarket): number | undefined {
  const fromField = toNum(raw.line);
  if (fromField != null) return fromField;
  const m =
    text.match(/o\/u\s*(\d+(?:\.\d+)?)/i) ||
    text.match(/(?:over|under)\s*(\d+(?:\.\d+)?)/i);
  if (m) return Number(m[1]);
  const nums = text.match(/\d+(?:\.\d+)?/g);
  return nums ? Number(nums[nums.length - 1]) : undefined;
}

/** Which half (if any) a market applies to, from its subject text. */
function detectPeriod(text: string): Period | undefined {
  const t = text.toLowerCase();
  if (/\b(2nd half|second half|andre omgang)\b/.test(t)) return "2H";
  if (/\b(1st half|first half|half.?time|førsteomgang)\b/.test(t)) return "1H";
  return undefined;
}

const SCORE_RE = /(\d+)\s*[-–:]\s*(\d+)/;

/** Map an over/under-style Yes/No outcome to OVER/UNDER given the subject. */
function overUnderFromYesNo(outcome: string, subjectText: string): "OVER" | "UNDER" {
  const o = outcome.toLowerCase();
  if (o.includes("over")) return "OVER";
  if (o.includes("under")) return "UNDER";
  // Binary Yes/No: "Yes" means the stated direction in the subject happens.
  const subjectIsUnder = /under/.test(subjectText) && !/over/.test(subjectText);
  if (/^yes$/.test(o)) return subjectIsUnder ? "UNDER" : "OVER";
  if (/^no$/.test(o)) return subjectIsUnder ? "OVER" : "UNDER";
  return "OVER";
}

function detectType(
  text: string,
  outcomes: string[],
  teams: TeamInfo,
  giSide: "HOME" | "AWAY" | "DRAW" | null,
  binary: boolean,
): CanonicalMarketType {
  const t = text.toLowerCase();
  const sides = outcomes.map((o) => classifyTeamSide(o, teams)).filter(Boolean);

  if (/double chance/.test(t)) return "DOUBLE_CHANCE";
  if (/draw no bet|dnb/.test(t)) return "DRAW_NO_BET";
  if (/both teams to score|btts|begge lag scorer/.test(t)) return "BTTS";
  if (/half.?time.*full.?time|ht\/ft|ht-ft/.test(t)) return "HT_FT";
  if (/correct score|exact score|riktig resultat/.test(t) || outcomes.some((o) => SCORE_RE.test(o)))
    return "CORRECT_SCORE";
  if (/(odd|even|partall|oddetall)/.test(t)) return "ODD_EVEN";
  if (/first team to score|team to score first|to score first|score first/.test(t))
    return "FIRST_TEAM_TO_SCORE";
  if (/(first|1st).*goalscorer|first.*to score/.test(t)) return "FIRST_GOALSCORER";
  if (/(anytime|to score).*goal|goalscorer|målscorer|to score/.test(t) && !sides.length)
    return "ANYTIME_GOALSCORER";

  // Half / second-half variants are distinguished by `period`, not a type.
  const isTotal =
    /(total|over|under|o\/u|goals)/.test(t) || outcomes.some((o) => /over|under/i.test(o));

  if (isTotal) {
    // Team-specific totals are named in the *group title* (e.g. "Argentina O/U
    // 1.5"). We must not look at the full question, which is always
    // "<Home> vs. <Away>: ..." and so always contains both team names.
    if (giSide === "HOME") return "TEAM_TOTAL_HOME";
    if (giSide === "AWAY") return "TEAM_TOTAL_AWAY";
    return "TOTAL_GOALS";
  }

  // Match result: a multi-outcome team market, an explicit winner/leading
  // keyword, or a grouped binary "<side> to win / leading" sub-market.
  if (sides.length >= 2 || /moneyline|match winner|1x2|winner|kampvinner|leading/.test(t)) {
    return "MATCH_WINNER";
  }
  if (binary && giSide && !isTotal) return "MATCH_WINNER";
  return "UNKNOWN";
}

function doubleChanceKey(label: string, teams: TeamInfo): { key: string; label: string } | null {
  const hasHome = classifyTeamSide(label, teams) === "HOME" || /\bhome\b/i.test(label);
  const parts = label.split(/\bor\b|\/|,|&/i).map((p) => p.trim());
  const sides = new Set(parts.map((p) => classifyTeamSide(p, teams)).filter(Boolean));
  const draw = /draw|tie|uavgjort/i.test(label) || sides.has("DRAW");
  const home = sides.has("HOME");
  const away = sides.has("AWAY");
  if (home && draw) return { key: "1X", label: `${teams.home} or Draw` };
  if (home && away) return { key: "12", label: `${teams.home} or ${teams.away}` };
  if (draw && away) return { key: "X2", label: `Draw or ${teams.away}` };
  if (hasHome && draw) return { key: "1X", label: `${teams.home} or Draw` };
  return null;
}

function sideToSelection(
  side: "HOME" | "AWAY" | "DRAW",
  teams: TeamInfo,
): { key: string; label: string; order: number } {
  if (side === "HOME") return { key: "HOME", label: teams.home, order: 0 };
  if (side === "DRAW") return { key: "DRAW", label: "Draw", order: 1 };
  return { key: "AWAY", label: teams.away, order: 2 };
}

/**
 * Goal handicap. Polymarket lists these as group titles like "Argentina (-1.5)"
 * with two team outcomes. We express the line from the home team's perspective
 * (so "Austria (-1.5)" → home +1.5) to give each handicap a distinct key.
 */
function classifySpread(
  raw: RawPolymarketMarket,
  gi: string,
  outcomes: string[],
  prices: (number | null)[],
  tokens: string[],
  teams: TeamInfo,
  period: Period | undefined,
): ClassifiedSelection[] | null {
  const m = gi.match(/^(.+?)\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*\)\s*$/);
  if (!m || outcomes.length !== 2) return null;
  const favSide = classifyTeamSide(m[1]!, teams);
  if (favSide !== "HOME" && favSide !== "AWAY") return null;
  const mag = Math.abs(Number(m[2]));
  if (!Number.isFinite(mag) || mag === 0) return null;
  const sbid = toNum(raw.bestBid);
  const sask = toNum(raw.bestAsk);
  const obSpread =
    toNum(raw.spread) ?? (sbid != null && sask != null ? Math.max(0, sask - sbid) : null);
  const homeLine = favSide === "HOME" ? -mag : mag;
  const out: ClassifiedSelection[] = [];
  outcomes.forEach((label, i) => {
    const side = classifyTeamSide(label, teams);
    if (side !== "HOME" && side !== "AWAY") return;
    const teamLine = side === "HOME" ? homeLine : -homeLine;
    const name = side === "HOME" ? teams.home : teams.away;
    out.push({
      type: "SPREAD",
      line: homeLine,
      period,
      selectionKey: side,
      selectionLabel: `${name} ${teamLine > 0 ? "+" : ""}${teamLine}`,
      order: side === "HOME" ? 0 : 1,
      prob: prices[i] ?? null,
      tokenId: tokens[i],
      spread: obSpread,
    });
  });
  return out.length === 2 ? out : null;
}

/**
 * Turn one raw Gamma market into zero or more canonical selections.
 */
export function classifyPolymarketMarket(
  raw: RawPolymarketMarket,
  teams: TeamInfo,
): ClassifiedSelection[] {
  const outcomes = parseJsonArray(raw.outcomes);
  const prices = parseJsonArray(raw.outcomePrices).map((p) => toNum(p));
  const tokens = parseJsonArray(raw.clobTokenIds);
  if (outcomes.length === 0) return [];

  // Guard against market-type collisions: corners, cards, player props etc. use
  // the same "O/U <line>" Over/Under shape and carry a numeric line, so they get
  // misclassified as match TOTAL_GOALS and overwrite the real goals line on the
  // shared canonical key (e.g. "Total Corners: O/U 8.5" → TOTAL_GOALS@8.5, or a
  // "Player: 4+ goals+assists" prop → TOTAL_GOALS@3.5). None of these are markets
  // we compare, so drop them by their authoritative sportsMarketType.
  const smt = (raw.sportsMarketType ?? "").toLowerCase();
  if (/corner|card|booking|player|assist|_shot|shots|save|foul|offside|tackle|pass/.test(smt))
    return [];

  // Order-book spread for this market: prefer Gamma's `spread` field, else
  // derive from best bid/ask. Same for every leg of the (binary) market.
  const bid = toNum(raw.bestBid);
  const ask = toNum(raw.bestAsk);
  const obSpread =
    toNum(raw.spread) ?? (bid != null && ask != null ? Math.max(0, ask - bid) : null);

  const subject = `${raw.groupItemTitle ?? ""} ${raw.question ?? ""}`.trim();
  const text = `${subject} ${outcomes.join(" ")} ${raw.sportsMarketType ?? ""}`;
  const isBinaryYesNo =
    outcomes.length === 2 && outcomes.every((o) => /^(yes|no|ja|nei)$/i.test(o.trim()));
  // The clean subject for grouped binary markets lives in groupItemTitle.
  const gi = (raw.groupItemTitle ?? "").trim();
  const giSide = gi ? classifyTeamSide(gi, teams) : null;
  const period = detectPeriod(text);

  // Goal handicap — group title like "Argentina (-1.5)". Keep it off the
  // moneyline path (its two team outcomes would otherwise look like a 1X2).
  const spread = classifySpread(raw, gi, outcomes, prices, tokens, teams, period);
  if (spread) return spread;

  const type = detectType(text, outcomes, teams, giSide, isBinaryYesNo);
  const line =
    type === "TOTAL_GOALS" || type === "TEAM_TOTAL_HOME" || type === "TEAM_TOTAL_AWAY"
      ? extractLine(subject || outcomes.join(" "), raw)
      : undefined;
  // Period only applies to segment-able markets; other types stay full-match.
  const segP: Period | undefined =
    type === "TOTAL_GOALS" || type === "TEAM_TOTAL_HOME" || type === "TEAM_TOTAL_AWAY" ||
    type === "BTTS" || type === "MATCH_WINNER"
      ? period
      : undefined;

  const out: ClassifiedSelection[] = [];

  outcomes.forEach((label, i) => {
    const prob = prices[i] ?? null;
    const tokenId = tokens[i];
    const base = { type, line, period: segP, prob, tokenId, spread: obSpread };

    // Binary "team to win" sub-market: only the Yes leg is a clean 1X2 pick.
    if (isBinaryYesNo && type === "MATCH_WINNER") {
      const side = giSide ?? classifyTeamSide(subject, teams);
      if (side && /^(yes|ja)$/i.test(label)) {
        const ss = sideToSelection(side, teams);
        out.push({ ...base, selectionKey: ss.key, selectionLabel: ss.label, order: ss.order });
      }
      return;
    }

    // Binary "exact score" sub-market: the score lives in the subject/group
    // title (e.g. "Argentina 1 - 0 Austria"); keep only the Yes leg. The
    // "Any Other Score" residual has no digits — bucket it under OTHER.
    if (isBinaryYesNo && type === "CORRECT_SCORE") {
      if (/^(yes|ja)$/i.test(label)) {
        const m = subject.match(SCORE_RE);
        if (m) {
          const key = `${m[1]}-${m[2]}`;
          out.push({ ...base, selectionKey: key, selectionLabel: key.replace("-", "–"), order: 50 });
        } else if (/any other|other score/i.test(subject)) {
          out.push({ ...base, selectionKey: "OTHER", selectionLabel: "Any other score", order: 99 });
        }
      }
      return;
    }

    // Binary "first team to score" sub-market: keep the Yes leg, keyed by the
    // side named in the group title ("Argentina"/"Austria"/"Neither").
    if (isBinaryYesNo && type === "FIRST_TEAM_TO_SCORE") {
      if (/^(yes|ja)$/i.test(label)) {
        const sel =
          giSide === "HOME" ? { key: "HOME", label: teams.home, order: 0 }
          : giSide === "AWAY" ? { key: "AWAY", label: teams.away, order: 2 }
          : { key: "NEITHER", label: "Neither", order: 1 };
        out.push({ ...base, selectionKey: sel.key, selectionLabel: sel.label, order: sel.order });
      }
      return;
    }

    let sel: { key: string; label: string; order?: number } | null = null;

    switch (type) {
      case "MATCH_WINNER":
      case "HT_RESULT":
      case "DRAW_NO_BET": {
        const side = classifyTeamSide(label, teams);
        if (side && !(type === "DRAW_NO_BET" && side === "DRAW")) {
          sel = sideToSelection(side, teams);
        }
        break;
      }
      case "DOUBLE_CHANCE": {
        sel = doubleChanceKey(label, teams);
        break;
      }
      case "BTTS": {
        sel = /^(yes|ja)$/i.test(label)
          ? { key: "YES", label: "Yes", order: 0 }
          : { key: "NO", label: "No", order: 1 };
        break;
      }
      case "ODD_EVEN": {
        const odd = /odd|oddetall/i.test(label) || /^(yes|ja)$/i.test(label);
        sel = odd ? { key: "ODD", label: "Odd", order: 0 } : { key: "EVEN", label: "Even", order: 1 };
        break;
      }
      case "TOTAL_GOALS":
      case "FIRST_HALF_GOALS":
      case "TEAM_TOTAL_HOME":
      case "TEAM_TOTAL_AWAY": {
        const ou = overUnderFromYesNo(label, subject);
        sel =
          ou === "OVER"
            ? { key: "OVER", label: `Over ${line ?? ""}`.trim(), order: 0 }
            : { key: "UNDER", label: `Under ${line ?? ""}`.trim(), order: 1 };
        break;
      }
      case "FIRST_TEAM_TO_SCORE": {
        const side = classifyTeamSide(label, teams);
        if (side === "HOME") sel = { key: "HOME", label: teams.home, order: 0 };
        else if (side === "AWAY") sel = { key: "AWAY", label: teams.away, order: 2 };
        else sel = { key: "NEITHER", label: "Neither", order: 1 };
        break;
      }
      case "CORRECT_SCORE": {
        const m = label.match(SCORE_RE);
        const key = m ? `${m[1]}-${m[2]}` : label.trim();
        sel = { key, label: key.replace("-", "–") };
        break;
      }
      case "HT_FT": {
        // Map "Home/Draw", "1/X", etc. into canonical "1/X/2" codes.
        const parts = label.split(/[\/\-–]/).map((p) => p.trim());
        const toCode = (p: string): string => {
          if (/^1$|home/i.test(p)) return classifyTeamSide(p, teams) === "AWAY" ? "2" : "1";
          if (/^2$|away/i.test(p)) return "2";
          if (/^x$|draw|tie/i.test(p)) return "X";
          const side = classifyTeamSide(p, teams);
          return side === "HOME" ? "1" : side === "AWAY" ? "2" : "X";
        };
        if (parts.length === 2) {
          const key = `${toCode(parts[0]!)}/${toCode(parts[1]!)}`;
          sel = { key, label: label.trim() };
        } else {
          sel = { key: label.trim().toUpperCase().replace(/\s+/g, ""), label: label.trim() };
        }
        break;
      }
      case "FIRST_GOALSCORER":
      case "ANYTIME_GOALSCORER": {
        if (/^(no|nei|no goalscorer|none)$/i.test(label.trim())) {
          sel = { key: "NONE", label: "No goalscorer" };
        } else if (!/^(yes|ja)$/i.test(label.trim())) {
          sel = { key: `p:${label.toLowerCase().replace(/[^a-z0-9]/g, "")}`, label: label.trim() };
        } else {
          // Yes/No binary keyed by the player in the subject.
          sel = { key: `p:${subject.toLowerCase().replace(/[^a-z0-9]/g, "")}`, label: subject };
        }
        break;
      }
      default: {
        sel = { key: label.trim().toUpperCase(), label: label.trim() };
      }
    }

    if (sel) out.push({ ...base, selectionKey: sel.key, selectionLabel: sel.label, order: sel.order });
  });

  return out;
}

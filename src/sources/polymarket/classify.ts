/**
 * Classify a raw Polymarket Gamma market into our canonical model.
 *
 * Polymarket exposes sports odds in two shapes that we both support:
 *   1. A single market with N outcomes, e.g. ["United States","Australia","Draw"].
 *   2. Several binary Yes/No markets grouped under one event, where the subject
 *      lives in `groupItemTitle`/`question` (e.g. groupItemTitle "Over 2.5").
 * Each emitted entry is one canonical selection with its own CLOB token id.
 */

import type { CanonicalMarketType, TeamInfo } from "../../types.js";
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
  lastTradePrice?: number | string;
}

export interface ClassifiedSelection {
  type: CanonicalMarketType;
  line?: number;
  selectionKey: string;
  selectionLabel: string;
  order?: number;
  prob: number | null; // initial implied probability from Gamma
  tokenId?: string;
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

function extractLine(text: string, raw: RawPolymarketMarket): number | undefined {
  const fromField = toNum(raw.line);
  if (fromField != null) return fromField;
  const m = text.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : undefined;
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
  if (/(first|1st).*goalscorer|first.*to score/.test(t)) return "FIRST_GOALSCORER";
  if (/(anytime|to score).*goal|goalscorer|målscorer|to score/.test(t) && !sides.length)
    return "ANYTIME_GOALSCORER";

  const isHalf = /(half.?time|1st half|first half|førsteomgang|pause)/.test(t);
  const isTotal = /(total|over|under|goals)/.test(t) || outcomes.some((o) => /over|under/i.test(o));

  if (isTotal) {
    if (isHalf) return "FIRST_HALF_GOALS";
    // Team-specific totals (subject names one of the teams + "total/goals").
    if (classifyTeamSide(text, teams) === "HOME") return "TEAM_TOTAL_HOME";
    if (classifyTeamSide(text, teams) === "AWAY") return "TEAM_TOTAL_AWAY";
    return "TOTAL_GOALS";
  }

  if (isHalf && sides.length) return "HT_RESULT";

  // Moneyline / match winner: either a multi-outcome market whose outcomes are
  // team sides, an explicit winner keyword, or a grouped binary "<team/draw> to
  // win" sub-market (subject in groupItemTitle resolves to a side).
  if (sides.length >= 2 || /moneyline|match winner|1x2|winner|kampvinner/.test(t)) {
    return "MATCH_WINNER";
  }
  if (binary && giSide && !isTotal && !isHalf) return "MATCH_WINNER";
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

  const subject = `${raw.groupItemTitle ?? ""} ${raw.question ?? ""}`.trim();
  const text = `${subject} ${outcomes.join(" ")} ${raw.sportsMarketType ?? ""}`;
  const isBinaryYesNo =
    outcomes.length === 2 && outcomes.every((o) => /^(yes|no|ja|nei)$/i.test(o.trim()));
  // The clean subject for grouped binary markets lives in groupItemTitle.
  const gi = (raw.groupItemTitle ?? "").trim();
  const giSide = gi ? classifyTeamSide(gi, teams) : null;
  const type = detectType(text, outcomes, teams, giSide, isBinaryYesNo);
  const line =
    type === "TOTAL_GOALS" ||
    type === "FIRST_HALF_GOALS" ||
    type === "TEAM_TOTAL_HOME" ||
    type === "TEAM_TOTAL_AWAY"
      ? extractLine(subject || outcomes.join(" "), raw)
      : undefined;

  const out: ClassifiedSelection[] = [];

  outcomes.forEach((label, i) => {
    const prob = prices[i] ?? null;
    const tokenId = tokens[i];
    const base = { type, line, prob, tokenId };

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
    // title (e.g. "Argentina 1 - 0 Austria"); keep only the Yes leg.
    if (isBinaryYesNo && type === "CORRECT_SCORE") {
      const m = subject.match(SCORE_RE);
      if (m && /^(yes|ja)$/i.test(label)) {
        const key = `${m[1]}-${m[2]}`;
        out.push({ ...base, selectionKey: key, selectionLabel: key.replace("-", "–") });
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

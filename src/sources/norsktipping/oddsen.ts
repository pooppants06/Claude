/**
 * Real Norsk Tipping odds via the public Oddsen API
 * (https://api.norsk-tipping.no/OddsenGameInfo/v1/api), used when
 * NORSKTIPPING_PROVIDER=oddsen.
 *
 *   GET /events/{sportId}/{from}/{to}   -> events in a date window
 *   GET /markets/{eventId}              -> every market + selection + odds
 *
 * We resolve the event by team name + date from the match meta, then map the
 * Norwegian market names onto our canonical model. Markets we can't line up with
 * the other books (corners, cards, player props, …) are still surfaced as
 * Norsk-Tipping-only markets so nothing is dropped.
 */

import { config } from "../../config.js";
import type { Market, MatchMeta, Period } from "../../types.js";
import { emptyMarket, makeQuote, upsertQuote } from "../../normalize/markets.js";
import { parseSlug, teamKey, normalizeKey } from "../../normalize/teams.js";

interface NtSelection { selectionName: string; selectionShortName?: string; selectionValue?: string; selectionOdds?: string }
interface NtMarket { marketId: string; marketName: string; selections?: NtSelection[] }
export interface NtEvent {
  eventId: string;
  homeParticipant?: string;
  awayParticipant?: string;
  eventName?: string;
  startTime?: string;
}

const FOOTBALL = "FBL";

async function getJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "OddsEdge/1.0" },
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`Norsk Tipping API HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// The Oddsen events endpoint only returns data when the `to` bound ends at
// 2359 (end of day); other times yield an empty 204. So we always pin the
// window to whole days.
function dayStamp(d: Date, hhmm: "0000" | "2359"): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${hhmm}`;
}

/** Find the Oddsen eventId for this match by team name + date window. */
async function resolveEventId(meta: MatchMeta): Promise<NtEvent> {
  const base = `${config.norskTipping.oddsenUrl}`;
  // Prefer the date in the slug (e.g. ...-2026-06-22) — Polymarket's startDate
  // is often a creation-time artefact, not the real kickoff.
  const slugDate = parseSlug(meta.slug).date;
  const day = slugDate ? new Date(`${slugDate}T12:00:00Z`) : meta.startDate ? new Date(meta.startDate) : new Date();
  const from = dayStamp(new Date(day.getTime() - 24 * 3600 * 1000), "0000");
  const to = dayStamp(new Date(day.getTime() + 24 * 3600 * 1000), "2359");
  const hk = teamKey(meta.teams.home);
  const ak = teamKey(meta.teams.away);
  // Match on either participant resembling our home/away (Østerrike≈Austria etc.).
  const matchesTeams = (e: NtEvent) => {
    const h = teamKey(e.homeParticipant ?? "");
    const a = teamKey(e.awayParticipant ?? "");
    return near(h, hk) || near(h, ak) || near(a, hk) || near(a, ak);
  };

  // Pre-match listing first.
  const pre: NtEvent[] = (await getJson(`${base}/events/${FOOTBALL}/${from}/${to}`))?.eventList ?? [];
  let match = pre.find(matchesTeams);
  // Once a game kicks off, Norsk Tipping drops it from the pre-match window and
  // moves it to the live feed under a NEW event id — fall back to that so
  // in-play matches still resolve.
  if (!match) {
    const live: NtEvent[] = (await getJson(`${base}/liveevents/${FOOTBALL}`))?.eventList ?? [];
    match = live.find(matchesTeams);
  }
  if (!match) throw new Error(`No Norsk Tipping event found for ${meta.teams.home} vs ${meta.teams.away}`);
  return match;
}

const num = (s?: string): number | null => {
  if (!s) return null;
  const n = Number(String(s).replace(",", "."));
  return Number.isFinite(n) && n > 1 ? n : null;
};

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);

/** Period from a Norwegian market name. */
function periodOf(name: string): Period | undefined {
  const t = name.toLowerCase();
  if (/2\.\s*omgang|andre omgang/.test(t)) return "2H";
  if (/1\.\s*omgang|første omgang|pause/.test(t)) return "1H";
  return undefined;
}

const near = (x: string, y: string) => !!x && !!y && (x === y || x.includes(y) || y.includes(x));

interface Orientation {
  /** True when Norsk Tipping's home/away is the reverse of Polymarket's. */
  flip: boolean;
  /** Does this market/selection name refer to our canonical HOME / AWAY team? */
  mentions: (name: string, side: "HOME" | "AWAY") => boolean;
  sideForName: (name: string) => "HOME" | "AWAY" | null;
}

/**
 * Norsk Tipping encodes sides (H/A) and names teams relative to ITS OWN view of
 * home/away, which is frequently the reverse of Polymarket's. Resolve the
 * orientation once from the event participants so every side-based market lines
 * up with our canonical home/away instead of silently swapping favourite and
 * underdog.
 */
export function buildOrientation(meta: MatchMeta, ev: NtEvent): Orientation {
  const hk = teamKey(meta.teams.home);
  const ak = teamKey(meta.teams.away);
  const ntHome = teamKey(ev.homeParticipant ?? "");
  const ntAway = teamKey(ev.awayParticipant ?? "");
  const aligns = near(ntHome, hk) || near(ntAway, ak);
  const crosses = near(ntHome, ak) || near(ntAway, hk);
  const flip = crosses && !aligns;
  // For matching a Norsk Tipping market NAME against the team (both Norwegian),
  // use the NON-aliased key — the market name keeps its native spelling
  // ("Usbekistan"), so canonicalising the bare name to "uzbekistan" would miss.
  const ntHomeRaw = normalizeKey(ev.homeParticipant ?? "");
  const ntAwayRaw = normalizeKey(ev.awayParticipant ?? "");
  const rawForSide = (side: "HOME" | "AWAY") =>
    side === "HOME" ? (flip ? ntAwayRaw : ntHomeRaw) : (flip ? ntHomeRaw : ntAwayRaw);
  const mentions = (name: string, side: "HOME" | "AWAY") => {
    const k = normalizeKey(name);
    const r = rawForSide(side);
    return (!!r && k.includes(r)) || k.includes(normalizeKey(side === "HOME" ? meta.teams.home : meta.teams.away));
  };
  const sideForName = (name: string): "HOME" | "AWAY" | null => {
    const h = mentions(name, "HOME");
    const a = mentions(name, "AWAY");
    return h && !a ? "HOME" : a && !h ? "AWAY" : null;
  };
  return { flip, mentions, sideForName };
}

/**
 * Map one Norsk Tipping market onto a canonical market, or surface it verbatim
 * as a Norsk-Tipping-only market. Returns the Market to merge into the book.
 */
function mapMarket(m: NtMarket, meta: MatchMeta, ev: NtEvent, o: Orientation): Market | null {
  const name = m.marketName;
  const t = name.toLowerCase();
  const sels = (m.selections ?? []).filter((s) => num(s.selectionOdds) != null);
  if (!sels.length) return null;
  const period = periodOf(name);
  const q = (s: NtSelection) => makeQuote("norsktipping", { decimal: num(s.selectionOdds)! });

  const HOME = { key: "HOME", label: meta.teams.home, order: 0 };
  const DRAW = { key: "DRAW", label: "Draw", order: 1 };
  const AWAY = { key: "AWAY", label: meta.teams.away, order: 2 };
  const sideSel = (v?: string) =>
    v === "H" ? (o.flip ? AWAY : HOME)
    : v === "D" || v === "U" || v === "X" ? DRAW
    : v === "A" || v === "B" ? (o.flip ? HOME : AWAY)
    : null;

  // ---- 1X2 (full / 1st half / 2nd half) — strict, so combo markets like
  // "HUB og begge lag scorer" or "Hjørnespark HUB" don't pollute the moneyline.
  if (/^hub$/.test(t) || /^1\.\s*omgang\s*-\s*hub$/.test(t) || /^hub\s+2\.?\s*omgang$/.test(t)) {
    const mk = emptyMarket("MATCH_WINNER", undefined, undefined, period);
    for (const s of sels) { const sel = sideSel(s.selectionValue); if (sel) upsertQuote(mk, sel, q(s)); }
    if (mk.selections.length) return mk;
  }
  // ---- Totals (full / half) and team totals ----
  const ouLine = (s: NtSelection) => Number((s.selectionName.match(/(\d+(?:[.,]\d+)?)/)?.[1] ?? "").replace(",", "."));
  const ouSel = (s: NtSelection) => /over/i.test(s.selectionName)
    ? { key: "OVER", label: s.selectionName, order: 0 }
    : { key: "UNDER", label: s.selectionName, order: 1 };
  if (/totalt antall .*mål/.test(t) && /over\/?under/.test(t)) {
    const line = ouLine(sels[0]!);
    const side = o.sideForName(name);
    const type: Market["type"] =
      side === "HOME" ? "TEAM_TOTAL_HOME" : side === "AWAY" ? "TEAM_TOTAL_AWAY" : "TOTAL_GOALS";
    const mk = emptyMarket(type, line, undefined, period);
    for (const s of sels) upsertQuote(mk, ouSel(s), q(s));
    return mk;
  }
  // ---- Odd / Even ----
  if (/oddetall\/partall/.test(t)) {
    const mk = emptyMarket("ODD_EVEN");
    for (const s of sels) upsertQuote(mk, /odde/i.test(s.selectionName) ? { key: "ODD", label: "Odd", order: 0 } : { key: "EVEN", label: "Even", order: 1 }, q(s));
    return mk;
  }
  // ---- BTTS (full / halves) ----
  if (/begge lag scorer/.test(t) && !/og |over\/under/.test(t)) {
    const mk = emptyMarket("BTTS", undefined, undefined, period);
    for (const s of sels) upsertQuote(mk, /ja/i.test(s.selectionName) ? { key: "YES", label: "Yes", order: 0 } : { key: "NO", label: "No", order: 1 }, q(s));
    return mk;
  }
  if (/scorer begge lag i .*omgang/.test(t) && period) {
    const mk = emptyMarket("BTTS", undefined, undefined, period);
    for (const s of sels) upsertQuote(mk, /ja/i.test(s.selectionName) ? { key: "YES", label: "Yes", order: 0 } : { key: "NO", label: "No", order: 1 }, q(s));
    return mk;
  }
  // ---- Double chance (NT lists each leg as its own 2-way market; we keep the
  // "<X> eller <Y>" selection and map it to 1X / 12 / X2). ----
  if (/dobbelsjanse/.test(t)) {
    const mk = emptyMarket("DOUBLE_CHANCE");
    for (const s of sels) {
      if (!/ eller |eller/.test(s.selectionName.toLowerCase())) continue;
      const hasHome = o.mentions(s.selectionName, "HOME");
      const hasAway = o.mentions(s.selectionName, "AWAY");
      const hasDraw = /uavgjort/.test(s.selectionName.toLowerCase());
      const sel = hasHome && hasDraw ? { key: "1X", label: `${meta.teams.home} or Draw`, order: 0 }
        : hasAway && hasDraw ? { key: "X2", label: `Draw or ${meta.teams.away}`, order: 2 }
        : hasHome && hasAway ? { key: "12", label: `${meta.teams.home} or ${meta.teams.away}`, order: 1 }
        : null;
      if (sel) upsertQuote(mk, sel, q(s));
    }
    return mk.selections.length ? mk : null;
  }
  // ---- Draw no bet ----
  if (/uavgjort tilbakebetales/.test(t)) {
    const mk = emptyMarket("DRAW_NO_BET");
    for (const s of sels) { const sel = sideSel(s.selectionValue); if (sel && sel.key !== "DRAW") upsertQuote(mk, { ...sel, order: sel.key === "HOME" ? 0 : 1 }, q(s)); }
    return mk;
  }
  // ---- HT/FT ----
  if (/halvtid\/fulltid/.test(t)) {
    const mk = emptyMarket("HT_FT");
    sels.forEach((s, i) => upsertQuote(mk, { key: s.selectionName.replace(/\s+/g, "").toUpperCase(), label: s.selectionName, order: i }, q(s)));
    return mk;
  }
  // ---- Correct score ----
  if (/korrekt resultat/.test(t)) {
    const mk = emptyMarket("CORRECT_SCORE");
    sels.forEach((s, i) => {
      const sc = s.selectionName.match(/(\d+)\s*-\s*(\d+)/);
      const key = sc ? `${sc[1]}-${sc[2]}` : s.selectionName.trim();
      upsertQuote(mk, { key, label: key.replace("-", "–"), order: i }, q(s));
    });
    return mk;
  }
  // ---- First team to score ----
  if (/lag til å score 1\.? mål/.test(t)) {
    const mk = emptyMarket("FIRST_TEAM_TO_SCORE");
    for (const s of sels) {
      const side = /ingen/i.test(s.selectionName) ? null : o.sideForName(s.selectionName);
      const sel = /ingen/i.test(s.selectionName) ? { key: "NEITHER", label: "Neither", order: 1 }
        : side === "HOME" ? HOME
        : side === "AWAY" ? AWAY
        : null;
      if (sel) upsertQuote(mk, sel, q(s));
    }
    return mk.selections.length ? mk : null;
  }
  // ---- First / anytime goalscorer ----
  if (/kampens 1\.? målscorer/.test(t) || (/målscorer/.test(t) && /1\./.test(t))) {
    const mk = emptyMarket("FIRST_GOALSCORER", undefined, name);
    sels.forEach((s, i) => upsertQuote(mk, { key: `p:${slug(s.selectionName)}`, label: s.selectionName, order: i }, q(s)));
    return mk;
  }
  if (/^scorer mål$/.test(t)) {
    const mk = emptyMarket("ANYTIME_GOALSCORER");
    sels.forEach((s, i) => upsertQuote(mk, { key: `p:${slug(s.selectionName)}`, label: s.selectionName, order: i }, q(s)));
    return mk;
  }

  // ---- Fallback: surface as a Norsk-Tipping-only market with a distinct key ----
  const mk = emptyMarket("UNKNOWN", undefined, name, period);
  mk.key = `NT:${slug(name)}${period ? `#${period}` : ""}`;
  mk.variant = slug(name);
  sels.forEach((s, i) => upsertQuote(mk, { key: `${slug(s.selectionName)}-${i}`, label: s.selectionName, order: i }, q(s)));
  return mk.selections.length ? mk : null;
}

export async function fetchNorskTippingOddsen(meta: MatchMeta): Promise<Market[]> {
  const ev = await resolveEventId(meta);
  const orientation = buildOrientation(meta, ev);
  const data = await getJson(`${config.norskTipping.oddsenUrl}/markets/${ev.eventId}`);
  const raw: NtMarket[] = data?.markets ?? [];
  const byKey = new Map<string, Market>();
  for (const m of raw) {
    const mapped = mapMarket(m, meta, ev, orientation);
    if (!mapped) continue;
    const existing = byKey.get(mapped.key);
    if (existing) {
      for (const s of mapped.selections) {
        const q = s.quotes.norsktipping;
        if (q) upsertQuote(existing, { key: s.key, label: s.label, order: s.order }, q);
      }
    } else {
      byKey.set(mapped.key, mapped);
    }
  }
  return [...byKey.values()];
}

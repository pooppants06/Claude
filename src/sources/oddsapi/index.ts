/**
 * OddsApiSource: real third book. Resolves the match on The Odds API by team
 * name, pulls odds across the configured bookmaker regions, and collapses them
 * into one "best available price" book. Enabled only when ODDS_API_KEY is set.
 *
 * The Odds API quota is limited (cost = markets × regions per refresh) so this
 * refreshes on a slow interval rather than streaming.
 */

import { EventEmitter } from "node:events";
import { config } from "../../config.js";
import type { Market, MatchMeta } from "../../types.js";
import { teamKey } from "../../normalize/teams.js";
import { buildOddsApiMarkets, type OAEvent } from "./map.js";

export type OaStatus = "idle" | "disabled" | "live" | "no-match" | "error";

async function getJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`The Odds API HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export class OddsApiSource extends EventEmitter {
  private meta: MatchMeta | null = null;
  private eventId: string | null = null;
  private markets: Market[] = [];
  private status: OaStatus = "idle";
  private timer: NodeJS.Timeout | null = null;

  async load(meta: MatchMeta): Promise<void> {
    this.meta = meta;
    if (!config.oddsApi.apiKey) { this.setStatus("disabled"); return; }
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), config.oddsApi.pollMs);
  }

  private async resolveEvent(): Promise<string | null> {
    if (this.eventId) return this.eventId;
    const { apiKey, baseUrl, sport } = config.oddsApi;
    const events: OAEvent[] = await getJson(
      `${baseUrl}/sports/${sport}/events/?apiKey=${apiKey}`,
    );
    const hk = teamKey(this.meta!.teams.home);
    const ak = teamKey(this.meta!.teams.away);
    const near = (x: string, y: string) => !!x && !!y && (x === y || x.includes(y) || y.includes(x));
    const ev = events.find((e) => {
      const h = teamKey(e.home_team ?? "");
      const a = teamKey(e.away_team ?? "");
      return (near(h, hk) && near(a, ak)) || (near(h, ak) && near(a, hk));
    });
    this.eventId = ev?.id ?? null;
    return this.eventId;
  }

  private async refresh(): Promise<void> {
    if (!this.meta) return;
    try {
      const id = await this.resolveEvent();
      if (!id) { this.setStatus("no-match"); this.emit("update"); return; }
      const { apiKey, baseUrl, sport, regions, markets } = config.oddsApi;
      const ev: OAEvent = await getJson(
        `${baseUrl}/sports/${sport}/events/${id}/odds/?apiKey=${apiKey}` +
          `&regions=${regions}&markets=${markets}&oddsFormat=decimal`,
      );
      this.markets = buildOddsApiMarkets(ev, this.meta.teams);
      this.setStatus("live");
      this.emit("update");
    } catch (err) {
      console.warn(`[oddsapi] refresh failed: ${(err as Error).message}`);
      this.setStatus(this.markets.length ? "live" : "error");
      this.emit("update");
    }
  }

  getMarkets(): Market[] { return this.markets; }
  getStatus(): OaStatus { return this.status; }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setStatus("idle");
  }

  private setStatus(s: OaStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.emit("status", s);
  }
}

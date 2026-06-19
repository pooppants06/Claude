/**
 * PolymarketSource: load an event once over REST, then keep its selection
 * prices fresh over the CLOB WebSocket. Emits "update" on any price move and
 * "status" with the feed state.
 */

import { EventEmitter } from "node:events";
import { config } from "../../config.js";
import type { MatchMeta, Market } from "../../types.js";
import { makeQuote } from "../../normalize/markets.js";
import { fetchPolymarketEvent, type TokenRef } from "./gamma.js";
import { demoMeta, generatePolymarketDemo } from "./demo.js";
import { PolymarketMarketSocket } from "./ws.js";

export type FeedStatus =
  | "idle"
  | "loading"
  | "connecting"
  | "live"
  | "disconnected"
  | "demo"
  | "error";

export class PolymarketSource extends EventEmitter {
  private meta: MatchMeta | null = null;
  private markets: Market[] = [];
  private tokenIndex = new Map<string, TokenRef>();
  private socket: PolymarketMarketSocket | null = null;
  private demoTimer: NodeJS.Timeout | null = null;
  private status: FeedStatus = "idle";

  async load(slugOrUrl: string): Promise<MatchMeta> {
    this.setStatus("loading");

    if (config.polymarket.provider === "demo") {
      return this.loadDemo(slugOrUrl);
    }

    let event;
    try {
      event = await fetchPolymarketEvent(slugOrUrl);
    } catch (err) {
      if (config.polymarket.demoOnError) {
        console.warn(`[polymarket] Gamma fetch failed, using demo book: ${(err as Error).message}`);
        return this.loadDemo(slugOrUrl);
      }
      throw err;
    }
    this.meta = event.meta;
    this.markets = event.markets;
    this.tokenIndex = event.tokenIndex;

    this.socket?.stop();
    this.socket = new PolymarketMarketSocket(event.tokenIds);
    this.socket.on("price", ({ tokenId, prob }) => this.applyPrice(tokenId, prob));
    this.socket.on("status", (s: string) => {
      // "no-tokens" means we still have REST snapshot prices, just no live feed.
      if (s === "live") this.setStatus("live");
      else if (s === "connecting") this.setStatus("connecting");
      else if (s === "disconnected") this.setStatus("disconnected");
    });
    this.socket.on("error", (err) => this.emit("feed-error", err));
    this.socket.start();
    return event.meta;
  }

  private loadDemo(slugOrUrl: string): MatchMeta {
    this.socket?.stop();
    this.socket = null;
    this.meta = demoMeta(slugOrUrl);
    this.markets = generatePolymarketDemo(this.meta);
    this.setStatus("demo");
    // Re-roll prices on an interval so the demo "moves" like a live feed.
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.demoTimer = setInterval(() => {
      if (!this.meta) return;
      this.markets = generatePolymarketDemo(this.meta);
      this.emit("update");
    }, config.polymarket.demoJitterMs);
    return this.meta;
  }

  private applyPrice(tokenId: string, prob: number): void {
    const ref = this.tokenIndex.get(tokenId);
    if (!ref) return;
    const market = this.markets.find((m) => m.key === ref.marketKey);
    const sel = market?.selections.find((s) => s.key === ref.selectionKey);
    if (!sel) return;
    sel.quotes.polymarket = makeQuote("polymarket", { prob, meta: { tokenId } });
    this.emit("update");
  }

  getMeta(): MatchMeta | null {
    return this.meta;
  }

  getMarkets(): Market[] {
    return this.markets;
  }

  getStatus(): FeedStatus {
    return this.status;
  }

  stop(): void {
    this.socket?.stop();
    this.socket = null;
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.demoTimer = null;
    this.setStatus("idle");
  }

  private setStatus(s: FeedStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.emit("status", s);
  }
}

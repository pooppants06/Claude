/**
 * NorskTippingSource: produces a full Oddsen-style book for the match and
 * refreshes it on an interval. Uses the configured provider (mock | http) and
 * transparently falls back to the mock if a real endpoint fails, so the app
 * never goes blank.
 */

import { EventEmitter } from "node:events";
import { config } from "../../config.js";
import type { Market, MatchMeta } from "../../types.js";
import { generateNorskTippingMarkets } from "./mock.js";
import { fetchNorskTippingHttp } from "./orako.js";

export type NtStatus = "idle" | "live" | "mock" | "fallback-mock" | "error";

export class NorskTippingSource extends EventEmitter {
  private meta: MatchMeta | null = null;
  private markets: Market[] = [];
  private timer: NodeJS.Timeout | null = null;
  private status: NtStatus = "idle";

  async load(meta: MatchMeta): Promise<void> {
    this.meta = meta;
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, config.norskTipping.pollMs);
  }

  private async refresh(): Promise<void> {
    if (!this.meta) return;
    if (config.norskTipping.provider === "http") {
      try {
        this.markets = await fetchNorskTippingHttp(this.meta);
        this.setStatus("live");
        this.emit("update");
        return;
      } catch (err) {
        console.warn(`[norsktipping] http provider failed, using mock: ${(err as Error).message}`);
        this.markets = generateNorskTippingMarkets(this.meta);
        this.setStatus("fallback-mock");
        this.emit("update");
        return;
      }
    }
    this.markets = generateNorskTippingMarkets(this.meta);
    this.setStatus("mock");
    this.emit("update");
  }

  getMarkets(): Market[] {
    return this.markets;
  }

  getStatus(): NtStatus {
    return this.status;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setStatus("idle");
  }

  private setStatus(s: NtStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.emit("status", s);
  }
}

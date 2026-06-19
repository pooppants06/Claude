/**
 * Tracker: owns the live feeds for ONE match (one Polymarket event + its Norsk
 * Tipping book), recomputes the comparison when either side moves, and emits a
 * debounced "snapshot" no more often than SNAPSHOT_INTERVAL_MS.
 */

import { EventEmitter } from "node:events";
import { config } from "./config.js";
import type { MatchMeta } from "./types.js";
import { PolymarketSource } from "./sources/polymarket/index.js";
import { NorskTippingSource } from "./sources/norsktipping/index.js";
import { compareMarkets, type ComparisonSnapshot } from "./compare/compare.js";

export class Tracker extends EventEmitter {
  readonly pm = new PolymarketSource();
  readonly nt = new NorskTippingSource();
  private meta: MatchMeta | null = null;
  private dirty = true;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  async start(url: string): Promise<ComparisonSnapshot> {
    const markDirty = () => {
      this.dirty = true;
    };
    this.pm.on("update", markDirty);
    this.pm.on("status", markDirty);
    this.pm.on("feed-error", (e: Error) => {
      this.lastError = e.message;
    });
    this.nt.on("update", markDirty);
    this.nt.on("status", markDirty);

    this.meta = await this.pm.load(url); // throws on bad URL / network
    await this.nt.load(this.meta);

    this.flushTimer = setInterval(() => this.flush(), config.snapshotIntervalMs);
    return this.snapshot();
  }

  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.emit("snapshot", this.snapshot());
  }

  snapshot(): ComparisonSnapshot {
    if (!this.meta) throw new Error("Tracker not started");
    return compareMarkets(this.meta, this.pm.getMarkets(), this.nt.getMarkets(), {
      polymarket: this.lastError ? `error: ${this.lastError}` : this.pm.getStatus(),
      norsktipping: this.nt.getStatus(),
    });
  }

  getMeta(): MatchMeta | null {
    return this.meta;
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.pm.stop();
    this.nt.stop();
    this.removeAllListeners();
  }
}

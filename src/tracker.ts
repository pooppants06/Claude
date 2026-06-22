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
import { OddsApiSource } from "./sources/oddsapi/index.js";
import { compareMarkets, type ComparisonSnapshot } from "./compare/compare.js";

export class Tracker extends EventEmitter {
  readonly pm = new PolymarketSource();
  readonly nt = new NorskTippingSource();
  readonly oa = new OddsApiSource();
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
    this.oa.on("update", markDirty);
    this.oa.on("status", markDirty);

    this.meta = await this.pm.load(url); // throws on bad URL / network
    // Norsk Tipping and The Odds API load in parallel; failures degrade
    // gracefully (each source reports its own status) and never block.
    await Promise.allSettled([this.nt.load(this.meta), this.oa.load(this.meta)]);

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
    return compareMarkets(
      this.meta,
      [
        { source: "polymarket", markets: this.pm.getMarkets(), status: this.pm.getStatus() },
        { source: "norsktipping", markets: this.nt.getMarkets(), status: this.nt.getStatus() },
        { source: "oddsapi", markets: this.oa.getMarkets(), status: this.oa.getStatus() },
      ],
      {
        polymarket: this.lastError ? `error: ${this.lastError}` : this.pm.getStatus(),
        norsktipping: this.nt.getStatus(),
        oddsapi: this.oa.getStatus(),
      },
    );
  }

  getMeta(): MatchMeta | null {
    return this.meta;
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.pm.stop();
    this.nt.stop();
    this.oa.stop();
    this.removeAllListeners();
  }
}

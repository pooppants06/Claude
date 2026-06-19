/**
 * Live price feed from Polymarket's public CLOB "market" channel.
 *
 *   URL      wss://ws-subscriptions-clob.polymarket.com/ws/market
 *   send     {"type":"market","assets_ids":[...token ids...]}
 *   events   book | price_change | last_trade_price
 *   keepalive send "PING" every 10s
 *
 * Emits "price" with { tokenId, prob } whenever a subscribed token's mid price
 * moves. Auto-reconnects with capped backoff.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "../../config.js";

function mid(bid: number | null, ask: number | null): number | null {
  if (bid != null && ask != null) return (bid + ask) / 2;
  return bid ?? ask ?? null;
}

function n(v: unknown): number | null {
  if (v == null) return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

export interface PriceUpdate {
  tokenId: string;
  prob: number;
}

export class PolymarketMarketSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private closed = false;

  constructor(private readonly tokenIds: string[]) {
    super();
  }

  start(): void {
    if (this.tokenIds.length === 0) {
      this.emit("status", "no-tokens");
      return;
    }
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.removeAllListeners();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private connect(): void {
    this.emit("status", "connecting");
    const ws = new WebSocket(config.polymarket.wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.attempts = 0;
      this.emit("status", "live");
      ws.send(JSON.stringify({ type: "market", assets_ids: this.tokenIds }));
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10000);
    });

    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("error", (err) => this.emit("error", err));
    ws.on("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.emit("status", "disconnected");
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.attempts += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts, 5));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onMessage(text: string): void {
    if (text === "PONG" || text === "PING") return;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    const events = Array.isArray(payload) ? payload : [payload];
    for (const ev of events) this.handleEvent(ev as Record<string, unknown>);
  }

  private handleEvent(ev: Record<string, unknown>): void {
    const type = ev["event_type"];
    if (type === "book") {
      const bids = (ev["bids"] as any[]) ?? [];
      const asks = (ev["asks"] as any[]) ?? [];
      // Order book is sorted; the best bid is highest, best ask is lowest.
      const bestBid = bids.length ? Math.max(...bids.map((b) => n(b.price) ?? 0)) : null;
      const bestAsk = asks.length
        ? Math.min(...asks.map((a) => n(a.price) ?? 1).filter((x) => x > 0))
        : null;
      this.emitPrice(String(ev["asset_id"] ?? ""), mid(bestBid, bestAsk));
    } else if (type === "price_change") {
      const changes = (ev["price_changes"] as any[]) ?? [];
      for (const c of changes) {
        const p = mid(n(c.best_bid), n(c.best_ask)) ?? n(c.price);
        this.emitPrice(String(c.asset_id ?? ev["asset_id"] ?? ""), p);
      }
    } else if (type === "last_trade_price") {
      const assetId = ev["asset_id"];
      if (assetId) this.emitPrice(String(assetId), n(ev["price"]));
    }
  }

  private emitPrice(tokenId: string, prob: number | null): void {
    if (!tokenId || prob == null || !Number.isFinite(prob)) return;
    if (prob <= 0 || prob >= 1) return;
    this.emit("price", { tokenId, prob } satisfies PriceUpdate);
  }
}

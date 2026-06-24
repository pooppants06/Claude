/**
 * Shared Polymarket order-execution glue used by both the CLI (trade.ts) and the
 * dashboard server. Dry-run sizing is pure and lives in sizing.ts; this module
 * is only the LIVE path — it needs your key and talks to the CLOB.
 */
import { ClobClient, Side, OrderType, SignatureType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { sharesFor, acceptableFill, roundToTick } from "./sizing.js";

const HOST = "https://clob.polymarket.com";
const CHAIN = 137;

let cached: ClobClient | null = null;

/** Lazily build (and memoise) an authenticated CLOB client from .env creds. */
export async function getClient(): Promise<ClobClient> {
  if (cached) return cached;
  const { PK, FUNDER, SIGNATURE_TYPE } = process.env;
  if (!PK || !FUNDER) throw new Error("LIVE trading needs PK and FUNDER in .env");
  const wallet = new Wallet(PK);
  const sigType = Number(SIGNATURE_TYPE ?? "1") as SignatureType;
  const boot = new ClobClient(HOST, CHAIN, wallet as any);
  const creds = await boot.createOrDeriveApiKey();
  cached = new ClobClient(HOST, CHAIN, wallet as any, creds, sigType, FUNDER);
  return cached;
}

export async function signerAddress(): Promise<string> {
  const { PK } = process.env;
  if (!PK) throw new Error("no PK in .env");
  return new Wallet(PK).getAddress();
}

export interface PlaceReq {
  tokenId: string;
  fairProb: number;
  stake: number;       // USDC to commit
  requiredEdge: number; // min residual edge vs the live ask
}
export interface PlaceResult {
  ok: boolean;
  status: string;
  askPrice?: number;
  limit?: number;
  shares?: number;
  cost?: number;
  resp?: unknown;
}

/**
 * Place a marketable limit BUY against the live book: refuse if the real ask no
 * longer leaves enough edge, round to the market tick, size in whole shares, and
 * post a GTC order. Never sends a market order.
 */
export async function placeLimitBuy(req: PlaceReq): Promise<PlaceResult> {
  const client = await getClient();
  const book = await client.getOrderBook(req.tokenId);
  const asks = (book.asks ?? []).map((a: any) => Number(a.price)).filter((x: number) => x > 0);
  if (!asks.length) return { ok: false, status: "no asks on book" };
  const askPrice = Math.min(...asks);
  let tick = 0.01;
  try { tick = Number(await client.getTickSize(req.tokenId)) || 0.01; } catch { /* default tick */ }

  if (!acceptableFill(req.fairProb, askPrice, req.requiredEdge))
    return { ok: false, status: `ask ${(askPrice * 100).toFixed(1)}¢ leaves < ${req.requiredEdge * 100}pp edge`, askPrice };

  const limit = roundToTick(askPrice, tick);
  const shares = sharesFor(req.stake, limit);
  if (shares < 5) return { ok: false, status: `${shares} shares below minimum`, askPrice, limit, shares };
  const cost = shares * limit;

  const signed = await client.createOrder({ tokenID: req.tokenId, price: limit, side: Side.BUY, size: shares, feeRateBps: 0 });
  const resp = await client.postOrder(signed, OrderType.GTC);
  return { ok: true, status: "posted", askPrice, limit, shares, cost, resp };
}

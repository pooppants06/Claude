/**
 * Interactive Polymarket order placer for the model's +EV picks.
 *
 *   DRY RUN (default, no key needed): prints the bet slip + Kelly sizing.
 *     npx tsx trade.ts --bankroll 500
 *   LIVE (asks y/N before EACH order, posts on yes):
 *     npx tsx trade.ts --bankroll 500 --live
 *
 * Credentials are read from a local .env that you create and NEVER share:
 *   PK=0x...                  # your wallet private key (signs orders)
 *   FUNDER=0x...              # address holding your USDC (proxy or EOA)
 *   SIGNATURE_TYPE=1          # 0=EOA, 1=email/Magic proxy, 2=browser-wallet Safe
 * Funds and the one-time USDC approval are managed by you in the Polymarket UI.
 *
 * Safety: limit (GTC) orders only; refuses fills without residual edge; hard
 * per-bet and total-exposure caps; manual y/N confirmation per order.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ClobClient, Side, OrderType, SignatureType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { kellyStake, sharesFor, acceptableFill, roundToTick } from "./src/trade/sizing.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? "true" : def;
}

const LIVE = !!arg("live");
const BANKROLL = Number(arg("bankroll", "0"));
const KELLY = Number(arg("kelly", "0.25"));
const MAX_STAKE = Number(arg("max-stake", "50"));
const MAX_EXPOSURE = Number(arg("max-exposure", String(BANKROLL * 0.5)));
const MIN_EV = Number(arg("min-ev", "0.05"));
const MIN_EFFN = Number(arg("min-conf", "3"));
const REQUIRED_EDGE = Number(arg("required-edge", "0.02"));
const HOST = "https://clob.polymarket.com";
const CHAIN = 137;

interface Pick {
  title: string; marketLabel: string; selectionLabel: string;
  pmOdds: number; fairProb: number; ev: number; effN: number; pmTokenId: string | null;
}

function loadPicks(): Pick[] {
  const d = JSON.parse(readFileSync("/tmp/multi/accurate.json", "utf8"));
  return (d.top as Pick[])
    .filter((r) => r.pmTokenId && r.ev >= MIN_EV && r.effN >= MIN_EFFN && r.fairProb > 0 && r.fairProb < 1);
}

function fmt(n: number, dp = 2) { return n.toFixed(dp); }

async function main() {
  if (!(BANKROLL > 0)) { console.error("Pass --bankroll <USDC> (your allocation)."); process.exit(1); }
  const picks = loadPicks();
  console.log(`\n${LIVE ? "🔴 LIVE" : "🟡 DRY RUN"} — ${picks.length} picks pass filters `
    + `(EV≥${MIN_EV}, conf≥${MIN_EFFN}). bankroll $${BANKROLL}, ${KELLY}×Kelly, `
    + `cap $${MAX_STAKE}/bet, max exposure $${MAX_EXPOSURE}.\n`);

  let client: ClobClient | null = null;
  if (LIVE) {
    const { PK, FUNDER, SIGNATURE_TYPE } = process.env;
    if (!PK || !FUNDER) { console.error("LIVE mode needs PK and FUNDER in .env"); process.exit(1); }
    const wallet = new Wallet(PK);
    const sigType = Number(SIGNATURE_TYPE ?? "1") as SignatureType;
    const bootstrap = new ClobClient(HOST, CHAIN, wallet as any);
    const creds = await bootstrap.createOrDeriveApiKey();
    client = new ClobClient(HOST, CHAIN, wallet as any, creds, sigType, FUNDER);
    const bal = await client.getBalanceAllowance().catch(() => null);
    console.log(`signer ${await wallet.getAddress()} · funder ${FUNDER} · sigType ${sigType}`
      + (bal ? ` · balance ${JSON.stringify(bal)}` : "") + "\n");
  }

  const rl = LIVE ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let spent = 0, placed = 0;

  for (const [i, pk] of picks.entries()) {
    const price = pk.pmOdds > 1 ? 1 / pk.pmOdds : NaN; // mid-implied buy price proxy
    const baseStake = kellyStake(pk.fairProb, price, { bankroll: BANKROLL, kellyMult: KELLY, maxStakePerBet: MAX_STAKE });
    const stake = Math.min(baseStake, Math.max(0, MAX_EXPOSURE - spent));
    const slip = `#${i + 1} ${pk.title} — ${pk.marketLabel} / ${pk.selectionLabel}\n`
      + `    fair ${fmt(pk.fairProb * 100, 1)}%  buy≈${fmt(price * 100, 1)}¢ (odds ${fmt(pk.pmOdds)})  `
      + `EV +${fmt(pk.ev * 100, 1)}%  conf ${fmt(pk.effN, 1)}  →  stake $${fmt(stake)}`;
    if (stake < 1) { console.log(slip + "  [skip: <$1 or exposure cap]"); continue; }

    if (!LIVE || !client) { console.log(slip + "  [dry-run]"); spent += stake; continue; }

    // Live: check the live book, size against the real ask, confirm, place a limit.
    let askPrice = price, tick = 0.01;
    try {
      const book = await client.getOrderBook(pk.pmTokenId!);
      const asks = (book.asks ?? []).map((a: any) => Number(a.price)).filter((x) => x > 0);
      if (asks.length) askPrice = Math.min(...asks);
      const ts = await client.getTickSize(pk.pmTokenId!);
      tick = Number(ts) || 0.01;
    } catch (e) { console.log(slip + `  [skip: book/tick fetch failed: ${(e as Error).message}]`); continue; }

    if (!acceptableFill(pk.fairProb, askPrice, REQUIRED_EDGE)) {
      console.log(slip + `\n    [skip: ask ${fmt(askPrice * 100, 1)}¢ leaves <${REQUIRED_EDGE * 100}pp edge]`);
      continue;
    }
    const limit = roundToTick(askPrice, tick);
    const shares = sharesFor(stake, limit);
    if (shares < 5) { console.log(slip + `  [skip: ${shares} shares < min]`); continue; }

    console.log(`\n${slip}\n    LIMIT BUY ${shares} sh @ ${fmt(limit * 100, 1)}¢  (cost ≈ $${fmt(shares * limit)})`);
    const ans = (await rl!.question("    place this order? [y/N/q] ")).trim().toLowerCase();
    if (ans === "q") break;
    if (ans !== "y") { console.log("    skipped."); continue; }
    try {
      const signed = await client.createOrder({ tokenID: pk.pmTokenId!, price: limit, side: Side.BUY, size: shares, feeRateBps: 0 });
      const resp = await client.postOrder(signed, OrderType.GTC);
      console.log(`    ✅ posted: ${JSON.stringify(resp)}`);
      spent += shares * limit; placed++;
    } catch (e) { console.log(`    ❌ order failed: ${(e as Error).message}`); }
  }
  rl?.close();
  console.log(`\n${LIVE ? `placed ${placed} order(s), ~$${fmt(spent)} committed` : `dry-run total stake ~$${fmt(spent)}`}.\n`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

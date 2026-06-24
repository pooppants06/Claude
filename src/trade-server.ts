/**
 * Local dashboard for the fair-value model + manual-approve Polymarket trading.
 *
 *   npm run dashboard      → http://127.0.0.1:3100   (dry-run safe by default)
 *
 * Binds to localhost only. Order placement is gated three ways: the request must
 * set live:true, the server must have PK/FUNDER in .env, and ALLOW_LIVE=1 must be
 * set in the environment. Without all three, every order is a dry-run.
 *
 *   GET  /api/picks                 → latest computed picks (reads PICKS_PATH)
 *   POST /api/refresh               → re-run the model pipeline (live PM/NT odds)
 *   POST /api/order  { ... }        → size + (dry-run | place) a single order
 *   GET  /api/account               → live wallet balance (live mode only)
 */
import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import express from "express";
import { kellyStake, sharesFor } from "./trade/sizing.js";
import { placeLimitBuy, getClient, signerAddress } from "./trade/execute.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PICKS_PATH = process.env.PICKS_PATH ?? "/tmp/multi/accurate.json";
const PORT = Number(process.env.GUI_PORT ?? "3100");
const ALLOW_LIVE = process.env.ALLOW_LIVE === "1";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function readPicks() {
  if (!existsSync(PICKS_PATH)) return { at: null, top: [], total: 0 };
  return JSON.parse(readFileSync(PICKS_PATH, "utf8"));
}

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));

app.get("/api/picks", (_req, res) => {
  try {
    res.json({ ...readPicks(), liveEnabled: ALLOW_LIVE && !!process.env.PK && !!process.env.FUNDER });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

let refreshing: Promise<void> | null = null;
app.post("/api/refresh", async (_req, res) => {
  if (!refreshing) {
    refreshing = new Promise<void>((resolve, reject) => {
      const child = spawn("npx", ["tsx", "accurate.ts"], { cwd: ROOT, env: process.env });
      let err = "";
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-500) || `exit ${code}`))));
    }).finally(() => { refreshing = null; });
  }
  try { await refreshing; res.json({ ...readPicks() }); }
  catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

app.get("/api/account", async (_req, res) => {
  if (!ALLOW_LIVE) return res.json({ live: false });
  try {
    const client = await getClient();
    const [addr, bal] = await Promise.all([signerAddress(), client.getBalanceAllowance().catch(() => null)]);
    res.json({ live: true, signer: addr, funder: process.env.FUNDER, balance: bal });
  } catch (e) { res.json({ live: false, error: (e as Error).message }); }
});

app.post("/api/order", async (req, res) => {
  try {
    const { pmTokenId, pmOdds, fairProb, bankroll, kellyMult, maxStake, maxExposure, spent, requiredEdge, live } =
      req.body ?? {};
    const price = pmOdds > 1 ? 1 / pmOdds : NaN;
    let stake = kellyStake(fairProb, price, { bankroll: Number(bankroll), kellyMult: Number(kellyMult), maxStakePerBet: Number(maxStake) });
    if (Number.isFinite(maxExposure)) stake = Math.min(stake, Math.max(0, Number(maxExposure) - Number(spent ?? 0)));
    if (!(stake >= 1)) return res.json({ ok: false, status: "stake < $1 (no edge or exposure cap reached)", stake });

    const goLive = !!live && ALLOW_LIVE && !!process.env.PK && !!process.env.FUNDER;
    if (!goLive) {
      const shares = sharesFor(stake, price);
      return res.json({ ok: true, dryRun: true, status: "dry-run", stake, price, shares, cost: shares * price });
    }
    const result = await placeLimitBuy({ tokenId: pmTokenId, fairProb: Number(fairProb), stake, requiredEdge: Number(requiredEdge ?? 0.02) });
    res.json({ ...result, dryRun: false, stake });
  } catch (e) { res.status(500).json({ ok: false, status: (e as Error).message }); }
});

const server = http.createServer(app);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Trading dashboard →  http://127.0.0.1:${PORT}`);
  console.log(`  picks: ${PICKS_PATH}`);
  console.log(`  live trading: ${ALLOW_LIVE ? (process.env.PK ? "ARMED (ALLOW_LIVE=1, key present)" : "blocked (no PK in .env)") : "OFF (set ALLOW_LIVE=1 to arm)"}\n`);
});

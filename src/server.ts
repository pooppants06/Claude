/**
 * HTTP + WebSocket server.
 *
 *   POST /api/track     { url }      -> { slug, snapshot }   (creates/reuses a feed)
 *   GET  /api/snapshot  ?slug=...    -> snapshot             (polling fallback)
 *   WS   /stream        ?slug=...    -> { type:"snapshot", data } live pushes
 *   GET  /                            -> single-page UI
 */

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { Tracker } from "./tracker.js";
import { extractSlug } from "./sources/polymarket/gamma.js";
import type { ComparisonSnapshot } from "./compare/compare.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Entry {
  tracker: Tracker;
  clients: Set<WebSocket>;
  snapshot: ComparisonSnapshot | null;
  graceTimer: NodeJS.Timeout | null;
}

const entries = new Map<string, Entry>();
const starting = new Map<string, Promise<Entry>>();

async function ensureTracker(url: string): Promise<Entry> {
  const slug = extractSlug(url);
  const existing = entries.get(slug);
  if (existing) return existing;
  const inflight = starting.get(slug);
  if (inflight) return inflight;

  const promise = (async () => {
    const tracker = new Tracker();
    const entry: Entry = { tracker, clients: new Set(), snapshot: null, graceTimer: null };
    tracker.on("snapshot", (s: ComparisonSnapshot) => {
      entry.snapshot = s;
      broadcast(entry, { type: "snapshot", data: s });
    });
    entry.snapshot = await tracker.start(url);
    entries.set(slug, entry);
    starting.delete(slug);
    return entry;
  })();

  starting.set(slug, promise);
  try {
    return await promise;
  } catch (err) {
    starting.delete(slug);
    throw err;
  }
}

function broadcast(entry: Entry, msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const ws of entry.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function addClient(slug: string, ws: WebSocket): void {
  const entry = entries.get(slug);
  if (!entry) {
    ws.send(JSON.stringify({ type: "error", message: `No active feed for "${slug}". POST /api/track first.` }));
    return;
  }
  entry.clients.add(ws);
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }
  if (entry.snapshot) ws.send(JSON.stringify({ type: "snapshot", data: entry.snapshot }));
}

function removeClient(slug: string, ws: WebSocket): void {
  const entry = entries.get(slug);
  if (!entry) return;
  entry.clients.delete(ws);
  // Tear the feed down shortly after the last viewer leaves.
  if (entry.clients.size === 0 && !entry.graceTimer) {
    entry.graceTimer = setTimeout(() => {
      entry.tracker.stop();
      entries.delete(slug);
    }, 30000);
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/track", async (req, res) => {
  const url = String(req.body?.url ?? "").trim();
  if (!url) return res.status(400).json({ error: "Provide a Polymarket match URL in { url }." });
  try {
    const entry = await ensureTracker(url);
    res.json({ slug: extractSlug(url), snapshot: entry.snapshot });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/snapshot", (req, res) => {
  const slug = String(req.query.slug ?? "");
  const entry = entries.get(slug);
  if (!entry?.snapshot) return res.status(404).json({ error: "No snapshot for that slug." });
  res.json(entry.snapshot);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", (ws, req) => {
  const slug = new URL(req.url ?? "", "http://localhost").searchParams.get("slug") ?? "";
  addClient(slug, ws);
  ws.on("close", () => removeClient(slug, ws));
  ws.on("error", () => removeClient(slug, ws));
});

server.listen(config.port, () => {
  console.log(`\n  OddsEdge running →  http://localhost:${config.port}`);
  console.log(`  Norsk Tipping provider: ${config.norskTipping.provider}\n`);
});

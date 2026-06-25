import { readFileSync } from "node:fs";
import puppeteer from "puppeteer";

const d = JSON.parse(readFileSync("/tmp/multi/compare5.json", "utf8"));

// Flatten every selection across ALL matches; EV = back-value on Polymarket
// vs the OA-Shin consensus.
const all: any[] = [];
for (const m of d.matches) {
  for (const r of m.rows) {
    if (!(r.pm > 1) || !(r.oaShin > 1)) continue;
    all.push({ match: m.title, ...r, ev: r.pm / r.oaShin - 1 });
  }
}
all.sort((a, b) => b.ev - a.ev);

const od = (v: number | null) => (v != null ? v.toFixed(2) : "—");
function rowsHtml(rows: any[]) {
  return rows.map((r, i) => {
    const spr = r.pmSpread != null ? (r.pmSpread * 100).toFixed(1) + "¢" : "—";
    const oa = `${od(r.oaShin)}<span class="bk"> ${r.oaBooks}bk</span>`;
    return `<tr>
      <td class="rank">${i + 1}</td>
      <td class="match">${r.match}</td>
      <td class="mkt">${r.market.replace("Total Goals — ", "")}</td>
      <td class="sel">${r.selection}</td>
      <td class="num pm">${od(r.pm)}</td>
      <td class="num oa">${oa}</td>
      <td class="num">${od(r.nt)}</td>
      <td class="num ntsh">${od(r.ntShin)}</td>
      <td class="num sprd">${spr}</td>
      <td class="num ev">+${(r.ev * 100).toFixed(1)}%</td>
    </tr>`;
  }).join("");
}

function page(title: string, sub: string, rows: any[]) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:26px 32px}
h1{font-size:22px;font-weight:700}
.sub{color:#8b949e;font-size:12.5px;margin:3px 0 4px}
.leg{color:#7d8590;font-size:11px;margin-bottom:14px;line-height:1.5}
.leg b{color:#adbac7}
table{border-collapse:collapse;width:100%;font-size:12.5px}
thead th{background:#161b22;color:#8b949e;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.4px;padding:8px;text-align:left;border-bottom:2px solid #30363d}
thead th.num{text-align:right}
tbody td{padding:6px 8px;border-bottom:1px solid #1b2129;white-space:nowrap}
tr:nth-child(even) td{background:#0f141b}
.rank{color:#6e7681;font-variant-numeric:tabular-nums;width:28px}
.match{font-weight:600}
.mkt{color:#8b949e;font-size:11.5px}
.sel{color:#d2a8ff;font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums}
.pm{color:#79c0ff;font-weight:700}
.oa{color:#f0883e;font-weight:700}
.ntsh{color:#7ee787}
.sprd{color:#6e7681;font-size:11.5px}
.ev{color:#3fb950;font-weight:700}
.bk{color:#56616b;font-size:10px;font-weight:400}
thead th.pmh{color:#79c0ff}thead th.oah{color:#f0883e}thead th.nsh{color:#7ee787}thead th.evh{color:#3fb950}
</style></head><body>
<h1>${title}</h1>
<div class="sub">${sub}</div>
<div class="leg"><b>PM</b> Polymarket odds · <b>OA-Shin</b> Odds-API all-books average, de-vigged (Shin) + book count · <b>NT</b> Norsk Tipping raw · <b>NT-Shin</b> NT de-vigged · <b>Spread</b> PM order-book spread · <b>EV</b> = PM ÷ OA-Shin − 1.</div>
<table>
<thead><tr>
  <th class="rank">#</th><th>Match</th><th>Market</th><th>Selection</th>
  <th class="num pmh">PM</th><th class="num oah">OA-Shin</th>
  <th class="num">NT</th><th class="num nsh">NT-Shin</th><th class="num">Spread</th><th class="num evh">EV</th>
</tr></thead>
<tbody>${rowsHtml(rows)}</tbody></table></body></html>`;
}

const lists = [
  { file: "/tmp/multi/top60_all.png", title: "World Cup 2026 — Top 60 highest-edge bets (all upcoming games)",
    sub: "All selections across every upcoming match, ranked by EV vs the Odds-API ~40-book Shin consensus. No odds cap — the very top are deep-longshot tail totals (read the book count).",
    rows: all.slice(0, 60) },
  { file: "/tmp/multi/top60_under10.png", title: "World Cup 2026 — Top 60 highest-edge bets · odds under 10",
    sub: "Same ranking, restricted to Polymarket odds below 10.0 — filters out most deep-longshot noise.",
    rows: all.filter((r) => r.pm < 10).slice(0, 60) },
  { file: "/tmp/multi/top60_under5.png", title: "World Cup 2026 — Top 60 highest-edge bets · odds under 5",
    sub: "Same ranking, restricted to Polymarket odds below 5.0 — favourites and main lines, the most reliable edges.",
    rows: all.filter((r) => r.pm < 5).slice(0, 60) },
];

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  for (const L of lists) {
    const pg = await browser.newPage();
    await pg.setViewport({ width: 1180, height: 1000, deviceScaleFactor: 2 });
    await pg.setContent(page(L.title, L.sub, L.rows), { waitUntil: "networkidle0" });
    const el = await pg.$("body");
    await el!.screenshot({ path: L.file });
    await pg.close();
    console.log("wrote", L.file, `(${L.rows.length} rows)`);
  }
  await browser.close();
})();

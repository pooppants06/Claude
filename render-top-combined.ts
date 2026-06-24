import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer";

const d = JSON.parse(readFileSync("/tmp/multi/compare5.json", "utf8"));

// Flatten every selection across the 5 matches, attach its match, score by value
// vs the OA-Shin consensus: EV backing on Polymarket = pmOdds/oaShinOdds − 1.
const all: any[] = [];
for (const m of d.matches) {
  for (const r of m.rows) {
    if (!(r.pm > 1) || !(r.oaShin > 1)) continue;
    const pmProb = 1 / r.pm, oaProb = 1 / r.oaShin;
    if (Math.min(pmProb, oaProb) < 0.03) continue; // drop deep-longshot noise (>~33.0)
    all.push({ match: m.title, ...r, ev: r.pm / r.oaShin - 1 });
  }
}
all.sort((a, b) => b.ev - a.ev);
const top = all.slice(0, 28);

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

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:30px 38px}
h1{font-size:23px;font-weight:700}
.sub{color:#8b949e;font-size:13px;margin:3px 0 4px}
.leg{color:#7d8590;font-size:11.5px;margin-bottom:16px;line-height:1.5}
.leg b{color:#adbac7}
table{border-collapse:collapse;width:100%;font-size:13px}
thead th{background:#161b22;color:#8b949e;font-weight:600;text-transform:uppercase;font-size:10.5px;letter-spacing:.4px;padding:10px 9px;text-align:left;border-bottom:2px solid #30363d}
thead th.num{text-align:right}
tbody td{padding:8px 9px;border-bottom:1px solid #1b2129;white-space:nowrap}
tr:nth-child(even) td{background:#0f141b}
.rank{color:#6e7681;font-variant-numeric:tabular-nums;width:30px}
.match{font-weight:600}
.mkt{color:#8b949e;font-size:12px}
.sel{color:#d2a8ff;font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums}
.pm{color:#79c0ff;font-weight:700}
.oa{color:#f0883e;font-weight:700}
.ntsh{color:#7ee787}
.sprd{color:#6e7681;font-size:12px}
.ev{color:#3fb950;font-weight:700}
.bk{color:#56616b;font-size:10.5px;font-weight:400}
thead th.pmh{color:#79c0ff}thead th.oah{color:#f0883e}thead th.nsh{color:#7ee787}thead th.evh{color:#3fb950}
</style></head><body>
<h1>World Cup 2026 — Top value bets across the next 5 matches</h1>
<div class="sub">All selections combined, ranked by value vs the Odds-API ~40-book Shin consensus — where Polymarket pays longer than fair.</div>
<div class="leg"><b>PM</b> Polymarket odds · <b>OA-Shin</b> Odds-API all-books average, de-vigged (Shin) + book count · <b>NT</b> Norsk Tipping raw · <b>NT-Shin</b> NT de-vigged · <b>Spread</b> PM order-book spread · <b>EV</b> = PM ÷ OA-Shin − 1 (edge if OA-Shin is the true price). Deep longshots (&gt;33.0) excluded.</div>
<table>
<thead><tr>
  <th class="rank">#</th><th>Match</th><th>Market</th><th>Selection</th>
  <th class="num pmh">PM</th><th class="num oah">OA-Shin</th>
  <th class="num">NT</th><th class="num nsh">NT-Shin</th><th class="num">Spread</th><th class="num evh">EV</th>
</tr></thead>
<tbody>${rowsHtml(top)}</tbody></table></body></html>`;

(async () => {
  writeFileSync("/tmp/multi/top_combined.html", html);
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1180, height: 900, deviceScaleFactor: 2 });
  await pg.setContent(html, { waitUntil: "networkidle0" });
  const el = await pg.$("body");
  await el!.screenshot({ path: "/tmp/multi/top_combined.png" });
  await browser.close();
  console.log("wrote /tmp/multi/top_combined.png");
  top.slice(0, 10).forEach((r: any, i: number) => console.log(`${i + 1}. +${(r.ev * 100).toFixed(1)}%  ${r.match} — ${r.market}/${r.selection}  PM ${r.pm.toFixed(2)} OA ${r.oaShin.toFixed(2)}`));
})();

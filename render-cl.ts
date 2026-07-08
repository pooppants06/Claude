import { readFileSync } from "node:fs";
import puppeteer from "puppeteer";

const d = JSON.parse(readFileSync("/tmp/multi/compare5.json", "utf8"));

// Flatten all selections across matches. Rank by EXECUTABLE edge — EV at the
// price you'd actually pay (best ask), not the mid. Fall back to mid if no ask.
const all: any[] = [];
for (const m of d.matches) {
  for (const r of m.rows) {
    if (!(r.pm > 1) || !(r.oaShin > 1)) continue;
    if (Math.abs(1 / r.pm - 1 / r.oaShin) > 0.25) continue;      // inversion guard
    if (r.pmSpread != null && r.pmSpread > 0.08) continue;       // illiquid guard
    const buy = r.pmAskOdds && r.pmAskOdds > 1 ? r.pmAskOdds : r.pm;
    all.push({ match: m.title, ...r, buy, evMkt: buy / r.oaShin - 1, evMid: r.pm / r.oaShin - 1 });
  }
}
all.sort((a, b) => b.evMkt - a.evMkt);
const rows = all.slice(0, 32);

const od = (v: number | null) => (v != null && v > 0 ? v.toFixed(2) : "—");
const shortMatch = (t: string) => t.replace(/\s*FK$| FC$|^FC | FK | SK | KF | CS$/g, "").replace(/vs\./, "v").slice(0, 34);

function rowsHtml(items: any[]) {
  return items.map((r, i) => {
    const evM = `${r.evMkt >= 0 ? "+" : ""}${(r.evMkt * 100).toFixed(1)}%`;
    return `<tr>
      <td class="rank">${i + 1}</td>
      <td class="match">${shortMatch(r.match)}</td>
      <td class="mkt">${r.market.replace("Total Goals — ", "")}</td>
      <td class="sel">${r.selection}</td>
      <td class="num pm">${od(r.pm)}</td>
      <td class="num buy">${od(r.buy)}</td>
      <td class="num oa">${od(r.oaShin)}<span class="bk"> ${r.oaBooks}bk</span></td>
      <td class="num">${od(r.nt)}</td>
      <td class="num sprd">${r.pmSpread != null ? (r.pmSpread * 100).toFixed(1) + "¢" : "—"}</td>
      <td class="num ${r.evMkt > 0 ? "evpos" : "evneg"}">${evM}</td>
    </tr>`;
  }).join("");
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:26px 32px}
h1{font-size:22px;font-weight:700}.sub{color:#8b949e;font-size:12.5px;margin:3px 0 4px}
.warn{background:#341a00;border:1px solid #9e6a03;color:#e3b341;padding:8px 12px;border-radius:8px;font-size:12px;margin:10px 0 14px}
.leg{color:#7d8590;font-size:11px;margin-bottom:12px;line-height:1.5}.leg b{color:#adbac7}
table{border-collapse:collapse;width:100%;font-size:12.5px}
thead th{background:#161b22;color:#8b949e;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.4px;padding:8px;text-align:left;border-bottom:2px solid #30363d}
thead th.num{text-align:right}
tbody td{padding:7px 8px;border-bottom:1px solid #1b2129;white-space:nowrap}
tr:nth-child(even) td{background:#0f141b}
.rank{color:#6e7681;font-variant-numeric:tabular-nums;width:26px}.match{font-weight:600}.mkt{color:#8b949e;font-size:11.5px}
.sel{color:#d2a8ff;font-weight:600}.num{text-align:right;font-variant-numeric:tabular-nums}
.pm{color:#79c0ff}.buy{color:#79c0ff;font-weight:700}.oa{color:#f0883e;font-weight:700}
.sprd{color:#6e7681;font-size:11.5px}.evpos{color:#3fb950;font-weight:700}.evneg{color:#6e7681}.bk{color:#56616b;font-size:10px;font-weight:400}
thead th.buyh{color:#79c0ff}thead th.oah{color:#f0883e}thead th.evh{color:#3fb950}
</style></head><body>
<h1>Champions League qualifying — today's 4 matches, ranked by executable edge</h1>
<div class="sub">All selections across today's CL-qualifier slate, ranked by EV at the price you'd actually pay (best ask), vs the Odds-API Shin consensus.</div>
<div class="warn">⚠️ Reference is SOFT: 14–21 recreational books with ~10% margins — not a sharp consensus. Treat every "edge" here as unproven; on the liquid lines Polymarket may be the sharper price (fading it = −EV).</div>
<div class="leg"><b>PM</b> Polymarket mid · <b>Mkt Buy</b> best-ask odds you'd actually get · <b>OA-Shin</b> Odds-API all-books de-vig (Shin) + book count · <b>NT</b> Norsk Tipping raw · <b>Spread</b> PM bid/ask · <b>EV</b> = Mkt Buy ÷ OA-Shin − 1 (edge at the executable price).</div>
<table><thead><tr>
  <th class="rank">#</th><th>Match</th><th>Market</th><th>Selection</th>
  <th class="num">PM</th><th class="num buyh">Mkt Buy</th><th class="num oah">OA-Shin</th><th class="num">NT</th><th class="num">Spread</th><th class="num evh">EV@mkt</th>
</tr></thead><tbody>${rowsHtml(rows)}</tbody></table></body></html>`;

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1200, height: 1000, deviceScaleFactor: 2 });
  await pg.setContent(html, { waitUntil: "networkidle0" });
  const el = await pg.$("body");
  await el!.screenshot({ path: "/tmp/multi/cl_today.png" });
  await browser.close();
  console.log("wrote /tmp/multi/cl_today.png,", rows.length, "rows");
  rows.slice(0, 8).forEach((r: any) => console.log(`${(r.evMkt * 100 >= 0 ? "+" : "") + (r.evMkt * 100).toFixed(1)}%  ${shortMatch(r.match)} — ${r.market.replace("Total Goals — ", "")}/${r.selection}  buy ${r.buy.toFixed(2)} OA ${r.oaShin.toFixed(2)} ${r.oaBooks}bk`));
})();

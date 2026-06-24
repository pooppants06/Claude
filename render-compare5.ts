import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer";

const d = JSON.parse(readFileSync("/tmp/multi/compare5.json", "utf8"));

const od = (v: number | null) => (v != null ? v.toFixed(2) : "—");

function rowsHtml(rows: any[]) {
  return rows.map((r) => {
    const spr = r.pmSpread != null ? (r.pmSpread * 100).toFixed(1) + "¢" : "—";
    const oa = r.oaShin != null ? `${od(r.oaShin)}<span class="bk"> ${r.oaBooks}bk</span>` : "—";
    const ev = r.pm > 1 && r.oaShin > 1 ? r.pm / r.oaShin - 1 : null;
    const evCell = ev == null ? "—" : `${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`;
    const evCls = ev == null ? "" : ev > 0 ? "evpos" : "evneg";
    return `<tr class="${r.firstInMarket ? "grp" : ""}">
      <td class="mkt">${r.firstInMarket ? r.market : ""}</td>
      <td class="sel">${r.selection}</td>
      <td class="num pm">${od(r.pm)}</td>
      <td class="num oa">${oa}</td>
      <td class="num">${od(r.nt)}</td>
      <td class="num ntsh">${od(r.ntShin)}</td>
      <td class="num sprd">${spr}</td>
      <td class="num ${evCls}">${evCell}</td>
    </tr>`;
  }).join("");
}

function page(m: any) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#e6edf3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:30px 36px}
  h1{font-size:23px;font-weight:700}
  .sub{color:#8b949e;font-size:13px;margin:3px 0 4px}
  .leg{color:#7d8590;font-size:11.5px;margin-bottom:16px;line-height:1.5}
  .leg b{color:#adbac7}
  table{border-collapse:collapse;width:100%;font-size:13.5px}
  thead th{background:#161b22;color:#8b949e;font-weight:600;text-transform:uppercase;font-size:10.5px;letter-spacing:.4px;padding:10px 10px;text-align:left;border-bottom:2px solid #30363d}
  thead th.num{text-align:right}
  tbody td{padding:7px 10px;border-bottom:1px solid #1b2129;white-space:nowrap}
  tr.grp td{border-top:2px solid #30363d}
  .mkt{color:#8b949e;font-size:12px;font-weight:600}
  .sel{color:#d2a8ff;font-weight:600}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .pm{color:#79c0ff;font-weight:700}
  .oa{color:#f0883e;font-weight:700}
  .ntsh{color:#7ee787}
  .sprd{color:#6e7681;font-size:12px}
  .evpos{color:#3fb950;font-weight:700}
  .evneg{color:#6e7681}
  .bk{color:#56616b;font-size:10.5px;font-weight:400}
  thead th.pmh{color:#79c0ff}thead th.oah{color:#f0883e}thead th.nsh{color:#7ee787}thead th.evh{color:#3fb950}
  </style></head><body>
  <h1>${m.title}</h1>
  <div class="sub">FIFA World Cup 2026 · kickoff ${m.date} · Polymarket vs. Odds-API (Shin) vs. Norsk Tipping</div>
  <div class="leg"><b>PM</b> Polymarket decimal odds · <b>OA-Shin</b> Odds-API average of all books, de-vigged (Shin) + book count · <b>NT</b> Norsk Tipping raw · <b>NT-Shin</b> Norsk Tipping de-vigged (Shin) · <b>Spread</b> Polymarket order-book bid/ask spread · <b>EV</b> = PM ÷ OA-Shin − 1 (edge backing on Polymarket if OA-Shin is the true price).</div>
  <table>
  <thead><tr>
    <th>Market</th><th>Selection</th>
    <th class="num pmh">PM</th><th class="num oah">OA-Shin</th>
    <th class="num">NT</th><th class="num nsh">NT-Shin</th><th class="num">Spread</th><th class="num evh">EV</th>
  </tr></thead>
  <tbody>${rowsHtml(m.rows)}</tbody></table></body></html>`;
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const files: string[] = [];
  for (const [i, m] of d.matches.entries()) {
    const file = `/tmp/multi/cmp5_${i + 1}.png`;
    const pg = await browser.newPage();
    await pg.setViewport({ width: 1090, height: 900, deviceScaleFactor: 2 });
    await pg.setContent(page(m), { waitUntil: "networkidle0" });
    const el = await pg.$("body");
    await el!.screenshot({ path: file });
    await pg.close();
    files.push(file);
    console.log("wrote", file);
  }
  await browser.close();
  writeFileSync("/tmp/multi/cmp5_files.json", JSON.stringify(files));
})();

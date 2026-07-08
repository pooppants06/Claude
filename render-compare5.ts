import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer";

const d = JSON.parse(readFileSync("/tmp/multi/compare5.json", "utf8"));

const od = (v: number | null) => (v != null ? v.toFixed(2) : "—");

function rowsHtml(rows: any[]) {
  // Sort each match's selections by EV (highest value first); rows with no
  // OA-Shin (no EV) fall to the bottom. Market shown on every row now.
  // Quarantine PM-vs-consensus inversions (>25pp gap = data error) and illiquid
  // PM prices (bid/ask spread > 8¢ = unreliable midpoint) from the EV ranking.
  const clean = rows.filter((r) =>
    !(r.pm > 1 && r.oaShin > 1 && Math.abs(1 / r.pm - 1 / r.oaShin) > 0.25) &&
    !(r.pmSpread != null && r.pmSpread > 0.08));
  const withEv = clean.map((r) => ({ ...r, ev: r.pm > 1 && r.oaShin > 1 ? r.pm / r.oaShin - 1 : null }));
  withEv.sort((a, b) => (b.ev ?? -Infinity) - (a.ev ?? -Infinity));
  const TOP = Number(process.env.TOP ?? "0");
  const shown = TOP > 0 ? withEv.slice(0, TOP) : withEv;
  return shown.map((r) => {
    const spr = r.pmSpread != null ? (r.pmSpread * 100).toFixed(1) + "¢" : "—";
    const oa = r.oaShin != null ? `${od(r.oaShin)}<span class="bk"> ${r.oaBooks}bk</span>` : "—";
    const evCell = r.ev == null ? "—" : `${r.ev >= 0 ? "+" : ""}${(r.ev * 100).toFixed(1)}%`;
    const evCls = r.ev == null ? "" : r.ev > 0 ? "evpos" : "evneg";
    // Executable views: EV re-computed at the price you'd actually get.
    const exec = (odds: number | null) => {
      if (!(odds && odds > 1)) return `<td class="num">—</td>`;
      if (!(r.oaShin > 1)) return `<td class="num">${od(odds)}</td>`;
      const e = odds / r.oaShin - 1;
      return `<td class="num ${e > 0 ? "evpos" : "evneg"}">${od(odds)} <span class="subev">${e >= 0 ? "+" : ""}${(e * 100).toFixed(1)}%</span></td>`;
    };
    return `<tr>
      <td class="mkt">${r.market}</td>
      <td class="sel">${r.selection}</td>
      <td class="num pm">${od(r.pm)}</td>
      ${exec(r.pmAskOdds ?? null)}
      ${exec(r.pmBidOdds ?? null)}
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
  tbody tr:nth-child(even) td{background:#0f141b}
  .mkt{color:#8b949e;font-size:12px;font-weight:600}
  .sel{color:#d2a8ff;font-weight:600}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .pm{color:#79c0ff;font-weight:700}
  .oa{color:#f0883e;font-weight:700}
  .ntsh{color:#7ee787}
  .sprd{color:#6e7681;font-size:12px}
  .evpos{color:#3fb950;font-weight:700}
  .evneg{color:#6e7681}
  .subev{font-size:10.5px;font-weight:600}
  .bk{color:#56616b;font-size:10.5px;font-weight:400}
  thead th.pmh{color:#79c0ff}thead th.oah{color:#f0883e}thead th.nsh{color:#7ee787}thead th.evh{color:#3fb950}
  </style></head><body>
  <h1>${m.title}</h1>
  <div class="sub">FIFA World Cup 2026 · kickoff ${m.date} · Polymarket vs. Odds-API (Shin) vs. Norsk Tipping</div>
  <div class="leg"><b>PM Mid</b> Polymarket midpoint odds · <b>Mkt Buy</b> odds buying NOW at the best ask (+EV at that price) · <b>Limit Buy</b> odds if filled at the best resting bid (+EV) · <b>OA-Shin</b> Odds-API average of all books, de-vigged (Shin) + book count · <b>NT</b> Norsk Tipping raw · <b>NT-Shin</b> NT de-vigged (Shin) · <b>Spread</b> PM bid/ask spread · <b>EV (mid)</b> = PM Mid ÷ OA-Shin − 1.</div>
  <table>
  <thead><tr>
    <th>Market</th><th>Selection</th>
    <th class="num pmh">PM Mid</th><th class="num pmh">Mkt Buy</th><th class="num pmh">Limit Buy</th>
    <th class="num oah">OA-Shin</th>
    <th class="num">NT</th><th class="num nsh">NT-Shin</th><th class="num">Spread</th><th class="num evh">EV (mid)</th>
  </tr></thead>
  <tbody>${rowsHtml(m.rows)}</tbody></table></body></html>`;
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const files: string[] = [];
  for (const [i, m] of d.matches.entries()) {
    const file = `/tmp/multi/cmp5_${i + 1}.png`;
    const pg = await browser.newPage();
    await pg.setViewport({ width: 1340, height: 900, deviceScaleFactor: 2 });
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

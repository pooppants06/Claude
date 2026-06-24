import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer";

const d = JSON.parse(readFileSync("/tmp/multi/top.json", "utf8"));
const top: any[] = d.top;

function rows(items: any[], startIdx: number) {
  return items
    .map((r, i) => {
      const rank = startIdx + i + 1;
      const edge = ((r.ratio - 1) * 100).toFixed(1);
      return `<tr>
        <td class="rank">${rank}</td>
        <td class="match">${r.title}</td>
        <td class="mkt">${r.marketLabel}</td>
        <td class="sel">${r.selectionLabel}</td>
        <td class="num pm">${r.pmOdds.toFixed(2)}</td>
        <td class="num">${r.ntOdds.toFixed(2)}</td>
        <td class="num">${r.ntShinOdds.toFixed(2)}</td>
        <td class="num oa">${r.oaShinOdds.toFixed(2)}</td>
        <td class="num ratio">${r.ratio.toFixed(3)}×</td>
        <td class="num edge">+${edge}%</td>
      </tr>`;
    })
    .join("");
}

function page(items: any[], startIdx: number, partLabel: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#e6edf3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:34px 40px}
  h1{font-size:25px;font-weight:700;margin-bottom:4px}
  .sub{color:#8b949e;font-size:13.5px;margin-bottom:6px}
  .leg{color:#7d8590;font-size:12px;margin-bottom:18px;line-height:1.5}
  .leg b{color:#adbac7}
  table{border-collapse:collapse;width:100%;font-size:13.5px}
  thead th{background:#161b22;color:#8b949e;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.4px;padding:11px 9px;text-align:left;border-bottom:2px solid #30363d}
  thead th.num{text-align:right}
  tbody td{padding:9px 9px;border-bottom:1px solid #21262d;white-space:nowrap}
  tr:nth-child(even) td{background:#11161d}
  .rank{color:#6e7681;font-variant-numeric:tabular-nums;width:34px}
  .match{color:#e6edf3;font-weight:600}
  .mkt{color:#8b949e;font-size:12.5px}
  .sel{color:#d2a8ff;font-weight:600}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .pm{color:#79c0ff;font-weight:700}
  .oa{color:#f0883e;font-weight:700}
  .ratio{color:#e6edf3;font-weight:600}
  .edge{color:#3fb950;font-weight:700}
  thead th.pmh{color:#79c0ff}
  thead th.oah{color:#f0883e}
  </style></head><body>
  <h1>World Cup 2026 — Polymarket vs. Odds-API consensus (Shin) · ${partLabel}</h1>
  <div class="sub">Top 40 outcomes where Polymarket prices a bet shorter (more likely) than the de-vigged ~40-book market — sorted by PM÷OA-Shin probability ratio.</div>
  <div class="leg"><b>PM</b> = Polymarket decimal odds · <b>NT</b> = Norsk Tipping raw · <b>NT-Shin</b> = NT de-vigged (Shin) · <b>OA-Shin</b> = Odds-API average-of-all-books, de-vigged (Shin) · <b>Ratio</b> = PM-implied % ÷ OA-Shin % · <b>Edge</b> = PM's extra implied probability vs. the market.</div>
  <table>
  <thead><tr>
    <th class="rank">#</th><th>Match</th><th>Market</th><th>Selection</th>
    <th class="num pmh">PM</th><th class="num">NT</th><th class="num">NT-Shin</th>
    <th class="num oah">OA-Shin</th><th class="num">Ratio</th><th class="num">Edge</th>
  </tr></thead>
  <tbody>${rows(items, startIdx)}</tbody></table></body></html>`;
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const parts = [
    { items: top.slice(0, 20), start: 0, label: "Part 1 (1–20)", file: "/tmp/multi/top40_p1.png" },
    { items: top.slice(20, 40), start: 20, label: "Part 2 (21–40)", file: "/tmp/multi/top40_p2.png" },
  ];
  for (const p of parts) {
    const html = page(p.items, p.start, p.label);
    writeFileSync(p.file.replace(".png", ".html"), html);
    const pg = await browser.newPage();
    await pg.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
    await pg.setContent(html, { waitUntil: "networkidle0" });
    const el = await pg.$("body");
    await el!.screenshot({ path: p.file });
    await pg.close();
    console.log("wrote", p.file);
  }
  await browser.close();
})();

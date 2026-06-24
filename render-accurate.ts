import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer";

const d = JSON.parse(readFileSync("/tmp/multi/accurate.json", "utf8"));
const top: any[] = d.top;

function conf(effN: number): { tag: string; cls: string } {
  if (effN >= 5) return { tag: "high", cls: "chi" };
  if (effN >= 3) return { tag: "med", cls: "cmed" };
  return { tag: "low", cls: "clo" };
}

function rows(items: any[], startIdx: number) {
  return items
    .map((r, i) => {
      const c = conf(r.effN);
      const sprd = r.pmSpread != null ? (r.pmSpread * 100).toFixed(1) + "¢" : "—";
      const disp = r.disp != null ? "±" + (r.disp * 100).toFixed(1) : "";
      return `<tr>
        <td class="rank">${startIdx + i + 1}</td>
        <td class="match">${r.title}</td>
        <td class="mkt">${r.marketLabel}</td>
        <td class="sel">${r.selectionLabel}</td>
        <td class="num pm">${r.pmOdds.toFixed(2)}</td>
        <td class="num sprd">${sprd}</td>
        <td class="num">${r.consOdds ? r.consOdds.toFixed(2) : "—"}</td>
        <td class="num">${r.modelOdds.toFixed(2)}</td>
        <td class="num fair">${r.fairOdds.toFixed(2)}</td>
        <td class="num conf"><span class="dot ${c.cls}"></span>${r.effN.toFixed(1)} <span class="disp">${disp}</span></td>
        <td class="num ev">+${(r.ev * 100).toFixed(1)}%</td>
      </tr>`;
    })
    .join("");
}

function page(items: any[], startIdx: number, partLabel: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#e6edf3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:32px 38px}
  h1{font-size:24px;font-weight:700;margin-bottom:4px}
  .sub{color:#8b949e;font-size:13px;margin-bottom:6px}
  .leg{color:#7d8590;font-size:11.5px;margin-bottom:16px;line-height:1.55}
  .leg b{color:#adbac7}
  table{border-collapse:collapse;width:100%;font-size:13px}
  thead th{background:#161b22;color:#8b949e;font-weight:600;text-transform:uppercase;font-size:10.5px;letter-spacing:.4px;padding:10px 8px;text-align:left;border-bottom:2px solid #30363d}
  thead th.num{text-align:right}
  tbody td{padding:8px;border-bottom:1px solid #21262d;white-space:nowrap}
  tr:nth-child(even) td{background:#11161d}
  .rank{color:#6e7681;font-variant-numeric:tabular-nums;width:30px}
  .match{color:#e6edf3;font-weight:600}
  .mkt{color:#8b949e;font-size:12px}
  .sel{color:#d2a8ff;font-weight:600}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .pm{color:#79c0ff;font-weight:700}
  .sprd{color:#6e7681;font-size:11.5px}
  .fair{color:#f0883e;font-weight:700}
  .ev{color:#3fb950;font-weight:700}
  .conf{color:#8b949e;font-size:11.5px}
  .disp{color:#6e7681}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:middle}
  .chi{background:#3fb950}.cmed{background:#d29922}.clo{background:#6e7681}
  thead th.fairh{color:#f0883e}
  thead th.pmh{color:#79c0ff}
  </style></head><body>
  <h1>World Cup 2026 — Best-estimate fair value vs. Polymarket · ${partLabel}</h1>
  <div class="sub">Top 40 +EV bets to back on Polymarket: PM prices these <i>longer</i> than my best probability estimate. Ranked by expected value if the fair estimate is the truth.</div>
  <div class="leg"><b>Fair</b> is built per match: every bookmaker de-vigged individually (Shin) → sharp-weighted consensus; a Dixon–Coles bivariate-Poisson goal model is fit to the deep markets (1X2 + totals) so every line is coherent; the two are blended, shrinking thin coverage toward the model. &nbsp;·&nbsp; <b>PM</b> Polymarket odds · <b>Spread</b> PM book spread · <b>Cons</b> sharp-weighted book consensus · <b>Model</b> goal-model odds · <b>Fair</b> blended estimate · <b>Conf</b> effective book coverage (dot = high/med/low) ±book disagreement · <b>EV</b> edge vs PM. &nbsp;Most edges sit on thinly-covered tail totals (low conf) — treat accordingly.</div>
  <table>
  <thead><tr>
    <th class="rank">#</th><th>Match</th><th>Market</th><th>Selection</th>
    <th class="num pmh">PM</th><th class="num">Spr</th><th class="num">Cons</th><th class="num">Model</th>
    <th class="num fairh">Fair</th><th class="num">Conf</th><th class="num">EV</th>
  </tr></thead>
  <tbody>${rows(items, startIdx)}</tbody></table></body></html>`;
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const parts = [
    { items: top.slice(0, 20), start: 0, label: "Part 1 (1–20)", file: "/tmp/multi/accurate_p1.png" },
    { items: top.slice(20, 40), start: 20, label: "Part 2 (21–40)", file: "/tmp/multi/accurate_p2.png" },
  ];
  for (const p of parts) {
    const html = page(p.items, p.start, p.label);
    writeFileSync(p.file.replace(".png", ".html"), html);
    const pg = await browser.newPage();
    await pg.setViewport({ width: 1380, height: 900, deviceScaleFactor: 2 });
    await pg.setContent(html, { waitUntil: "networkidle0" });
    const el = await pg.$("body");
    await el!.screenshot({ path: p.file });
    await pg.close();
    console.log("wrote", p.file);
  }
  await browser.close();
})();

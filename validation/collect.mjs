// Forward study. Run every 30 minutes (GitHub Actions, see .github/workflows/collect.yml):
//   1. snapshot coins that graduated in the last 40 minutes: the full token-risk score as the live
//      site would show it, plus the launch model's probability, both recorded before the outcome exists;
//   2. label earlier snapshots once 1h, 6h, 24h and 7d have passed.
// Unlike the historical study, nothing here is reconstructed after the fact.
//
//   DATA_DIR=<dir> node validation/collect.mjs

import fs from 'node:fs';
import path from 'node:path';
import { graduated, createdBy, candles, solPrice } from '../lib/pump.js';
import { GRAD_PRICE_SOL, HOUR, findT0, launchFeatures, predict } from '../lib/launch.js';
import { markets, solanaSecurity } from '../lib/sources.js';
import { scoreToken } from '../lib/score.js';

const DIR = process.env.DATA_DIR || new URL('./data/', import.meta.url).pathname;
const FILE = path.join(DIR, 'forward.json');
const model = JSON.parse(fs.readFileSync(new URL('../lib/launch-model.json', import.meta.url)));
const SOL_MINT = '11111111111111111111111111111111';
const HORIZONS = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };
const now = Date.now();

const db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE)) : { rows: [] };
const known = new Set(db.rows.map(r => r.mint));

// ---------- 1. new graduations ----------
const sol = await solPrice();
const grad = GRAD_PRICE_SOL * sol;
const fresh = (await graduated({ max: 150 })).filter(c => !known.has(c.mint) && now - c.created_timestamp < 3 * HOUR && (c.quote_mint || SOL_MINT) === SOL_MINT);
let added = 0;
for (const c of fresh) {
  try {
    const k = await candles(c.mint, { fromMs: c.created_timestamp });
    const t0 = findT0(k, grad);
    if (!t0 || now - t0.t0 > 40 * 60e3) continue; // too late to count as a snapshot taken at graduation
    const made = await createdBy(c.creator, 50).catch(() => null);
    const prior = made?.filter(x => x.created_timestamp < c.created_timestamp);
    const features = launchFeatures(c, k, t0, grad, prior ? { prior: prior.length, priorGraduated: prior.filter(x => x.complete).length } : {});
    let score = null, parts = null, holders = null;
    try {
      const m = await markets(c.mint, 'solana');
      const s = m ? await solanaSecurity(c.mint) : null;
      if (m) {
        const rep = scoreToken({
          kind: 'solana', contract: s?.contract || {}, liquidityUsd: m.liquidityUsd, marketCap: m.marketCap, lpLockedPct: s?.lpLockedPct ?? null,
          holders: s?.holders || [], holderCount: s?.holderCount, insiders: s?.insiders || 0, creatorPct: s?.creatorPct || 0,
          activity: { vol24: m.vol24, buys24: m.buys24, sells24: m.sells24, ch1: m.ch.h1, ch24: m.ch.h24 },
          ageHours: m.ageHours, socials: m.links.length, boosted: m.boosted,
        });
        score = rep.score;
        parts = Object.fromEntries(Object.entries(rep.parts).map(([k, v]) => [k, v.score]));
        holders = { top10: rep.parts.holders.top10, insiders: s?.insiders || 0, count: s?.holderCount || null };
      }
    } catch { /* the score stays null; the launch features are still recorded */ }
    db.rows.push({
      mint: c.mint, symbol: c.symbol, creator: c.creator, created: c.created_timestamp, t0: t0.t0, p0: t0.p0,
      snapshotAt: Date.now(), mayhemState: c.mayhem_state || null,
      features, launchP: predict(features, model), modelFittedAt: model.fittedAt, score, parts, holders, labels: {},
    });
    added++;
  } catch (e) { console.error(c.mint, e.message); }
}

// ---------- 2. labels ----------
let labelled = 0;
for (const r of db.rows) {
  const due = Object.entries(HORIZONS).filter(([h, hrs]) => !r.labels[h] && now > r.t0 + hrs * HOUR);
  if (!due.length) continue;
  const longest = Math.max(...due.map(([, hrs]) => hrs));
  const interval = longest <= 12 ? '1m' : longest <= 72 ? '5m' : '15m';
  try {
    const k = await candles(r.mint, { interval, fromMs: r.t0 });
    for (const [h, hrs] of due) {
      const end = r.t0 + hrs * HOUR;
      const win = k.filter(x => x.t >= r.t0 && x.t < end);
      const last = win.length ? win.at(-1).c : r.p0;
      r.labels[h] = {
        ret: last / r.p0 - 1, dead: last <= 0.1 * r.p0 ? 1 : 0, halved: last <= 0.5 * r.p0 ? 1 : 0,
        doubled: Math.max(r.p0, ...win.map(x => x.h)) >= 2 * r.p0 ? 1 : 0, interval,
      };
      labelled++;
    }
  } catch (e) { console.error('label', r.mint, e.message); }
}

fs.mkdirSync(DIR, { recursive: true });
db.updatedAt = new Date().toISOString();
fs.writeFileSync(FILE, JSON.stringify(db));
console.log(`snapshots +${added} (total ${db.rows.length}), labels +${labelled}`);

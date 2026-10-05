// Historical dataset: every pump.fun coin that graduated in roughly the last day.
// For each one, rebuild what was knowable at graduation (features) and what happened
// afterwards (labels). Output: validation/data/retro.json
//
//   node validation/build-retro.mjs [maxCoins]

import fs from 'node:fs';
import { graduated, createdBy, candles } from '../lib/pump.js';
import { GRAD_PRICE_SOL, findT0, launchFeatures, outcomes } from '../lib/launch.js';

const OUT = new URL('./data/retro.json', import.meta.url);
const SOL_MINT = '11111111111111111111111111111111';
const LIMIT = 1000; // candles per request

/** SOL/USD by 5-minute bucket from Binance, to price the graduation point at the time it happened. */
async function solHistory() {
  const r = await fetch('https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=5m&limit=1000');
  const rows = await r.json();
  const m = new Map(rows.map(k => [k[0], +k[4]]));
  return t => m.get(Math.floor(t / 3e5) * 3e5) ?? rows.at(-1)[4];
}

const max = +process.argv[2] || 1100;
const solAt = await solHistory();
const coins = await graduated({ max });
console.log(`${coins.length} graduated coins listed`);

const rows = [], phantom = [], skipped = {};
const skip = why => { skipped[why] = (skipped[why] || 0) + 1; };
const creators = new Map();

for (const [n, c] of coins.entries()) {
  if (n % 50 === 0) console.log(`${n}/${coins.length}  kept ${rows.length}`);
  if ((c.quote_mint || SOL_MINT) !== SOL_MINT) { skip('non-SOL quote'); continue; }
  try {
    const [k, made] = await Promise.all([
      candles(c.mint, { interval: '1m', fromMs: c.created_timestamp, limit: LIMIT }),
      creators.get(c.creator) || createdBy(c.creator, 50).catch(() => null),
    ]);
    creators.set(c.creator, made);
    if (!k.length) { skip('no candles'); continue; }
    const grad = GRAD_PRICE_SOL * solAt(c.created_timestamp);
    const t0 = findT0(k, grad);
    if (!t0) {
      // Mayhem coins can complete their curve with almost no SOL in it, because the agent's
      // extra supply was sold into the curve. Count these separately instead of mixing them in.
      if (c.mayhem_state) phantom.push({ mint: c.mint, symbol: c.symbol, created: c.created_timestamp, curveSol: (c.virtual_sol_reserves || 0) / 1e9, maxPriceVsGrad: Math.max(...k.map(x => x.h)) / grad, athMcap: c.ath_market_cap });
      skip(c.mayhem_state ? 'mayhem: completed below graduation price' : 'graduation not found in candles');
      continue;
    }
    const prior = made ? made.filter(x => x.created_timestamp < c.created_timestamp) : null;
    const f = launchFeatures(c, k, t0, grad, prior ? { prior: prior.length, priorGraduated: prior.filter(x => x.complete).length } : {});
    const coveredUntil = k.length >= LIMIT ? k.at(-1).t : Date.now();
    rows.push({
      mint: c.mint, symbol: c.symbol, created: c.created_timestamp, t0: t0.t0, p0: t0.p0, solUsd: solAt(t0.t0),
      creator: c.creator, mayhemState: c.mayhem_state || null,
      features: f,
      labels: outcomes(k, t0, coveredUntil, { '1h': 1, '6h': 6, '12h': 12 }),
    });
  } catch (e) { skip('fetch error'); }
}

fs.mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), listed: coins.length, skipped, phantom, rows }));
console.log(`wrote ${rows.length} rows`, skipped);

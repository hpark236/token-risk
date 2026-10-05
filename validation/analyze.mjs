// Fit and evaluate the launch model on the historical dataset (and the forward dataset when
// it has labels). Writes the fitted model to lib/launch-model.json and the report the
// /validation page reads to validation/data/validation.json.
//
//   node validation/analyze.mjs           report only
//   node validation/analyze.mjs --fit     also refit lib/launch-model.json
// DATA_DIR points at the directory holding forward.json; validation.json is written there too.

import fs from 'node:fs';
import path from 'node:path';
import { FEATURES, vectorize } from '../lib/launch.js';
import { scoreToken } from '../lib/score.js';
import { auc, brier, logloss, fitLogistic } from './stats.mjs';

const read = (p, d) => { try { return JSON.parse(fs.readFileSync(new URL(p, import.meta.url))); } catch { return d; } };
const retro = read('./data/retro.json', { rows: [], phantom: [], skipped: {} });
const DIR = process.env.DATA_DIR || new URL('./data/', import.meta.url).pathname;
const forward = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'forward.json'))); } catch { return { rows: [] }; } })();

const TARGET = { horizon: '6h', key: 'dead', text: 'price 6 hours after graduation is at least 90% below the graduation price' };

// ---------- statistics ----------
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const prob = (m, x) => 1 / (1 + Math.exp(-(m.b + x.reduce((s, v, j) => s + m.w[j] * (v - m.mean[j]) / m.sd[j], 0))));

/** k-fold cross-validation grouped by creator, so one wallet's coins never sit on both sides. */
function crossValidate(rows, X, y, lambda, k = 5) {
  const groups = [...new Set(rows.map(r => r.creator))];
  const fold = new Map(groups.map(g => [g, hash(g) % k]));
  const pred = new Array(rows.length);
  for (let f = 0; f < k; f++) {
    const tr = rows.map((r, i) => i).filter(i => fold.get(rows[i].creator) !== f);
    const te = rows.map((r, i) => i).filter(i => fold.get(rows[i].creator) === f);
    const m = fitLogistic(tr.map(i => X[i]), tr.map(i => y[i]), lambda);
    for (const i of te) pred[i] = prob(m, X[i]);
  }
  return pred;
}
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; }

function calibration(p, y, bins = 5) {
  const idx = p.map((_, i) => i).sort((a, b) => p[a] - p[b]);
  return Array.from({ length: bins }, (_, b) => {
    const part = idx.slice(Math.floor(b * idx.length / bins), Math.floor((b + 1) * idx.length / bins));
    return { n: part.length, predicted: mean(part.map(i => p[i])), actual: mean(part.map(i => y[i])), medianReturn: median(part.map(i => rowsT[i].labels[TARGET.horizon].ret)) };
  });
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// ---------- the study ----------
// Training data: the historical set plus every labelled forward snapshot (not already in it).
const seen = new Set(retro.rows.map(r => r.mint));
const pooled = [...retro.rows, ...(forward.rows || []).filter(r => !seen.has(r.mint))];
const rowsT = pooled.filter(r => r.labels?.[TARGET.horizon]);
const X = rowsT.map(r => vectorize(r.features));
const y = rowsT.map(r => r.labels[TARGET.horizon][TARGET.key]);

const lambdas = [0.1, 1, 3, 10, 30];
const cv = lambdas.map(l => { const p = crossValidate(rowsT, X, y, l); return { lambda: l, auc: auc(p, y), brier: brier(p, y), logloss: logloss(p, y), p }; });
const best = cv.reduce((a, b) => (b.logloss < a.logloss ? b : a));
const model = fitLogistic(X, y, best.lambda);

// Baselines: the base rate, the current score (higher score = safer, so negate), and single features.
const baseRate = mean(y);
// The current token-risk score, computed with only what was knowable at graduation. The new
// PumpSwap pool starts with about 79 SOL on each side.
const v1 = rowsT.map(r => {
  const f = r.features;
  return scoreToken({
    kind: 'solana', contract: { mintActive: false, freezeActive: false, mutableMeta: false },
    liquidityUsd: 2 * 79 * (r.solUsd ?? 121), marketCap: r.p0 * 1e9,
    holders: [], holderCount: null,
    activity: { vol24: f.preVolumeUsd, buys24: 0, sells24: 0, txns24: null, ch1: null, ch24: null },
    ageHours: (r.t0 - r.created) / 36e5, socials: f.socials, boosted: false,
  }).score;
});
const univariate = FEATURES.map(([name], j) => {
  const a = auc(X.map(r => r[j]), y);
  return { name, auc: a == null ? null : Math.max(a, 1 - a), direction: a == null ? null : a >= 0.5 ? 'higher = more likely to die' : 'higher = less likely to die' };
}).sort((a, b) => (b.auc ?? 0) - (a.auc ?? 0));

const segment = (label, pick) => {
  const ix = rowsT.map((r, i) => i).filter(i => pick(rowsT[i]));
  return { label, n: ix.length, deadRate: ix.length ? mean(ix.map(i => y[i])) : null, medianReturn: median(ix.map(i => rowsT[i].labels[TARGET.horizon].ret)), doubledRate: ix.length ? mean(ix.map(i => rowsT[i].labels[TARGET.horizon].doubled)) : null };
};

const horizonRates = ['1h', '6h', '12h', '24h', '7d'].map(h => {
  const r = pooled.filter(x => x.labels?.[h]);
  if (!r.length) return null;
  return { horizon: h, n: r.length, dead: mean(r.map(x => x.labels[h].dead)), halved: mean(r.map(x => x.labels[h].halved)), doubled: mean(r.map(x => x.labels[h].doubled)), medianReturn: median(r.map(x => x.labels[h].ret)) };
}).filter(Boolean);

// Forward study: the live token-risk score taken at graduation, scored against later outcomes.
const fwd = (forward.rows || []).filter(r => r.labels?.[TARGET.horizon] && r.score != null);
const forwardReport = {
  collected: (forward.rows || []).length,
  labelled: fwd.length,
  v1Auc: fwd.length >= 20 ? auc(fwd.map(r => -r.score), fwd.map(r => r.labels[TARGET.horizon][TARGET.key])) : null,
  modelAuc: fwd.length >= 20 && fwd.every(r => r.launchP != null) ? auc(fwd.map(r => r.launchP), fwd.map(r => r.labels[TARGET.horizon][TARGET.key])) : null,
  deadRate: fwd.length ? mean(fwd.map(r => r.labels[TARGET.horizon][TARGET.key])) : null,
};

const report = {
  builtAt: new Date().toISOString(),
  dataBuiltAt: retro.builtAt,
  target: TARGET,
  dataset: {
    listed: retro.listed, rows: pooled.length, historical: retro.rows.length, forward: (forward.rows || []).length, labelled: rowsT.length, skipped: retro.skipped,
    from: Math.min(...pooled.map(r => r.t0)), to: Math.max(...pooled.map(r => r.t0)),
    creators: new Set(rowsT.map(r => r.creator)).size,
  },
  horizonRates,
  baseRate,
  models: [
    { name: 'Launch model (logistic, cross-validated by creator)', auc: best.auc, brier: best.brier, logloss: best.logloss },
    { name: 'Current token-risk score at graduation', auc: auc(v1.map(s => -s), y), brier: null, logloss: null, note: 'Holder data is not available retroactively, so this mostly reflects socials and age.' },
    { name: 'Base rate only', auc: 0.5, brier: brier(y.map(() => baseRate), y), logloss: logloss(y.map(() => baseRate), y) },
  ],
  lambdaSearch: cv.map(({ lambda, auc, brier, logloss }) => ({ lambda, auc, brier, logloss })),
  calibration: calibration(best.p, y),
  model: { fittedAt: (() => { try { return JSON.parse(fs.readFileSync(new URL('../lib/launch-model.json', import.meta.url))).fittedAt; } catch { return null; } })() },
  univariate,
  coefficients: FEATURES.map(([name], j) => ({ name, weight: model.w[j] })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
  segments: [
    segment('All graduated coins', () => true),
    segment('Graduated in the first minute', r => r.features.instant),
    segment('Took over 30 minutes to graduate', r => r.features.minutesToGrad > 30),
    segment('Mayhem Mode enabled', r => r.features.mayhem),
    segment('Holder Rewards coin', r => r.features.holderRewards),
    segment('Launched from a trading terminal', r => r.features.terminalLaunch),
    segment('Links a single tweet', r => r.features.tweetLink),
    segment('No socials', r => r.features.socials === 0),
    segment('Creator launched 10+ coins before', r => (r.features.creatorPrior ?? 0) >= 10),
    segment('Creator graduated a coin before', r => (r.features.creatorPriorGraduated ?? 0) > 0),
  ],
  mayhem: {
    phantom: retro.phantom?.length || 0,
    phantomMedianCurveSol: median((retro.phantom || []).map(p => p.curveSol)),
    phantomMedianPeakVsGrad: median((retro.phantom || []).map(p => p.maxPriceVsGrad)),
    reachedGraduation: retro.rows.filter(r => r.features.mayhem).length,
  },
  forward: forwardReport,
};

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'validation.json'), JSON.stringify(report, null, 1));
if (process.argv.includes('--fit')) fs.writeFileSync(new URL('../lib/launch-model.json', import.meta.url), JSON.stringify({
  fittedAt: report.builtAt, target: TARGET, n: rowsT.length, lambda: best.lambda, cvAuc: best.auc, baseRate,
  features: FEATURES.map(([n]) => n), ...model,
}, null, 1));

console.log(`rows ${rowsT.length}, base rate ${(baseRate * 100).toFixed(1)}%`);
console.table(report.models.map(m => ({ model: m.name, auc: m.auc?.toFixed(3), brier: m.brier?.toFixed(4) })));
console.table(report.lambdaSearch);
console.table(report.segments.map(s => ({ ...s, deadRate: s.deadRate?.toFixed(3), medianReturn: s.medianReturn?.toFixed(3), doubledRate: s.doubledRate?.toFixed(3) })));
console.table(univariate.map(u => ({ ...u, auc: u.auc?.toFixed(3) })));
console.table(report.calibration);
console.log(report.mayhem, report.horizonRates);

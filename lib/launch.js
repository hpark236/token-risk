// Launch model for pump.fun coins: features known at graduation, outcome labels after it,
// and a logistic model fitted on past graduations (validation/build-*.mjs, validation/analyze.mjs).
// Pure functions, shared by the API, the browser and the validation scripts.

// The bonding curve completes when 793.1M of the 1.073B virtual tokens are sold:
// 30 SOL * 1.073B / 279.9M virtual tokens left = 115.005 virtual SOL, so the last price is
// 115.005 / 279.9M SOL per token, about 411 SOL of market cap on a 1B supply.
export const GRAD_PRICE_SOL = 115.005 / 279.9e6;
export const HOUR = 36e5;

/**
 * Graduation (decision) point from 1m USD candles: the first candle whose high reaches
 * 90% of the curve's final price. Entry price is that candle's close, because that is the
 * first price a buyer who reacts to graduation could get.
 */
export function findT0(candles, gradPriceUsd) {
  const i = candles.findIndex(k => k.h >= 0.9 * gradPriceUsd);
  if (i < 0) return null;
  return { i, t0: candles[i].t + 60e3, p0: candles[i].c };
}

const host = u => { try { return new URL(u).host; } catch { return ''; } };

/** Features that were all observable at the moment of graduation. */
export function launchFeatures(coin, candles, t0info, gradPriceUsd, creator = {}) {
  const { i, t0 } = t0info;
  const pre = candles.slice(0, i + 1);
  const vol = pre.reduce((a, k) => a + k.v, 0);
  let peak = 0, dd = 0; // on closes, so a single launch candle (open near zero) does not count
  for (const k of pre) { peak = Math.max(peak, k.c); dd = Math.max(dd, 1 - k.c / peak); }
  const meta = host(coin.metadata_uri || '');
  return {
    minutesToGrad: Math.max(0, (pre[i].t - coin.created_timestamp) / 6e4),
    instant: i === 0 ? 1 : 0,                                   // graduated inside its first traded minute
    activeMinutes: pre.length,                                   // minutes with at least one trade
    preVolumeUsd: vol,
    firstMinuteShare: vol > 0 ? pre[0].v / vol : 1,              // bundle / sniper proxy
    firstMinuteCurve: Math.min(pre[0].c / gradPriceUsd, 3),      // how far up the curve the first minute went
    preDrawdown: dd,                                             // worst fall from a high before graduating
    mayhem: coin.mayhem_state ? 1 : 0,
    holderRewards: coin.is_holder_reward ? 1 : 0,
    cashback: coin.is_cashback_enabled ? 1 : 0,
    socials: ['twitter', 'telegram', 'website'].filter(k => coin[k]).length,
    tweetLink: /\/status\/\d+/.test(coin.twitter || '') ? 1 : 0, // links a single tweet, not an account
    terminalLaunch: meta && !/ipfs/.test(meta) ? 1 : 0,          // metadata hosted by a trading terminal, not pump.fun
    tweetImage: /twimg\.com/.test(coin.image_uri || '') ? 1 : 0,
    description: (coin.description || '').trim().length > 0 ? 1 : 0,
    creatorPrior: creator.prior ?? null,                         // coins this wallet launched before
    creatorPriorGraduated: creator.priorGraduated ?? null,
    hourUtc: new Date(t0).getUTCHours(),
  };
}

/**
 * Outcome labels from candles after graduation. `coveredUntil` is the last time the candle data
 * is complete for (now, or the last bar if the fetch hit its limit); later horizons are skipped.
 */
export function outcomes(candles, t0info, coveredUntil, horizons = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 }) {
  const { i, t0, p0 } = t0info;
  const post = candles.slice(i + 1);
  const out = {};
  for (const [name, h] of Object.entries(horizons)) {
    const end = t0 + h * HOUR;
    if (end > coveredUntil) continue;
    const win = post.filter(k => k.t < end);
    const last = win.length ? win[win.length - 1].c : p0;
    const lo = Math.min(p0, ...win.map(k => k.l));
    const hi = Math.max(p0, ...win.map(k => k.h));
    const lastTrade = win.length ? win[win.length - 1].t : candles[i].t;
    out[name] = {
      ret: last / p0 - 1,
      low: lo / p0 - 1,
      high: hi / p0 - 1,
      dead: last <= 0.1 * p0 ? 1 : 0,        // lost 90% or more
      halved: last <= 0.5 * p0 ? 1 : 0,
      doubled: hi >= 2 * p0 ? 1 : 0,        // reached 2x at some point in the window
      quietHours: (end - lastTrade) / HOUR,
    };
  }
  return out;
}

/** Turn raw features into the model's input vector (log scales and caps). */
export const FEATURES = [
  ['logMinutesToGrad', f => Math.log1p(f.minutesToGrad)],
  ['instant', f => f.instant],
  ['logActiveMinutes', f => Math.log1p(f.activeMinutes)],
  ['logPreVolume', f => Math.log1p(f.preVolumeUsd)],
  ['firstMinuteShare', f => f.firstMinuteShare],
  ['firstMinuteCurve', f => f.firstMinuteCurve],
  ['preDrawdown', f => f.preDrawdown],
  ['mayhem', f => f.mayhem],
  ['holderRewards', f => f.holderRewards],
  ['socials', f => f.socials],
  ['tweetLink', f => f.tweetLink],
  ['terminalLaunch', f => f.terminalLaunch],
  ['tweetImage', f => f.tweetImage],
  ['description', f => f.description],
  ['logCreatorPrior', f => Math.log1p(f.creatorPrior ?? 0)],
  ['creatorGraduatedBefore', f => (f.creatorPriorGraduated ?? 0) > 0 ? 1 : 0],
];
export const vectorize = f => FEATURES.map(([, fn]) => fn(f));

/** P(outcome) from a fitted model { mean, sd, w, b }. */
export function predict(f, model) {
  const x = vectorize(f);
  let z = model.b;
  for (let j = 0; j < x.length; j++) z += model.w[j] * (x[j] - model.mean[j]) / (model.sd[j] || 1);
  return 1 / (1 + Math.exp(-z));
}

/** Per-feature contribution to the log-odds, largest first, for explaining one prediction. */
export function explain(f, model) {
  const x = vectorize(f);
  return FEATURES.map(([name], j) => ({ name, value: x[j], logit: model.w[j] * (x[j] - model.mean[j]) / (model.sd[j] || 1) }))
    .sort((a, b) => Math.abs(b.logit) - Math.abs(a.logit));
}

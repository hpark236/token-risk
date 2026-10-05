import test from 'node:test';
import assert from 'node:assert/strict';
import { GRAD_PRICE_SOL, findT0, launchFeatures, outcomes, predict, FEATURES } from '../lib/launch.js';
import { auc, fitLogistic } from '../validation/stats.mjs';

const k = (t, c, v = 100, h = c, l = c) => ({ t, o: c, h, l, c, v });

test('graduation price is the end of the bonding curve', () => {
  // 30 SOL * 1.073B tokens = k; with 279.9M tokens left the curve holds 115.005 SOL
  assert.ok(Math.abs(30 * 1.073e9 / 279.9e6 - 115.005) < 0.001);
  assert.ok(Math.abs(GRAD_PRICE_SOL * 1e9 - 410.88) < 0.01); // about 411 SOL market cap on 1B tokens
});

test('t0 is the first candle reaching 90% of the graduation price', () => {
  const c = [k(0, 1), k(60e3, 5), k(120e3, 9.5, 100, 9.5), k(180e3, 3)];
  const t = findT0(c, 10);
  assert.equal(t.i, 2); assert.equal(t.t0, 180e3); assert.equal(t.p0, 9.5);
  assert.equal(findT0(c, 100), null);
});

test('features use only candles up to graduation', () => {
  const c = [k(0, 2, 1000), k(60e3, 10, 3000), k(120e3, 0.1, 5)];
  const coin = { created_timestamp: 0, mayhem_state: 'active', twitter: 'https://x.com/a/status/1', metadata_uri: 'https://ipfs.io/x' };
  const f = launchFeatures(coin, c, findT0(c, 10), 10, { prior: 3, priorGraduated: 1 });
  assert.equal(f.activeMinutes, 2); assert.equal(f.preVolumeUsd, 4000); assert.equal(f.firstMinuteShare, 0.25);
  assert.equal(f.mayhem, 1); assert.equal(f.tweetLink, 1); assert.equal(f.terminalLaunch, 0); assert.equal(f.creatorPrior, 3);
});

test('outcomes only label horizons the data covers', () => {
  const H = 36e5, c = [k(0, 10), k(30 * 60e3, 4), k(2 * H, 0.5)];
  const t0 = { i: 0, t0: 60e3, p0: 10 };
  const o = outcomes(c, t0, 3 * H, { '1h': 1, '6h': 6 });
  assert.deepEqual(Object.keys(o), ['1h']);
  assert.equal(o['1h'].dead, 0); assert.equal(o['1h'].halved, 1);
  assert.equal(outcomes(c, t0, 7 * H, { '6h': 6 })['6h'].dead, 1);
});

test('AUC and logistic regression', () => {
  assert.equal(auc([1, 2, 3, 4], [0, 0, 1, 1]), 1);
  assert.equal(auc([4, 3, 2, 1], [0, 0, 1, 1]), 0);
  assert.equal(auc([1, 1, 1, 1], [0, 1, 0, 1]), 0.5);
  // a separable signal gets a positive weight and the model ranks it correctly
  const X = Array.from({ length: 200 }, (_, i) => FEATURES.map((_, j) => (j === 0 ? i / 200 : Math.sin(i * (j + 1)))));
  const y = X.map(r => (r[0] > 0.5 ? 1 : 0));
  const m = fitLogistic(X, y, 1);
  assert.ok(m.w[0] > 0);
  assert.ok(Number.isFinite(predict({ minutesToGrad: 0, instant: 0, activeMinutes: 0, preVolumeUsd: 0, firstMinuteShare: 0, firstMinuteCurve: 0, preDrawdown: 0, mayhem: 0, holderRewards: 0, socials: 0, tweetLink: 0, terminalLaunch: 0, tweetImage: 0, description: 0 }, { b: 0, w: m.w, mean: m.mean, sd: m.sd })));
});

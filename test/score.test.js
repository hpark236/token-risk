import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreToken, gini, hhi, sellImpact, sellableAt, liquidityCurve } from '../lib/score.js';

const base = {
  kind: 'solana',
  contract: { mintActive: false, freezeActive: false },
  liquidityUsd: 2e6, marketCap: 20e6, lpLockedPct: 100,
  holders: Array.from({ length: 20 }, () => ({ pct: 0.8 })), holderCount: 40000,
  activity: { vol24: 3e6, buys24: 5000, sells24: 4800, ch1: 1, ch24: 5 },
  ageHours: 24 * 200, socials: 3, boosted: false,
};

test('math helpers', () => {
  assert.equal(gini([1, 1, 1, 1]), 0);
  assert.ok(gini([0.01, 0.01, 0.01, 100]) > 0.7);
  assert.equal(hhi([50, 50]), 5000);
  assert.ok(Math.abs(sellImpact(10e3, 20e3) - 0.5) < 1e-12); // selling the whole half-pool halves value
  assert.ok(Math.abs(sellImpact(sellableAt(0.05, 1e6), 1e6) - 0.05) < 1e-12); // inverse of each other
  assert.equal(liquidityCurve(1e3), 0); assert.equal(liquidityCurve(1e5), 50); assert.equal(liquidityCurve(1e8), 100);
});

test('a healthy token grades A', () => {
  const r = scoreToken(base);
  assert.equal(r.grade, 'A', JSON.stringify(r.parts));
  assert.equal(r.capped, null);
});

test('live freeze authority caps the score regardless of everything else', () => {
  const r = scoreToken({ ...base, contract: { ...base.contract, freezeActive: true } });
  assert.ok(r.score <= 35);
  assert.equal(r.capped, 'freeze authority live');
  assert.ok(r.parts.contract.flags.some(([lvl, t]) => lvl === 'bad' && /freeze/i.test(t)));
});

test('EVM honeypot is an F', () => {
  const r = scoreToken({ ...base, kind: 'evm', contract: { honeypot: true, openSource: true, ownerRenounced: true } });
  assert.equal(r.grade, 'F');
  assert.ok(r.score <= 5);
});

test('concentration and thin liquidity pull the grade down', () => {
  const r = scoreToken({ ...base, liquidityUsd: 8e3, marketCap: 3e6, holders: [{ pct: 30 }, { pct: 15 }, { pct: 10 }], ageHours: 5, lpLockedPct: 10 });
  assert.ok(['D', 'F'].includes(r.grade));
  assert.ok(r.parts.holders.top10 >= 55);
  assert.ok(r.parts.liquidity.flags.some(([l]) => l === 'bad'));
});

test('every deduction carries evidence text', () => {
  const r = scoreToken({ ...base, contract: { mintActive: true, freezeActive: false, mutableMeta: true } });
  for (const p of Object.values(r.parts)) for (const [lvl, text] of p.flags) {
    assert.ok(['good', 'warn', 'bad', 'info'].includes(lvl)); assert.ok(text.length > 10);
  }
});

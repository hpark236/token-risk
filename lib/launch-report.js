// Live pump.fun section of a scan: launch-mode notes (Mayhem, Holder Rewards, Cashback) and,
// for graduated coins, the launch model's probability that the coin is down 90% six hours
// after graduation. Server-side only (reads the fitted model from disk).

import fs from 'node:fs';
import { coin, candles, createdBy, solPrice } from './pump.js';
import { GRAD_PRICE_SOL, HOUR, findT0, launchFeatures, predict, explain } from './launch.js';

const model = JSON.parse(fs.readFileSync(new URL('./launch-model.json', import.meta.url)));
const SOL_MINT = '11111111111111111111111111111111';

const LABELS = {
  logMinutesToGrad: 'Time to graduate', instant: 'Graduated in its first minute', logActiveMinutes: 'Minutes with trades before graduating',
  logPreVolume: 'Volume before graduating', firstMinuteShare: 'Share of volume in the first minute', firstMinuteCurve: 'Price reached in the first minute',
  preDrawdown: 'Largest fall before graduating', mayhem: 'Mayhem Mode', holderRewards: 'Holder Rewards', socials: 'Number of social links',
  tweetLink: 'Links a single tweet', terminalLaunch: 'Launched from a trading terminal', tweetImage: 'Image taken from X',
  description: 'Has a description', logCreatorPrior: 'Coins the creator launched before', creatorGraduatedBefore: 'Creator graduated a coin before',
};

export async function launchReport(mint) {
  const c = await coin(mint);
  if (!c || !c.created_timestamp || c.program !== 'pump') return null; // pump.fun also indexes tokens launched elsewhere
  const notes = [];
  const ageH = (Date.now() - c.created_timestamp) / HOUR;
  const quoteSol = (c.quote_mint || SOL_MINT) === SOL_MINT;

  if (c.mayhem_state) {
    const live = ageH < 24 && c.mayhem_state === 'active';
    notes.push(['warn', live
      ? 'Mayhem Mode is on. pump.fun\'s trading agent minted an extra 1B tokens (2B supply) and buys and sells at random for the first 24 hours, so trade counts and buy/sell flow include the agent. Holder percentages are of the 2B supply. Unsold agent tokens are burned when the 24 hours end.'
      : 'Mayhem Mode was enabled at launch. The agent has stopped trading this coin (after 24 hours, or earlier if liquidity ran out), and unsold agent tokens are burned.']);
  }
  if (c.is_holder_reward) notes.push(['info', 'Holder Rewards coin: trading fees go to holders several times an hour instead of to the creator.']);
  if (c.is_cashback_enabled) notes.push(['info', 'Cashback coin: part of the fees went back to traders (pump.fun stopped this mode for new coins in September 2026).']);
  if (!quoteSol) notes.push(['info', 'Paired with a token other than SOL, so the graduation price check below does not apply.']);

  const out = { mint, name: c.name, symbol: c.symbol, createdAt: c.created_timestamp, complete: !!c.complete, mayhem: c.mayhem_state || null, holderRewards: !!c.is_holder_reward, notes, model: null };
  if (!c.complete || !quoteSol) {
    if (!c.complete) notes.push(['info', 'Still on the pump.fun bonding curve. The launch model applies once a coin graduates.']);
    return out;
  }

  const sol = await solPrice();
  const grad = GRAD_PRICE_SOL * sol;
  const k = await candles(mint, { fromMs: c.created_timestamp });
  const t0 = findT0(k, grad);
  if (!t0) {
    if (c.mayhem_state) {
      notes.push(['bad', `Marked as graduated, but the price never reached the normal graduation level: the curve completed with ${((c.virtual_sol_reserves || 0) / 1e9).toFixed(2)} SOL instead of about 115. This happens when the Mayhem agent sells its extra supply into the curve. In the sample used to fit the model, about one in five coins listed as graduated were like this, and the resulting pool has almost no liquidity.`]);
    }
    return out;
  }
  const made = await createdBy(c.creator, 50).catch(() => null);
  const prior = made?.filter(x => x.created_timestamp < c.created_timestamp);
  const f = launchFeatures(c, k, t0, grad, prior ? { prior: prior.length, priorGraduated: prior.filter(x => x.complete).length } : {});
  const p = predict(f, model);
  out.model = {
    p, baseRate: model.baseRate, cvAuc: model.cvAuc, n: model.n, fittedAt: model.fittedAt,
    graduatedAt: t0.t0, hoursSinceGraduation: (Date.now() - t0.t0) / HOUR,
    minutesToGrad: f.minutesToGrad, creatorPrior: f.creatorPrior,
    drivers: explain(f, model).slice(0, 5).map(d => ({ name: LABELS[d.name] || d.name, logit: d.logit })),
  };
  return out;
}

// Vitals scoring model. Pure functions: a normalised token snapshot in, a graded report out.
// Every deduction produces a flag with the evidence behind it, so the score is auditable.

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const fmtUsd = n => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`;
const pct = n => `${n.toFixed(1)}%`;

export const WEIGHTS = { contract: 0.30, liquidity: 0.25, holders: 0.20, activity: 0.15, maturity: 0.10 };

/** Gini coefficient of a list of balances (0 = equal, 1 = one wallet owns everything). */
export function gini(values) {
  const v = values.filter(x => x > 0).sort((a, b) => a - b);
  const n = v.length;
  if (n < 2) return n ? 1 : 0;
  const sum = v.reduce((a, b) => a + b, 0);
  let acc = 0;
  v.forEach((x, i) => { acc += (2 * (i + 1) - n - 1) * x; });
  return acc / (n * sum);
}

/** Herfindahl-Hirschman index on shares given in percent (0-10,000). */
export const hhi = shares => shares.reduce((a, s) => a + s * s, 0);

/**
 * Price impact of selling `usd` worth of the token into a constant-product pool
 * that holds `liqUsd` in total (half on each side). Concentrated-liquidity pools
 * can be deeper near the price and shallower away from it; this is the x*y=k baseline.
 */
export function sellImpact(usd, liqUsd) {
  const r = liqUsd / 2;
  if (!(r > 0)) return 1;
  return usd / (r + usd); // fraction of value lost to slippage, before fees
}

/** Largest sale (USD) that moves the price less than `maxImpact` in the same pool. */
export const sellableAt = (maxImpact, liqUsd) => (liqUsd / 2) * maxImpact / (1 - maxImpact);

/** Liquidity in USD mapped onto 0-100 on a log scale: $1K = 0, $10K = 25, $100K = 50, $1M = 75, $10M = 100. */
export const liquidityCurve = usd => clamp((Math.log10(Math.max(usd, 1)) - 3) * 25);

const grade = s => s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F';

/**
 * snap = {
 *   kind: 'solana' | 'evm',
 *   contract: { mintActive, freezeActive, mutableMeta, transferFeePct, permanentDelegate, rugged,
 *               honeypot, buyTax, sellTax, mintable, takeBackOwnership, hiddenOwner, openSource,
 *               proxy, pausable, blacklist, ownerRenounced, cannotSellAll, selfdestruct },
 *   liquidityUsd, marketCap, lpLockedPct,
 *   holders: [{ pct, insider }] (wallets only, pools and burn addresses removed), holderCount,
 *   insiders, creatorPct,
 *   activity: { vol24, buys24, sells24, ch1, ch24, txns24 },
 *   ageHours, socials, boosted, cex: [exchange names]
 * }
 */
export function scoreToken(snap) {
  const parts = {};
  let cap = 100; // hard ceiling for disqualifying findings
  const capAt = (v, why) => { if (v < cap) { cap = v; capReason = why; } };
  let capReason = null;

  // ---------- 1. Contract and authorities ----------
  {
    const c = snap.contract || {}, f = [];
    let s = 100;
    if (snap.kind === 'solana') {
      if (c.rugged) { s = 0; f.push(['bad', 'Flagged as already rugged by RugCheck.']); capAt(5, 'already rugged'); }
      if (c.mintActive) { s -= 45; f.push(['bad', 'Mint authority is active, so new tokens can still be created.']); capAt(50, 'mint authority live'); }
      else f.push(['good', 'Mint authority revoked. Supply is fixed.']);
      if (c.freezeActive) { s -= 40; f.push(['bad', 'Freeze authority is active, so token accounts can be frozen and holders may be unable to sell.']); capAt(35, 'freeze authority live'); }
      else f.push(['good', 'Freeze authority revoked.']);
      if (c.permanentDelegate) { s -= 50; f.push(['bad', 'Token-2022 permanent delegate is set, so tokens can be moved out of any wallet.']); capAt(20, 'permanent delegate'); }
      if (c.transferFeePct > 0) { s -= c.transferFeePct > 5 ? 30 : 12; f.push([c.transferFeePct > 5 ? 'bad' : 'warn', `Transfer fee of ${pct(c.transferFeePct)} on every move.`]); }
      if (c.mutableMeta) { s -= 5; f.push(['warn', 'Metadata is mutable. Name, symbol and image can be changed later.']); }
    } else {
      if (c.honeypot) { s = 0; f.push(['bad', 'Honeypot check failed: a simulated sale did not go through.']); capAt(5, 'honeypot'); }
      if (c.cannotSellAll) { s -= 30; f.push(['bad', 'Holders cannot sell their full balance.']); }
      const tax = Math.max(c.buyTax || 0, c.sellTax || 0);
      if (tax > 10) { s -= 40; f.push(['bad', `Trading tax up to ${pct(tax)} (buy ${pct(c.buyTax || 0)}, sell ${pct(c.sellTax || 0)}).`]); capAt(45, 'tax above 10%'); }
      else if (tax > 3) { s -= 15; f.push(['warn', `Trading tax up to ${pct(tax)}.`]); }
      else f.push(['good', `Taxes ${pct(c.buyTax || 0)} buy / ${pct(c.sellTax || 0)} sell.`]);
      if (c.openSource === false) { s -= 40; f.push(['bad', 'Contract source code is not verified.']); capAt(45, 'unverified source'); }
      if (c.mintable && !c.ownerRenounced) { s -= 30; f.push(['bad', 'Owner can mint new tokens.']); }
      if (c.takeBackOwnership) { s -= 30; f.push(['bad', 'Ownership can be reclaimed after being renounced.']); }
      if (c.hiddenOwner) { s -= 25; f.push(['bad', 'Hidden owner pattern detected.']); }
      if (c.selfdestruct) { s -= 20; f.push(['bad', 'Contract can self-destruct.']); }
      if (c.proxy) { s -= 15; f.push(['warn', 'Upgradeable proxy contract, so its code can be changed.']); }
      if (!c.ownerRenounced) {
        if (c.pausable) { s -= 12; f.push(['warn', 'Owner can pause transfers.']); }
        if (c.blacklist) { s -= 10; f.push(['warn', 'Owner can blacklist wallets.']); }
      } else f.push(['good', 'Ownership renounced.']);
    }
    parts.contract = { score: clamp(s), flags: f };
  }

  // ---------- 2. Liquidity ----------
  {
    const f = [];
    const L = snap.liquidityUsd || 0, M = snap.marketCap || 0;
    let s = liquidityCurve(L);
    f.push([L >= 250e3 ? 'good' : L >= 25e3 ? 'warn' : 'bad', `${fmtUsd(L)} pooled liquidity across DEX pairs.`]);
    if (L < 10e3) capAt(40, 'liquidity under $10K');
    if (M > 0) {
      const ratio = L / M * 100;
      if (ratio < 0.5) { s -= 30; f.push(['bad', `Liquidity is ${pct(ratio)} of market cap. Only a small part of the market cap could be sold.`]); }
      else if (ratio < 2) { s -= 15; f.push(['warn', `Liquidity is ${pct(ratio)} of market cap.`]); }
      else if (ratio >= 8) { s += 5; f.push(['good', `Liquidity is ${pct(ratio)} of market cap.`]); }
    }
    if (snap.lpLockedPct != null) {
      const p = snap.lpLockedPct;
      if (p < 50 && (snap.ageHours ?? 1e9) < 24 * 30) { s -= 25; f.push(['bad', `Only ${pct(p)} of LP is locked or burned. The rest can be withdrawn by the owner.`]); }
      else if (p >= 90) f.push(['good', `${pct(p)} of LP locked or burned.`]);
      else f.push([(snap.ageHours ?? 0) > 24 * 90 ? 'info' : 'warn', `${pct(p)} of LP locked or burned${(snap.ageHours ?? 0) > 24 * 90 ? ', less relevant for a pool this old' : ''}.`]);
    }
    if (snap.cex?.length) { s += 10; f.push(['good', `Also listed on ${snap.cex.slice(0, 3).join(', ')}, so most liquidity sits off-chain.`]); }
    const impact10k = sellImpact(10e3, L) * 100;
    f.push([impact10k < 3 ? 'good' : impact10k < 15 ? 'warn' : 'bad', `A $10K sell moves price about ${pct(impact10k)} (constant-product estimate).`]);
    parts.liquidity = { score: clamp(s), flags: f };
  }

  // ---------- 3. Holder distribution ----------
  {
    const f = [];
    const h = (snap.holders || []).slice().sort((a, b) => b.pct - a.pct);
    const top10 = h.slice(0, 10).reduce((a, x) => a + x.pct, 0);
    const top1 = h[0]?.pct || 0;
    let s;
    if (!h.length) { s = 50; f.push(['warn', 'Holder list unavailable.']); }
    else {
      s = top10 > 50 ? 10 : top10 > 30 ? 40 : top10 > 15 ? 70 : 95;
      f.push([top10 > 30 ? 'bad' : top10 > 15 ? 'warn' : 'good', `Top 10 wallets hold ${pct(top10)} of supply (pools and burn addresses excluded).`]);
      if (top1 > 20) { s -= 20; f.push(['bad', `Largest wallet holds ${pct(top1)}.`]); }
      else if (top1 > 10) { s -= 10; f.push(['warn', `Largest wallet holds ${pct(top1)}.`]); }
    }
    if (snap.insiders > 0) { s -= 15; f.push(['warn', `${snap.insiders} wallets linked to the deployer network (RugCheck insider graph).`]); }
    if (snap.creatorPct > 5) { s -= 15; f.push(['warn', `Creator still holds ${pct(snap.creatorPct)}.`]); }
    if (snap.holderCount) f.push([snap.holderCount > 5000 ? 'good' : snap.holderCount > 500 ? 'warn' : 'bad', `${snap.holderCount.toLocaleString('en-US')} holders.`]);
    const shares = h.slice(0, 20).map(x => x.pct);
    parts.holders = { score: clamp(s), flags: f, top10, top1, gini: gini(shares), hhi: hhi(shares) };
  }

  // ---------- 4. Trading activity ----------
  {
    const a = snap.activity || {}, f = [];
    let s = 80;
    const buys = a.buys24 || 0, sells = a.sells24 || 0, tx = a.txns24 ?? buys + sells;
    if (tx < 50) { s -= 40; f.push(['bad', `Only ${tx} trades in 24h.`]); }
    if (buys + sells > 0) {
      const ratio = sells / Math.max(buys, 1);
      if (ratio > 1.5) { s -= 20; f.push(['warn', `Sells outnumber buys ${ratio.toFixed(2)} to 1 over 24h.`]); }
      else if (ratio < 0.67) f.push(['good', `Buys outnumber sells ${(1 / Math.max(ratio, 0.01)).toFixed(2)} to 1 over 24h.`]);
      else f.push(['good', `Balanced flow: ${buys.toLocaleString('en-US')} buys, ${sells.toLocaleString('en-US')} sells.`]);
    }
    const turnover = (a.vol24 || 0) / Math.max(snap.liquidityUsd || 1, 1);
    if (turnover > 25) { s -= 15; f.push(['warn', `24h volume is ${turnover.toFixed(0)}x liquidity. This can indicate heavy speculation or wash trading.`]); }
    else if (turnover < 0.05) { s -= 20; f.push(['bad', '24h volume is under 5% of liquidity, so trading is very thin.']); }
    if ((a.ch1 ?? 0) < -30) { s -= 25; f.push(['bad', `Price down ${pct(-a.ch1)} in the last hour.`]); }
    if (Math.abs(a.ch24 ?? 0) > 60) { s -= 10; f.push(['warn', `Price moved ${pct(a.ch24)} in 24h.`]); }
    parts.activity = { score: clamp(s), flags: f, turnover };
  }

  // ---------- 5. Maturity ----------
  {
    const f = [];
    const age = snap.ageHours ?? 0;
    let s = age < 24 ? 20 : age < 24 * 7 ? 50 : age < 24 * 30 ? 70 : 90;
    const ageTxt = age < 48 ? `${Math.round(age)} hours` : `${Math.round(age / 24)} days`;
    f.push([age < 24 * 7 ? (age < 24 ? 'bad' : 'warn') : 'good', `Oldest pool is ${ageTxt} old.`]);
    if ((snap.socials || 0) === 0) { s -= 15; f.push(['warn', 'No website or socials listed.']); }
    else f.push(['good', `${snap.socials} website/social links listed.`]);
    if (snap.boosted) { s -= 5; f.push(['warn', 'Paid DexScreener promotion is active.']); }
    parts.maturity = { score: clamp(s), flags: f };
  }

  for (const p of Object.values(parts)) p.score = Math.round(p.score);
  const raw = Object.entries(WEIGHTS).reduce((acc, [k, w]) => acc + parts[k].score * w, 0);
  const score = Math.round(Math.min(raw, cap));
  const g = grade(score);
  const verdict = {
    A: 'Low risk on the checks performed.',
    B: 'Mostly low risk, with a few items to review.',
    C: 'Moderate risk. Review the findings below.',
    D: 'High risk. Several problems were found.',
    F: 'Very high risk. At least one finding can stop holders from selling or reduce their holdings.',
  }[g];
  return { score, raw: Math.round(raw), grade: g, verdict, capped: cap < raw ? capReason : null, parts, weights: WEIGHTS };
}

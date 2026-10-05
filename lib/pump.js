// pump.fun data, for the live scan and the validation study. These are the unofficial, keyless APIs the
// pump.fun site itself uses, so they can change. Every call is throttled and retried on 429.

const V3 = 'https://frontend-api-v3.pump.fun';
const SWAP = 'https://swap-api.pump.fun';
const UA = { 'User-Agent': 'Mozilla/5.0 (token-risk validation)', accept: 'application/json' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const gaps = new Map(); // host -> earliest time of next request

async function get(url, { minGap = 350, tries = 6 } = {}) {
  const host = new URL(url).host;
  for (let i = 0; i < tries; i++) {
    const wait = (gaps.get(host) || 0) - Date.now();
    if (wait > 0) await sleep(wait);
    gaps.set(host, Date.now() + minGap);
    let r;
    try { r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) }); }
    catch (e) { await sleep(1000 * (i + 1)); continue; }
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      await sleep(Math.max(1000, j.retryAfterMs || 0) * (i + 1));
      continue;
    }
    if (r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  throw new Error(`gave up on ${url}`);
}

/** Graduated coins, newest first. The API stops paging at about 1,000 coins (roughly one day). */
export async function graduated({ max = 1100, pageSize = 50 } = {}) {
  const out = [];
  for (let off = 0; off < max; off += pageSize) {
    const page = await get(`${V3}/coins?offset=${off}&limit=${pageSize}&sort=created_timestamp&order=DESC&complete=true&includeNsfw=true`);
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
  }
  const seen = new Set();
  return out.filter(c => !seen.has(c.mint) && seen.add(c.mint));
}

/** Coins a wallet has created, newest first (up to `limit`). */
export async function createdBy(wallet, limit = 50) {
  const j = await get(`${V3}/coins?creator=${wallet}&offset=0&limit=${limit}&sort=created_timestamp&order=DESC&includeNsfw=true`);
  return (Array.isArray(j) ? j : []).filter(c => c.creator === wallet); // guard in case the filter is ignored
}

/** One coin by mint, or null if pump.fun does not know it. */
export async function coin(mint) {
  try { return await get(`${V3}/coins-v2/${mint}`, { tries: 2 }); } catch { return null; }
}

export async function solPrice() {
  return (await get(`${V3}/sol-price`)).solPrice;
}

/**
 * USD candles from `fromMs` onwards, oldest first: [{t, o, h, l, c, v}].
 * Only minutes with trades are returned, so gaps mean no trading.
 */
export async function candles(mint, { interval = '1m', fromMs = 0, limit = 1000 } = {}) {
  const j = await get(`${SWAP}/v2/coins/${mint}/candles?interval=${interval}&limit=${limit}&currency=USD&createdTs=${Math.floor(fromMs)}`, { minGap: 150 });
  return (Array.isArray(j) ? j : []).map(k => ({ t: k.timestamp, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.volume }));
}

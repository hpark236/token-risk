// Data adapters: DexScreener (markets), RugCheck (Solana security), GoPlus (EVM security),
// GeckoTerminal (candles). All public, keyless endpoints.

export const CHAINS = {
  solana: { name: 'Solana', goplus: null, gecko: 'solana' },
  ethereum: { name: 'Ethereum', goplus: 1, gecko: 'eth' },
  base: { name: 'Base', goplus: 8453, gecko: 'base' },
  bsc: { name: 'BNB Chain', goplus: 56, gecko: 'bsc' },
  arbitrum: { name: 'Arbitrum', goplus: 42161, gecko: 'arbitrum' },
  polygon: { name: 'Polygon', goplus: 137, gecko: 'polygon_pos' },
};

const BURN = new Set(['0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000', '1nc1nerator11111111111111111111111111111111']);

async function getJSON(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'vitals/1.0', accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export const isEvm = s => /^0x[0-9a-fA-F]{40}$/.test(s);
export const isSol = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/** Free-text search. Returns one row per token (its most liquid pair), supported chains only. */
export async function search(q) {
  const j = await getJSON(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
  const seen = new Map();
  for (const p of j.pairs || []) {
    if (!CHAINS[p.chainId]) continue;
    const k = p.chainId + ':' + p.baseToken.address.toLowerCase();
    const prev = seen.get(k);
    if (!prev || (p.liquidity?.usd || 0) > (prev.liquidity?.usd || 0)) seen.set(k, p);
  }
  return [...seen.values()].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)).slice(0, 12).map(row);
}

const row = p => ({
  chain: p.chainId, address: p.baseToken.address, symbol: p.baseToken.symbol, name: p.baseToken.name,
  image: p.info?.imageUrl || null, priceUsd: Number(p.priceUsd) || null, liquidityUsd: p.liquidity?.usd || 0,
  marketCap: p.marketCap || p.fdv || 0, ch24: p.priceChange?.h24 ?? null, createdAt: p.pairCreatedAt || null,
});

/** Tokens currently paying for DexScreener boosts, with live market stats. */
export async function trending() {
  const [boosts, profiles] = await Promise.all([
    getJSON('https://api.dexscreener.com/token-boosts/top/v1').catch(() => []),
    getJSON('https://api.dexscreener.com/token-profiles/latest/v1').catch(() => []),
  ]);
  const byChain = {};
  for (const t of [...boosts, ...profiles]) {
    if (!CHAINS[t.chainId]) continue;
    (byChain[t.chainId] ||= new Set()).add(t.tokenAddress);
  }
  const rows = [];
  await Promise.all(Object.entries(byChain).map(async ([chain, set]) => {
    const addrs = [...set].slice(0, 30);
    const pairs = await getJSON(`https://api.dexscreener.com/tokens/v1/${chain}/${addrs.join(',')}`).catch(() => []);
    const best = new Map();
    for (const p of pairs) {
      const k = p.baseToken.address;
      if (!set.has(k)) continue;
      if (!best.has(k) || (p.liquidity?.usd || 0) > (best.get(k).liquidity?.usd || 0)) best.set(k, p);
    }
    rows.push(...[...best.values()].map(row));
  }));
  return rows.filter(r => r.liquidityUsd > 0).sort((a, b) => b.marketCap - a.marketCap).slice(0, 24);
}

/** All DexScreener pairs for an address, grouped by chain. Picks the chain with the most liquidity. */
export async function markets(address, chainHint) {
  let pairs;
  if (chainHint && CHAINS[chainHint]) pairs = await getJSON(`https://api.dexscreener.com/token-pairs/v1/${chainHint}/${address}`);
  else pairs = (await getJSON(`https://api.dexscreener.com/latest/dex/tokens/${address}`)).pairs || [];
  pairs = (pairs || []).filter(p => CHAINS[p.chainId] && p.baseToken.address.toLowerCase() === address.toLowerCase());
  if (!pairs.length) return null;
  const liqBy = {};
  for (const p of pairs) liqBy[p.chainId] = (liqBy[p.chainId] || 0) + (p.liquidity?.usd || 0);
  const chain = chainHint && liqBy[chainHint] != null ? chainHint : Object.entries(liqBy).sort((a, b) => b[1] - a[1])[0][0];
  pairs = pairs.filter(p => p.chainId === chain).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const top = pairs[0];
  const sum = f => pairs.reduce((a, p) => a + (f(p) || 0), 0);
  const created = pairs.map(p => p.pairCreatedAt).filter(Boolean);
  return {
    chain, address: top.baseToken.address, symbol: top.baseToken.symbol, name: top.baseToken.name,
    image: top.info?.imageUrl || null, header: top.info?.header || null,
    links: [...(top.info?.websites || []).map(w => ({ label: w.label || 'Website', url: w.url })), ...(top.info?.socials || []).map(s => ({ label: s.type, url: s.url }))],
    priceUsd: Number(top.priceUsd) || null,
    marketCap: top.marketCap || top.fdv || 0, fdv: top.fdv || 0,
    liquidityUsd: sum(p => p.liquidity?.usd),
    vol24: sum(p => p.volume?.h24),
    buys24: sum(p => p.txns?.h24?.buys), sells24: sum(p => p.txns?.h24?.sells),
    buys1h: sum(p => p.txns?.h1?.buys), sells1h: sum(p => p.txns?.h1?.sells),
    ch: top.priceChange || {},
    ageHours: created.length ? (Date.now() - Math.min(...created)) / 36e5 : null,
    boosted: pairs.some(p => (p.boosts?.active || 0) > 0),
    pools: pairs.slice(0, 8).map(p => ({ dex: p.dexId, pair: p.pairAddress, quote: p.quoteToken.symbol, liquidityUsd: p.liquidity?.usd || 0, vol24: p.volume?.h24 || 0, url: p.url, labels: p.labels || [] })),
    topPair: top.pairAddress,
    dexUrl: top.url,
  };
}

/** Solana security via RugCheck's full report. */
export async function solanaSecurity(mint) {
  const r = await getJSON(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, 12000);
  const known = r.knownAccounts || {};
  const pools = new Set(Object.entries(known).filter(([, v]) => ['AMM', 'LOCKER'].includes(v.type)).map(([k]) => k));
  for (const m of r.markets || []) { if (m.pubkey) pools.add(m.pubkey); if (m.liquidityA) pools.add(m.liquidityA); if (m.liquidityB) pools.add(m.liquidityB); }
  const holders = (r.topHolders || [])
    .filter(h => !pools.has(h.owner) && !pools.has(h.address) && !BURN.has(h.owner))
    .map(h => ({ address: h.owner || h.address, pct: h.pct, insider: !!h.insider }));
  // LP lock: weight each classic AMM pool by its USD size. Concentrated pools have no LP mint to lock.
  let locked = 0, total = 0;
  for (const m of r.markets || []) {
    const lp = m.lp; if (!lp || !lp.lpMint || /^1{32}$/.test(lp.lpMint)) continue;
    const usd = (lp.baseUSD || 0) + (lp.quoteUSD || 0);
    total += usd; locked += usd * (lp.lpLockedPct || 0) / 100;
  }
  const ext = r.token_extensions || {};
  return {
    contract: {
      mintActive: !!r.token?.mintAuthority,
      freezeActive: !!r.token?.freezeAuthority,
      mutableMeta: !!r.tokenMeta?.mutable,
      transferFeePct: r.transferFee?.pct || 0,
      permanentDelegate: !!ext.permanentDelegate,
      rugged: !!r.rugged,
    },
    holders, holderCount: r.totalHolders || null,
    insiders: r.graphInsidersDetected || 0,
    creatorPct: r.creatorBalance && r.token?.supply ? r.creatorBalance / r.token.supply * 100 : 0, // both in raw units
    lpLockedPct: total > 0 ? locked / total * 100 : null,
    externalRisks: (r.risks || []).map(x => ({ name: x.name, level: x.level, description: x.description })),
    launchpad: r.launchpad?.name || (r.deployPlatform && r.deployPlatform !== 'unknown' ? r.deployPlatform : null),
    source: 'RugCheck',
  };
}

/** EVM security via GoPlus. */
export async function evmSecurity(chain, address) {
  const id = CHAINS[chain].goplus;
  const j = await getJSON(`https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${address}`, 12000);
  const t = j.result?.[address.toLowerCase()];
  if (!t) throw new Error('GoPlus has no record for this token');
  const b = v => v === '1' || v === 1;
  const n = v => (v === '' || v == null ? 0 : Number(v) * 100);
  const owner = (t.owner_address || '').toLowerCase();
  const holders = (t.holders || [])
    .filter(h => !BURN.has(h.address.toLowerCase()) && !b(h.is_locked) && !(b(h.is_contract)))
    .map(h => ({ address: h.address, pct: Number(h.percent) * 100, insider: h.address.toLowerCase() === (t.creator_address || '').toLowerCase(), tag: h.tag || '' }));
  let lp = null;
  if (t.lp_holders?.length) lp = t.lp_holders.reduce((a, h) => a + ((b(h.is_locked) || BURN.has(h.address.toLowerCase())) ? Number(h.percent) * 100 : 0), 0);
  return {
    contract: {
      honeypot: b(t.is_honeypot), cannotSellAll: b(t.cannot_sell_all),
      buyTax: n(t.buy_tax), sellTax: n(t.sell_tax),
      mintable: b(t.is_mintable), takeBackOwnership: b(t.can_take_back_ownership), hiddenOwner: b(t.hidden_owner),
      openSource: t.is_open_source === undefined ? undefined : b(t.is_open_source),
      proxy: b(t.is_proxy), pausable: b(t.transfer_pausable), blacklist: b(t.is_blacklisted), selfdestruct: b(t.selfdestruct),
      ownerRenounced: !owner || BURN.has(owner),
    },
    holders, holderCount: Number(t.holder_count) || null,
    insiders: 0,
    creatorPct: Number(t.creator_percent || 0) * 100,
    lpLockedPct: lp,
    externalRisks: [],
    cex: t.is_in_cex?.cex_list || [],
    source: 'GoPlus',
  };
}

/** Hourly candles for the main pool, newest last: [[t, o, h, l, c, v], ...] */
export async function candles(chain, pair) {
  const net = CHAINS[chain]?.gecko;
  if (!net) return [];
  const j = await getJSON(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pair}/ohlcv/hour?limit=168&currency=usd`, 8000);
  return (j.data?.attributes?.ohlcv_list || []).slice().reverse();
}

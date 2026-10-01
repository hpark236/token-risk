# Vitals

A memecoin health check. Paste a Solana or EVM token address (or a ticker) and Vitals reads the contract, the pools and the holder list, then returns a 0-100 grade with every finding behind it.

**Live:** https://coin-vitals.vercel.app

## What it checks

| Vital | Weight | Signals |
|---|---|---|
| Contract & authorities | 30% | Solana: mint / freeze authority, Token-2022 permanent delegate and transfer fees, mutable metadata. EVM: honeypot simulation, buy/sell tax, mintable, reclaimable or hidden owner, unverified source, proxy, pause, blacklist |
| Liquidity | 25% | Pooled USD (log-scaled), liquidity-to-market-cap ratio, share of LP locked or burned, CEX listings |
| Holders | 20% | Top-10 and top-1 share with AMM pools, lockers and burn addresses removed, deployer-linked wallets, creator balance, holder count. Lorenz curve, Gini and HHI on the top 20 |
| Trade flow | 15% | Buy/sell ratio, volume-to-liquidity turnover (dead market vs wash trading), 1h crash and 24h volatility |
| Age & presence | 10% | Oldest pool age, listed website and socials, paid DexScreener boosts |

Disqualifying findings cap the total no matter how good the rest looks: live freeze authority caps at 35, live mint authority at 50, honeypot at 5, liquidity under $10K at 40.

**Exit test:** price impact of selling $1K to $100K into the pooled liquidity using the constant-product formula `impact = x / (R + x)` where `R` is the token side of the pool in USD, plus the largest sale that stays under 2% and 10% impact.

## Sources (all keyless)

DexScreener (pairs, liquidity, flow, boosts) · RugCheck (Solana authorities, holders, LP locks, insider graph) · GoPlus (EVM contract simulation and holders) · GeckoTerminal (hourly candles)

## Layout

```
api/scan.js       resolve address or ticker, gather sources, score
api/trending.js   tokens currently buying DexScreener boosts
lib/sources.js    data adapters and normalisation
lib/score.js      the scoring model (pure, shared with the browser)
test/             node:test unit tests
index.html        report UI, vanilla JS
```

```bash
npm test
npx vercel dev
```

A screening tool, not financial advice. A clean report does not stop a team from selling.

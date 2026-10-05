# token-risk

A memecoin health check. Paste a Solana or EVM token address (or a ticker) and token-risk reads the contract, the pools and the holder list, then returns a 0-100 grade with every finding behind it.

**Live:** https://token-risk.vercel.app

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

## Does the score work?

Tested on pump.fun coins at the moment they graduate to a DEX pool ([live results](https://token-risk.vercel.app/validation), code in `validation/`).

- **Data:** every coin pump.fun lists as graduated (about a day's worth). For each one, the state at graduation is rebuilt from one-minute candles, metadata and the creator's earlier launches, then labelled by what happened next. The outcome is "price 6 hours later is 90% or more below the graduation price".
- **Result:** the 0-100 score above cannot separate pump.fun graduates (AUC about 0.5), because at that moment they all look alike. A logistic model on launch behaviour reaches AUC about 0.87 under 5-fold cross-validation grouped by creator. Time to graduate is the strongest signal: 84% of coins that graduated within their first minute were down 90% six hours later, against 24% of those that took over 30 minutes.
- **Mayhem Mode:** about a fifth of "graduated" coins are Mayhem coins whose curve completed with a fraction of a SOL, after the agent sold its extra 1B tokens into it. They never reached the graduation price and are reported separately.
- **Live test:** a GitHub Actions job (`.github/workflows/collect.yml`) records new graduations every 30 minutes with the full score and the model's prediction, then labels them after 1h, 6h, 24h and 7d. Results go to the `data` branch.

For pump.fun coins the scan adds a launch section: Mayhem, Holder Rewards and Cashback notes, phantom-graduation detection, and the launch model's probability with its main drivers.

```bash
node validation/build-retro.mjs     # historical dataset (about 50 minutes, rate limited)
node validation/analyze.mjs --fit   # cross-validate and refit lib/launch-model.json
node validation/collect.mjs         # one forward snapshot and labelling pass
```

## Sources (all keyless)

DexScreener (pairs, liquidity, flow, boosts) · RugCheck (Solana authorities, holders, LP locks, insider graph) · GoPlus (EVM contract simulation and holders) · GeckoTerminal (hourly candles) · pump.fun (launch data, candles; unofficial endpoints)

## Layout

```
api/scan.js       resolve address or ticker, gather sources, score
api/trending.js   tokens currently buying DexScreener boosts
lib/sources.js    data adapters and normalisation
lib/score.js      the scoring model (pure, shared with the browser)
lib/launch.js     pump.fun launch features, labels and the logistic model
lib/pump.js       pump.fun client (throttled)
validation/       dataset builders, analysis, forward collector
test/             node:test unit tests
index.html        report UI, vanilla JS
```

```bash
npm test
npx vercel dev
```

A screening tool, not financial advice. A clean report does not stop a team from selling.

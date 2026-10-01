import { markets, solanaSecurity, evmSecurity, candles, isEvm, isSol, search, CHAINS } from '../lib/sources.js';
import { scoreToken } from '../lib/score.js';

// GET /api/scan?q=<address or ticker>&chain=<optional>
export default async function handler(req, res) {
  const q = String(req.query?.q || '').trim();
  const chainHint = CHAINS[req.query?.chain] ? req.query.chain : null;
  if (!q) return res.status(400).json({ error: 'Pass ?q= with a token address or ticker.' });
  try {
    if (!isEvm(q) && !isSol(q)) {
      const results = await search(q);
      return res.status(200).json({ type: 'search', results });
    }
    const m = await markets(q, chainHint);
    if (!m) return res.status(404).json({ error: 'No DEX pairs found for that address on a supported chain.' });

    const [sec, cs] = await Promise.allSettled([
      m.chain === 'solana' ? solanaSecurity(m.address) : evmSecurity(m.chain, m.address),
      candles(m.chain, m.topPair),
    ]);
    const s = sec.status === 'fulfilled' ? sec.value : null;
    const snap = {
      kind: m.chain === 'solana' ? 'solana' : 'evm',
      contract: s?.contract || {},
      liquidityUsd: m.liquidityUsd, marketCap: m.marketCap,
      lpLockedPct: s?.lpLockedPct ?? null,
      holders: s?.holders || [], holderCount: s?.holderCount, insiders: s?.insiders || 0, creatorPct: s?.creatorPct || 0,
      activity: { vol24: m.vol24, buys24: m.buys24, sells24: m.sells24, ch1: m.ch.h1, ch24: m.ch.h24 },
      ageHours: m.ageHours, socials: m.links.length, boosted: m.boosted, cex: s?.cex || [],
    };
    const report = scoreToken(snap);
    if (!s) {
      report.parts.contract.flags.unshift(['warn', `Security source unavailable (${sec.reason?.message || 'timeout'}). Contract checks are incomplete.`]);
    }
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({
      type: 'report', scannedAt: new Date().toISOString(), token: m,
      security: s ? { source: s.source, externalRisks: s.externalRisks, launchpad: s.launchpad || null, cex: s.cex || [], holders: s.holders.slice(0, 20) } : null,
      candles: cs.status === 'fulfilled' ? cs.value : [],
      report,
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}

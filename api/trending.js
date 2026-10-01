import { trending } from '../lib/sources.js';
export default async function handler(req, res) {
  try {
    const rows = await trending();
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    res.status(200).json({ rows });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
}

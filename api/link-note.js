import { getDealByCompassId, patchLatestSnapshot, send, upsertLink } from './_cc.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { eventId, dealId } = body;
    if (!eventId || !dealId) return send(res, 400, { error: 'Missing eventId or dealId' });
    const deal = await getDealByCompassId(dealId);
    await upsertLink({ eventId, deal, matchReason: 'manual', confidence: 1 });
    await patchLatestSnapshot({ eventId, deal, action: 'link' });
    return send(res, 200, { ok: true });
  } catch (error) {
    return send(res, 500, { error: error.message || String(error) });
  }
}

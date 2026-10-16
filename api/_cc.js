const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function assertConfig() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase server env vars');
}

export async function sb(path, options = {}) {
  assertConfig();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function getDealByCompassId(compassId) {
  const rows = await sb(`cc_deals?select=id,client_id,compass_id,name,cc_clients(name)&compass_id=eq.${encodeURIComponent(compassId)}&limit=1`);
  if (!rows?.[0]) throw new Error('Deal not found');
  return rows[0];
}

export async function upsertLink({ eventId, deal, matchReason, confidence }) {
  const rows = await sb('cc_activity_links?on_conflict=event_id,client_id,deal_id', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ event_id: eventId, client_id: deal.client_id, deal_id: deal.id, match_reason: matchReason, confidence }])
  });
  return rows?.[0];
}

export async function patchLatestSnapshot({ eventId, deal, action }) {
  const rows = await sb('cc_snapshots?select=id,payload&published=eq.true&order=generated_at.desc&limit=1');
  const snap = rows?.[0];
  if (!snap?.payload) return;
  const payload = snap.payload;
  payload.notes = (payload.notes || []).map(note => {
    if (note.id !== eventId) return note;
    const links = (note.links || []).filter(l => l.dealId !== deal.compass_id);
    if (action === 'link') links.push({ client: deal.cc_clients?.name || '', dealId: deal.compass_id, dealName: deal.name, matchReason: 'manual' });
    return { ...note, links };
  });
  await sb(`cc_snapshots?id=eq.${encodeURIComponent(snap.id)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ payload, generated_at: new Date().toISOString() })
  });
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

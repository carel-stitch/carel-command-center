#!/usr/bin/env node
/**
 * Carel Command Center Supabase sync
 * Cron: every 30 minutes.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SC_NAME = process.env.CAREL_SC_NAME || 'Carel van Dyk';
const TODAY = new Date().toISOString().slice(0, 10);

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Not syncing.');
  process.exit(2);
}

const headers = { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' };
const NOTE_SOURCES = new Set(['fireflies', 'gemini']);

function normalizeName(s = '') { return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim(); }
function safeDate(s) { return s ? new Date(s).toISOString() : null; }
function compact(s = '', max = 360) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; }
async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function upsert(table, rows, conflict) {
  if (!rows.length) return [];
  return sb(`${table}?on_conflict=${encodeURIComponent(conflict)}`, { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(rows) });
}
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }
async function pullCompassDeals() {
  const { stdout } = await execFileAsync('mcp-bridge', ['call', 'compass', 'list_deals', '{}'], { maxBuffer: 20 * 1024 * 1024 });
  const outer = JSON.parse(stdout);
  const text = Array.isArray(outer) && outer[0]?.text ? outer[0].text : stdout;
  const all = JSON.parse(text);
  return all.filter(d => (d.scDri || '').toLowerCase().includes(SC_NAME.toLowerCase()));
}
function titleOfNotionPage(p) {
  const prop = Object.values(p.properties || {}).find(x => x.type === 'title');
  return prop?.title?.map(t => t.plain_text).join('') || p.id;
}
async function buildActivities() {
  const [meetings, gmail, notion] = await Promise.all([
    readJson(`/workspace/.openclaw/state/meetings-raw-${TODAY}.json`, { fireflies: [], geminiDrive: [] }),
    readJson(`/workspace/.openclaw/state/gmail-today-${TODAY}.json`, { messages: [] }),
    readJson(`/workspace/.openclaw/state/notion-sdr-updated-${TODAY}.json`, { results: [] })
  ]);
  const events = [];
  for (const m of meetings.fireflies || []) events.push({ source: 'fireflies', external_id: m.id, source_url: m.url, occurred_at: safeDate(m.date), title: m.title, summary: compact(m.overview || m.bullets || m.action_items || 'Transcript captured.'), content: m.overview || m.bullets || m.action_items || '', raw: m });
  for (const g of meetings.geminiDrive || []) events.push({ source: 'gemini', external_id: g.id, source_url: g.url, occurred_at: safeDate(g.modifiedTime || g.createdTime), title: g.title, summary: compact(g.content || 'Gemini notes captured.'), content: g.content || '', raw: g });
  for (const m of gmail.messages || []) events.push({ source: 'gmail', external_id: m.id, source_url: '', occurred_at: safeDate(m.date), title: m.subject || '(no subject)', summary: compact(m.snippet || m.body || ''), content: m.body || '', raw: m });
  for (const p of notion.results || []) events.push({ source: 'sdr', external_id: p.id, source_url: p.url, occurred_at: safeDate(p.last_edited_time), title: titleOfNotionPage(p), summary: 'SDR page edited today in Notion.', content: '', raw: p });
  return events.filter(e => e.external_id || e.title);
}
function clientAliases(client) {
  const map = {
    'Takealot': ['takealot', 'tal'], 'Mr D': ['mr d', 'mrd'], 'HelloPay': ['hellopay', 'hello pay', 'hello finance', 'hpay'],
    'Leroy Merlin': ['leroy merlin', 'lmsa'], 'Dis-Chem': ['dis chem', 'dischem'], 'Goldrush Group': ['goldrush', 'drgt'],
    'Tripco - LekkeSlaap': ['tripco', 'lekkeslaap', 'lekke slaap'], 'OneDayOnly': ['onedayonly', 'odo'], 'Cell C': ['cell c', 'cellc'],
    'Virgin Bet': ['virgin bet', 'virginbet'], 'Hollywoodbets': ['hollywoodbets', 'hollywood bets', 'betfair', 'luckyfish'], 'Fresha': ['fresha'],
    'Bash': ['bash', 'osmos'], 'Sizekhaya National Lottery': ['sizekhaya', 'ilottery'], 'TFG': ['tfg', 'onex', 'one x'], 'Core Group': ['core group', 'istore']
  };
  return [...new Set([client, ...(map[client] || []), ...normalizeName(client).split(' ').filter(w => w.length > 3)])];
}
function eventText(event) { return normalizeName(`${event.title || ''} ${event.summary || ''} ${event.content || ''}`); }
function matchesClient(event, client) { const text = eventText(event); return clientAliases(client).some(a => text.includes(normalizeName(a))); }
function dealKeywords(dealName = '') { return normalizeName(dealName).split(' ').filter(w => w.length > 3 && !['card','cards','wallets','online','person','secure','fields','payment','payments'].includes(w)); }
function matchesDeal(event, deal) {
  const text = eventText(event);
  const exact = normalizeName(deal.name || '');
  if (exact && text.includes(exact)) return true;
  const words = dealKeywords(deal.name);
  return words.length > 0 && words.some(w => text.includes(w));
}
function sourceLabel(s) { return s === 'fireflies' ? 'Fireflies' : s === 'gemini' ? 'Gemini' : s; }

const deals = await pullCompassDeals();
const clientNames = [...new Set(deals.map(d => d.client || 'Unassigned'))].sort();
const clients = await upsert('cc_clients', clientNames.map(name => ({ name, normalized_name: normalizeName(name), aliases: clientAliases(name) })), 'normalized_name');
const clientByName = new Map(clients.map(c => [c.name, c]));

const dealRows = deals.map(d => ({
  compass_id: d.id,
  client_id: clientByName.get(d.client || 'Unassigned')?.id,
  name: d.name,
  sales_stage: d.salesStage,
  status: d.status,
  parsed_status: d.dealUpdatesParsed?.status || '',
  next_steps: d.dealUpdatesParsed?.nextSteps || '',
  sales_dri: d.salesDri,
  cs_dri: d.csDri,
  sc_dri: d.scDri,
  sa_dri: d.saDri,
  compass_updated_at: safeDate(d.updatedAt),
  raw: d,
  active: true
})).filter(r => r.client_id);
const savedDeals = await upsert('cc_deals', dealRows, 'compass_id');

const activities = await buildActivities();
const savedEvents = await upsert('cc_source_events', activities, 'source,external_id');
const clientById = new Map(clients.map(c => [c.id, c]));
const savedDealsByClient = new Map();
for (const d of savedDeals) {
  if (!savedDealsByClient.has(d.client_id)) savedDealsByClient.set(d.client_id, []);
  savedDealsByClient.get(d.client_id).push(d);
}

// Auto-create conservative meeting-note links. Manual/unlinked links are never overwritten.
const existingLinks = await sb('cc_activity_links?select=event_id,client_id,deal_id,match_reason,confidence');
const existingKeys = new Set((existingLinks || []).map(l => `${l.event_id}|${l.client_id}|${l.deal_id}`));
const autoLinks = [];
for (const e of savedEvents.filter(e => NOTE_SOURCES.has(e.source))) {
  for (const c of clients) {
    if (!matchesClient(e, c.name)) continue;
    const clientDeals = savedDealsByClient.get(c.id) || [];
    const matchedDeals = clientDeals.filter(d => matchesDeal(e, d));
    const targetDeals = matchedDeals.length ? matchedDeals : (clientDeals.length === 1 ? clientDeals : []);
    for (const d of targetDeals) {
      const key = `${e.id}|${c.id}|${d.id}`;
      if (!existingKeys.has(key)) autoLinks.push({ event_id: e.id, client_id: c.id, deal_id: d.id, match_reason: 'auto', confidence: matchedDeals.length ? 0.72 : 0.55 });
    }
  }
}
if (autoLinks.length) await upsert('cc_activity_links', autoLinks, 'event_id,client_id,deal_id');
const links = await sb('cc_activity_links?select=event_id,client_id,deal_id,match_reason,confidence,cc_clients(name),cc_deals(compass_id,name)');
const activeLinksByEvent = new Map();
for (const l of links || []) {
  if (l.match_reason === 'unlinked' || Number(l.confidence) < 0) continue;
  if (!activeLinksByEvent.has(l.event_id)) activeLinksByEvent.set(l.event_id, []);
  activeLinksByEvent.get(l.event_id).push({ client: l.cc_clients?.name || '', dealId: l.cc_deals?.compass_id, dealName: l.cc_deals?.name || '', matchReason: l.match_reason || 'auto' });
}

const byClient = new Map();
for (const c of clients) byClient.set(c.id, { client: c.name, deals: [], activities: [] });
for (const d of savedDeals) byClient.get(d.client_id)?.deals.push({
  id: d.compass_id,
  name: d.name,
  salesStage: d.sales_stage,
  status: d.status,
  parsedStatus: d.parsed_status,
  nextSteps: d.next_steps,
  salesDri: d.sales_dri,
  csDri: d.cs_dri,
  scDri: d.sc_dri,
  saDri: d.sa_dri,
  updatedAt: d.compass_updated_at
});
for (const e of savedEvents) {
  for (const c of clients) {
    if (matchesClient(e, c.name)) byClient.get(c.id)?.activities.push({ source: sourceLabel(e.source), time: e.occurred_at, title: e.title, summary: e.summary, url: e.source_url });
  }
}
const notes = savedEvents
  .filter(e => NOTE_SOURCES.has(e.source))
  .map(e => ({ id: e.id, source: e.source, sourceLabel: sourceLabel(e.source), time: e.occurred_at, title: e.title, summary: e.summary, url: e.source_url, links: activeLinksByEvent.get(e.id) || [] }))
  .sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
const payload = {
  generatedAt: new Date().toISOString(),
  filter: `Compass deals where ${SC_NAME} is SC DRI only`,
  totals: { deals: savedDeals.length, clients: clients.length, activity: savedEvents.length, notes: notes.length },
  sourceCoverage: { Compass: `${savedDeals.length} SC-owned deals`, Activity: `${savedEvents.length} source events in latest sync`, MeetingNotes: `${notes.length} Fireflies/Gemini notes` },
  clients: [...byClient.values()].filter(c => c.deals.length).sort((a, b) => b.deals.length - a.deals.length || a.client.localeCompare(b.client)),
  notes
};
await sb('cc_snapshots', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ published: true, payload, source_counts: payload.totals }) });
console.log(JSON.stringify({ ok: true, deals: savedDeals.length, clients: clients.length, events: savedEvents.length, notes: notes.length, autoLinks: autoLinks.length, generatedAt: payload.generatedAt }, null, 2));

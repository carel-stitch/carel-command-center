#!/usr/bin/env node
/**
 * Carel Command Center Supabase sync v2
 *
 * Intended cron: every 30 minutes.
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * Optional env:
 *   CAREL_SC_NAME="Carel van Dyk"
 *
 * Current responsibilities:
 *   - Pull Compass deals via MCP bridge.
 *   - Filter deals where Carel is SC DRI only.
 *   - Upsert clients and deals into Supabase.
 *   - Read the latest locally-scanned source activity if available.
 *   - Create a published cc_snapshots row consumed by the Vercel app.
 *
 * Follow-up upgrade:
 *   - Move Fireflies/Gemini/Gmail/Slack/SDR fetching directly into this script instead of relying on local scan files.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SC_NAME = process.env.CAREL_SC_NAME || 'Carel van Dyk';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Not syncing.');
  process.exit(2);
}

const headers = {
  apikey: SERVICE_KEY,
  authorization: `Bearer ${SERVICE_KEY}`,
  'content-type': 'application/json'
};

function normalizeName(s = '') {
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function safeDate(s) {
  return s ? new Date(s).toISOString() : null;
}
function compact(s = '', max = 360) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function upsert(table, rows, conflict) {
  if (!rows.length) return [];
  return sb(`${table}?on_conflict=${encodeURIComponent(conflict)}`, {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows)
  });
}
async function pullCompassDeals() {
  const { stdout } = await execFileAsync('mcp-bridge', ['call', 'compass', 'list_deals', '{}'], { maxBuffer: 20 * 1024 * 1024 });
  const outer = JSON.parse(stdout);
  const text = Array.isArray(outer) && outer[0]?.text ? outer[0].text : stdout;
  const all = JSON.parse(text);
  return all.filter(d => (d.scDri || '').toLowerCase().includes(SC_NAME.toLowerCase()));
}
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
function titleOfNotionPage(p) {
  const prop = Object.values(p.properties || {}).find(x => x.type === 'title');
  return prop?.title?.map(t => t.plain_text).join('') || p.id;
}
function buildActivities() {
  return Promise.all([
    readJson('/workspace/.openclaw/state/meetings-raw-2026-10-16.json', { fireflies: [], geminiDrive: [] }),
    readJson('/workspace/.openclaw/state/gmail-today-2026-10-16.json', { messages: [] }),
    readJson('/workspace/.openclaw/state/notion-sdr-updated-2026-10-16.json', { results: [] })
  ]).then(([meetings, gmail, notion]) => {
    const events = [];
    for (const m of meetings.fireflies || []) events.push({ source: 'fireflies', external_id: m.id, source_url: m.url, occurred_at: safeDate(m.date), title: m.title, summary: compact(m.overview || m.bullets || m.action_items || 'Transcript captured.'), content: m.overview || m.bullets || m.action_items || '', raw: m });
    for (const g of meetings.geminiDrive || []) events.push({ source: 'gemini', external_id: g.id, source_url: g.url, occurred_at: safeDate(g.modifiedTime || g.createdTime), title: g.title, summary: compact(g.content || 'Gemini notes captured.'), content: g.content || '', raw: g });
    for (const m of gmail.messages || []) events.push({ source: 'gmail', external_id: m.id, source_url: '', occurred_at: safeDate(m.date), title: m.subject || '(no subject)', summary: compact(m.snippet || m.body || ''), content: m.body || '', raw: m });
    for (const p of notion.results || []) events.push({ source: 'sdr', external_id: p.id, source_url: p.url, occurred_at: safeDate(p.last_edited_time), title: titleOfNotionPage(p), summary: 'SDR page edited today in Notion.', content: '', raw: p });
    return events;
  });
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
function matchesClient(event, client) {
  const text = normalizeName(`${event.title || ''} ${event.summary || ''} ${event.content || ''}`);
  return clientAliases(client).some(a => text.includes(normalizeName(a)));
}

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

const byClient = new Map();
for (const c of clients) byClient.set(c.id, { client: c.name, deals: [], activities: [] });
for (const d of savedDeals) byClient.get(d.client_id)?.deals.push({
  id: d.compass_id, name: d.name, salesStage: d.sales_stage, status: d.status,
  parsedStatus: d.parsed_status, nextSteps: d.next_steps, salesDri: d.sales_dri, csDri: d.cs_dri, scDri: d.sc_dri, saDri: d.sa_dri, updatedAt: d.compass_updated_at
});
for (const e of savedEvents) {
  for (const c of clients) {
    if (matchesClient(e, c.name)) byClient.get(c.id)?.activities.push({ source: e.source, time: e.occurred_at, title: e.title, summary: e.summary, url: e.source_url });
  }
}
const payload = {
  generatedAt: new Date().toISOString(),
  filter: `Compass deals where ${SC_NAME} is SC DRI only`,
  totals: { deals: savedDeals.length, clients: clients.length, activity: savedEvents.length },
  sourceCoverage: { Compass: `${savedDeals.length} SC-owned deals`, Activity: `${savedEvents.length} source events in latest sync` },
  clients: [...byClient.values()].filter(c => c.deals.length).sort((a, b) => b.deals.length - a.deals.length || a.client.localeCompare(b.client))
};
await sb('cc_snapshots', {
  method: 'POST',
  headers: { prefer: 'return=representation' },
  body: JSON.stringify({ published: true, payload, source_counts: payload.totals })
});
console.log(JSON.stringify({ ok: true, deals: savedDeals.length, clients: clients.length, events: savedEvents.length, generatedAt: payload.generatedAt }, null, 2));

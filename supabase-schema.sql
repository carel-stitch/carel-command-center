-- Carel Command Center — Supabase schema v2
-- Purpose: Compass deals + source activity + daily snapshots for Vercel Command Center.

create extension if not exists pgcrypto;

create table if not exists public.cc_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  normalized_name text not null unique,
  aliases text[] not null default '{}',
  tier text not null default 'watch',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cc_deals (
  id uuid primary key default gen_random_uuid(),
  compass_id uuid unique,
  client_id uuid not null references public.cc_clients(id) on delete cascade,
  name text not null,
  sales_stage text,
  status text,
  parsed_status text,
  next_steps text,
  sales_dri text,
  cs_dri text,
  sc_dri text,
  sa_dri text,
  compass_updated_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cc_source_events (
  id uuid primary key default gen_random_uuid(),
  source text not null, -- slack | gmail | fireflies | gemini | sdr | compass
  external_id text,
  source_url text,
  occurred_at timestamptz,
  fetched_at timestamptz not null default now(),
  title text,
  summary text,
  content text,
  raw jsonb not null default '{}'::jsonb,
  unique(source, external_id)
);

create table if not exists public.cc_activity_links (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.cc_source_events(id) on delete cascade,
  client_id uuid references public.cc_clients(id) on delete cascade,
  deal_id uuid references public.cc_deals(id) on delete cascade,
  match_reason text,
  confidence numeric default 0.5,
  created_at timestamptz not null default now(),
  unique(event_id, client_id, deal_id)
);

create table if not exists public.cc_snapshots (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz not null default now(),
  snapshot_date date not null default current_date,
  published boolean not null default false,
  payload jsonb not null,
  source_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_cc_clients_name on public.cc_clients(name);
create index if not exists idx_cc_deals_client on public.cc_deals(client_id, status, sales_stage);
create index if not exists idx_cc_deals_sc on public.cc_deals(sc_dri) where active = true;
create index if not exists idx_cc_source_events_time on public.cc_source_events(occurred_at desc, source);
create index if not exists idx_cc_activity_links_client on public.cc_activity_links(client_id, created_at desc);
create index if not exists idx_cc_snapshots_pub on public.cc_snapshots(published, generated_at desc);

create or replace function public.cc_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists cc_clients_updated_at on public.cc_clients;
create trigger cc_clients_updated_at before update on public.cc_clients for each row execute function public.cc_set_updated_at();

drop trigger if exists cc_deals_updated_at on public.cc_deals;
create trigger cc_deals_updated_at before update on public.cc_deals for each row execute function public.cc_set_updated_at();

alter table public.cc_clients enable row level security;
alter table public.cc_deals enable row level security;
alter table public.cc_source_events enable row level security;
alter table public.cc_activity_links enable row level security;
alter table public.cc_snapshots enable row level security;

-- Website/browser should only read published snapshot payloads.
drop policy if exists "cc published snapshots readable" on public.cc_snapshots;
create policy "cc published snapshots readable"
  on public.cc_snapshots
  for select
  to anon, authenticated
  using (published = true);

-- Service role daily sync bypasses RLS. Do not expose service role key to browser.

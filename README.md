# Carel Command Center

Dark-mode Stitch Command Center for Carel's SC-owned Compass deals.

## Runtime

- Frontend: static HTML/CSS/JS on Vercel.
- Data: latest published `cc_snapshots` row in Supabase.
- Sync: `sync-command-center.mjs` upserts Compass deals + activity into Supabase and publishes a snapshot.
- Schedule: OpenClaw cron every 30 minutes.

## Local preview

```bash
npm run dev
# open http://127.0.0.1:4173
```

## Required sync env

Do not commit these.

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
CAREL_SC_NAME='Carel van Dyk'
```

## Supabase

Run `supabase-schema.sql` in Supabase SQL Editor. RLS is enabled; browser reads only published snapshots.

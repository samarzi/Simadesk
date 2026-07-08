---
name: simadesk:supabase-ops
description: "Run Supabase database operations: execute SQL via Management API, deploy edge functions, and query REST API. Use for migrations, data fixes, and function deployments."
---

# Supabase Operations

Three common operations against the SimaDesk Supabase project (`rdqwzojrsmbdxiczqjci`).

## 1. Run SQL via Management API

Execute arbitrary SQL against the connected database:

```bash
cd "/Users/samarzi/Desktop/SIMA OS/SIMA-samarzi/Projects/SimaDesk" && \
SUPA_TOKEN=$(grep SUPABASE_ACCESS_TOKEN .env | cut -d= -f2) && \
curl -s -X POST \
  "https://api.supabase.com/v1/projects/rdqwzojrsmbdxiczqjci/database/query" \
  -H "Authorization: Bearer $SUPA_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"query":"YOUR_SQL_HERE"}'
```

- Requires `SUPABASE_ACCESS_TOKEN` in `.env`.
- Use for DDL (ALTER TABLE, CREATE INDEX) and DML (UPDATE, INSERT).
- Always wrap in `IF NOT EXISTS` / `IF EXISTS` for idempotency.

## 2. Deploy Edge Functions

```bash
cd "/Users/samarzi/Desktop/SIMA OS/SIMA-samarzi/Projects/SimaDesk" && \
set -a && source .env && set +a && \
supabase functions deploy <function-name> --project-ref rdqwzojrsmbdxiczqjci
```

- Requires Supabase CLI installed and linked.
- Set all env vars from `.env` before deploy.

## 3. Query via REST API

```bash
cd "/Users/samarzi/Desktop/SIMA OS/SIMA-samarzi/Projects/SimaDesk" && \
SUPA_URL=$(grep VITE_SUPA_URL .env | cut -d= -f2) && \
SVC_KEY=$(grep SUPABASE_SERVICE_ROLE_KEY .env | cut -d= -f2) && \
curl -s "${SUPA_URL}/rest/v1/<table>?select=*&limit=10" \
  -H "apikey: $SVC_KEY" \
  -H "Authorization: Bearer $SVC_KEY"
```

- Use `SUPABASE_SERVICE_ROLE_KEY` (not anon key) for full access.
- Table name must match Supabase schema exactly.

## Project details

- **Project ref**: `rdqwzojrsmbdxiczqjci`
- **Supabase URL**: `https://rdqwzojrsmbdxiczqjci.supabase.co`
- **Migrations dir**: `migrations/` and `supabase/migrations/`

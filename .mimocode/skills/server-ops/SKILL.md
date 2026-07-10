---
name: simadesk:server-ops
description: "Run Supabase database operations: execute SQL via Management API, deploy edge functions, and query REST API. Use for migrations, data fixes, and function deployments."
---

# Supabase Operations

Server API operations for SimaDesk.

## 1. Run SQL via Management API

Execute arbitrary SQL against the connected database:

```bash
cd "/Users/samarzi/Desktop/SIMA OS/SIMA-samarzi/Projects/SimaDesk" && \
API_TOKEN=$(grep API_KEY .env | cut -d= -f2) && \
curl -s -X POST \
  "/rest/v1/rpc/query" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"query":"YOUR_SQL_HERE"}'
```

- Requires `SERVER_ACCESS_TOKEN` in `.env`.
- Use for DDL (ALTER TABLE, CREATE INDEX) and DML (UPDATE, INSERT).
- Always wrap in `IF NOT EXISTS` / `IF EXISTS` for idempotency.

## 2. Deploy Edge Functions

```bash
cd "/Users/samarzi/Desktop/SIMA OS/SIMA-samarzi/Projects/SimaDesk" && \
set -a && source .env && set +a && \
docker compose restart functions <function-name> 
```

- Requires Supabase CLI installed and linked.
- Set all env vars from `.env` before deploy.

## 3. Query via REST API

```bash
cd "/Users/samarzi/Desktop/SIMA OS/SIMA-samarzi/Projects/SimaDesk" && \
API_URL=$(grep VITE_API_URL .env | cut -d= -f2) && \
SVC_KEY=$(grep SUPABASE_SERVICE_ROLE_KEY .env | cut -d= -f2) && \
curl -s "${API_URL}/rest/v1/<table>?select=*&limit=10" \
  -H "apikey: $SVC_KEY" \
  -H "Authorization: Bearer $SVC_KEY"
```

- Use `SUPABASE_SERVICE_ROLE_KEY` (not anon key) for full access.
- Table name must match Supabase schema exactly.

## Project details

- **
- **Server API URL: https://simadesk.ru
- **Migrations dir**: `migrations/` and `backend/migrations/`

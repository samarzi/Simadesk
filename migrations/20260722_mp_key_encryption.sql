-- ============================================================================
--  Phase 1 — Marketplace API-key encryption (ADDITIVE, non-breaking)
--
--  Adds encrypted-secret columns alongside the existing plaintext ones.
--  Nothing reads these yet, and the old plaintext columns keep working, so this
--  migration changes no behavior. Ciphertext is written by the backfill step
--  (edge function / script) using MP_ENC_KEY — see DEPLOYMENT notes.
--
--  Rollout order (later phases, separate migrations):
--    Phase 2 — mp-proxy edge function decrypts server-side & calls marketplaces
--    Phase 3 — frontend switches to mp-proxy, one marketplace at a time
--    Phase 4 — revoke SELECT on plaintext columns / drop them
-- ============================================================================

-- ── Ozon ────────────────────────────────────────────────────────────────────
ALTER TABLE ozon_stores
  ADD COLUMN IF NOT EXISTS api_key_enc   text,
  ADD COLUMN IF NOT EXISTS client_id_enc text;

-- ── WB ──────────────────────────────────────────────────────────────────────
ALTER TABLE wb_stores
  ADD COLUMN IF NOT EXISTS api_key_enc          text,
  ADD COLUMN IF NOT EXISTS feedback_api_key_enc text;

-- ── Yandex ──────────────────────────────────────────────────────────────────
ALTER TABLE yandex_stores
  ADD COLUMN IF NOT EXISTS api_key_enc text;

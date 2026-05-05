-- SPDX-License-Identifier: MPL-2.0
-- P18 — DB-backed AI provider API keys (encrypted at rest).
--
-- Original schema (0011) pinned API keys to "the secrets manager / env"
-- only. That made provider switching require a redeploy and (on cloud
-- installs) the key never even reached the running container — the
-- dogfood install hit "ANTHROPIC_API_KEY not set" the moment chat fired.
--
-- This migration adds four columns so each row can carry its own
-- AES-256-GCM ciphertext + IV + KEK fingerprint + last-set timestamp.
-- Plaintext is NEVER persisted; the key is encrypted by
-- packages/admin-core/src/security/secret-box.ts before INSERT.
--
-- Existing rows stay NULL across the four new columns until the Owner
-- saves a key via /security/ai. The ProviderResolver falls back to
-- process.env[envNameFor(name)] (the legacy path) when api_key_encrypted
-- IS NULL so Compose installs that already wired ANTHROPIC_API_KEY keep
-- working through the upgrade.

ALTER TABLE ai_providers
  ADD COLUMN IF NOT EXISTS api_key_encrypted bytea       NULL,
  ADD COLUMN IF NOT EXISTS api_key_iv        bytea       NULL,
  ADD COLUMN IF NOT EXISTS api_key_kek_fp    text        NULL,
  ADD COLUMN IF NOT EXISTS api_key_set_at    timestamptz NULL;

-- Sanity: ciphertext + iv + kek_fp must travel together. Either all four
-- key fields are NULL (no DB-stored key, env fallback applies) or all
-- three encryption fields are present (set_at may be NULL on older
-- backfilled rows but new writes always populate it).
ALTER TABLE ai_providers
  DROP CONSTRAINT IF EXISTS ai_providers_key_triplet_consistent;
ALTER TABLE ai_providers
  ADD CONSTRAINT ai_providers_key_triplet_consistent CHECK (
    (api_key_encrypted IS NULL AND api_key_iv IS NULL AND api_key_kek_fp IS NULL)
    OR
    (api_key_encrypted IS NOT NULL AND api_key_iv IS NOT NULL AND api_key_kek_fp IS NOT NULL)
  );

-- SPDX-License-Identifier: MPL-2.0
--
-- Epic #1644 (R7, issue #1650) — the embedding model a Stage indexed a
-- collection with.
--
-- collection_releases.vector_model  the core catalog id the plugin's
--                           configuration named when the Stage planned the
--                           release (its `vectorModelConfig` leaf), or NULL
--                           when semantic search is off. Frozen with the
--                           Stage like the rest of its configuration: the
--                           index job embeds with it, and a Stage whose model
--                           differs from the previous release's rebuilds
--                           instead of carrying it over (query vectors of one
--                           model never meet passage vectors of another).
--
-- Expand-only: a nullable column the previous release does not read.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE collection_releases
  ADD COLUMN IF NOT EXISTS vector_model text
    CHECK (vector_model IS NULL OR vector_model ~ '^[a-z0-9][a-z0-9.-]{0,79}$');

COMMIT;

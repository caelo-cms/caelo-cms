-- SPDX-License-Identifier: MPL-2.0
-- #527 / #532 — one ledger for every paid image request, chat and plugins.
--
-- 0222's plugin_image_requests becomes image_requests. A request belongs
-- to a scope — `plugin:<plugin_id>` or `chat:<chat_session_id>` — and its
-- id is unique only inside that scope, so one caller can never collide
-- with (or probe for) another caller's request ids.
--
-- Provenance (#532) is recorded at reservation: the operation, the prompt,
-- the immutable references (id + sha256 per source), an optional mask, what
-- was requested and the provider. The output side lands in `result` (plugin
-- private file) or `output_media_id` (chat → media library).
ALTER TABLE plugin_image_requests RENAME TO image_requests;
ALTER TABLE image_requests DROP CONSTRAINT plugin_image_requests_pkey;
ALTER TABLE image_requests ALTER COLUMN plugin_id DROP NOT NULL;
ALTER TABLE image_requests
  ADD COLUMN scope text,
  ADD COLUMN chat_session_id uuid NULL REFERENCES chat_sessions(id) ON DELETE SET NULL,
  ADD COLUMN actor_id uuid NULL REFERENCES actors(id),
  ADD COLUMN operation text NOT NULL DEFAULT 'generate' CHECK (operation IN ('generate', 'edit')),
  ADD COLUMN prompt text,
  ADD COLUMN references_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN mask_json jsonb NULL,
  ADD COLUMN requested jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN provider text,
  ADD COLUMN output_media_id uuid NULL REFERENCES media_assets(id) ON DELETE SET NULL,
  ADD COLUMN finished_at timestamptz NULL;
UPDATE image_requests SET scope = 'plugin:' || plugin_id::text, provider = 'google';
ALTER TABLE image_requests ALTER COLUMN scope SET NOT NULL;
ALTER TABLE image_requests ADD PRIMARY KEY (scope, id);
ALTER TABLE image_requests ADD CONSTRAINT image_requests_owner_check CHECK (
  (scope LIKE 'plugin:%' AND plugin_id IS NOT NULL)
  OR (scope LIKE 'chat:%' AND plugin_id IS NULL)
);
CREATE INDEX image_requests_output_media_idx ON image_requests (output_media_id)
  WHERE output_media_id IS NOT NULL;

-- Plugin rows stay host-only (their prompts and references are the
-- plugin's private data). Chat rows are the site's own provenance:
-- readable by any authenticated actor, written by the host only.
DROP POLICY plugin_image_requests_host ON image_requests;
CREATE POLICY image_requests_host ON image_requests FOR ALL
  USING (current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');
CREATE POLICY image_requests_chat_read ON image_requests FOR SELECT
  USING (
    scope LIKE 'chat:%'
    AND NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL
  );

-- #532 derivative lineage: an edit (or a later upscale) points at the
-- asset it was made from.
ALTER TABLE media_assets
  ADD COLUMN derived_from_id uuid NULL REFERENCES media_assets(id) ON DELETE SET NULL;

-- SPDX-License-Identifier: MPL-2.0
-- Idempotency ledger for host-brokered paid image calls; no application/book data.
CREATE TABLE plugin_image_requests (
  plugin_id uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  input_sha256 text NOT NULL,
  call_id uuid NOT NULL REFERENCES ai_calls(id),
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','ready','uncertain')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, id)
);
ALTER TABLE plugin_image_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_image_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY plugin_image_requests_host ON plugin_image_requests FOR ALL
  USING (current_setting('caelo.actor_kind', true) = 'system')
  WITH CHECK (current_setting('caelo.actor_kind', true) = 'system');

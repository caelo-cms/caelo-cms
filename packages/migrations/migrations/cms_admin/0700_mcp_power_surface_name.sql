-- SPDX-License-Identifier: MPL-2.0
--
-- 0700 — issue #1636: the Power-MCP surface is stored as 'power'.
--
-- The surface a token or a remote connection opens was stored as 'admin'
-- (`mcp_tokens.scope`, 0198; `mcp_remote_connections.surface`, 0319). The
-- name promised admin rights the surface never gave: it is the Live Edit
-- chat's tool catalogue, run by the person's own AI tool. From this release
-- the code writes 'power' and reads both spellings (mcp_credential.ts).
--
-- Expand half (RELEASING.md "Contract migrations"): the CHECKs accept the
-- new value next to the old one and no row is rewritten, so the previous
-- image, which reads and writes 'admin', keeps running on this schema. The
-- rewrite of the old rows and the narrowing of the CHECKs follow with 1.0
-- (#1638); the release before that one already writes 'power', so that
-- migration is not a contract migration either.
--
-- `via_legacy_address`: the address a connector uses is its own business
-- (`/api/mcp/admin` keeps working until 1.0), so the Owner needs to see
-- which connected apps still come through it before it goes. The resolver
-- records it with `last_used_at`. Every Power connection that exists now
-- came through the old address; a re-added connector clears the mark on its
-- next request.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE mcp_tokens DROP CONSTRAINT mcp_tokens_scope_check;
ALTER TABLE mcp_tokens ADD CONSTRAINT mcp_tokens_scope_check
  CHECK (scope IN ('chat', 'admin', 'power'));

ALTER TABLE mcp_remote_connections DROP CONSTRAINT mcp_remote_connections_surface_check;
ALTER TABLE mcp_remote_connections ADD CONSTRAINT mcp_remote_connections_surface_check
  CHECK (surface IN ('chat', 'admin', 'power'));

-- #741: "may use Caelo's AI" exists on the Power surface only, in either spelling.
ALTER TABLE mcp_remote_connections DROP CONSTRAINT mcp_remote_connections_check;
ALTER TABLE mcp_remote_connections ADD CONSTRAINT mcp_remote_connections_allow_caelo_ai_check
  CHECK (allow_caelo_ai = false OR surface IN ('admin', 'power'));

ALTER TABLE mcp_remote_connections
  ADD COLUMN via_legacy_address boolean NOT NULL DEFAULT false;
UPDATE mcp_remote_connections SET via_legacy_address = true WHERE surface = 'admin';

COMMIT;

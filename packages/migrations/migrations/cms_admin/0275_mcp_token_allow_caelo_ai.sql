-- SPDX-License-Identifier: MPL-2.0
--
-- Issue #741 — whether an admin-scoped (Power-MCP) token may spend the
-- install's own AI. Off by default: the external agent does the AI work on
-- its own subscription, and Caelo hands it work items (translations, …)
-- instead of calling its provider. An Owner turns it on per token when the
-- agent should be able to use Caelo-side generation (images, translation
-- runs); the token's cost cap then applies. Existing tokens stay off, so no
-- bearer silently starts spending the install's AI.

ALTER TABLE mcp_tokens
  ADD COLUMN IF NOT EXISTS allow_caelo_ai boolean NOT NULL DEFAULT false;

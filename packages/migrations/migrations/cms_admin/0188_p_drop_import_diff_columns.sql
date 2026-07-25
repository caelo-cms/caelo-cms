-- SPDX-License-Identifier: MPL-2.0
--
-- 0188 — drop the import-page screenshot-DIFF columns.
--
-- The screenshot-diff fidelity/parity gates were removed (they graded "how
-- close to the original pixels", which is meaningless for a refresh/optimize
-- direction and brittle even for a 1:1 takeover — a one-line reflow cascades
-- into a large pixel delta → false fail). Both `verify_import_page_fidelity`
-- and `check_genesis_parity` + the whole diff engine are gone; the crawler now
-- delivers the same shape as live-inspect, just persisted (source screenshot +
-- design tokens), and correctness is checked by a Markdown/content comparison
-- plus an AI visual self-check.
--
-- So the per-page diff verdict + the staged (rebuilt) screenshot key are dead
-- columns. Drop them. KEEP `screenshot_object_key` — that is the SOURCE
-- screenshot capture, the persisted-inspect payload the AI still looks at.
--
-- Idempotent (IF EXISTS). No RLS impact — policies are per-table, not
-- per-column.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE import_pages
  DROP COLUMN IF EXISTS diff_status,
  DROP COLUMN IF EXISTS diff_pct,
  DROP COLUMN IF EXISTS staged_screenshot_object_key;

COMMIT;

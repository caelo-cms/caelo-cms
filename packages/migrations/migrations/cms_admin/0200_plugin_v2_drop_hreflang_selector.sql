-- SPDX-License-Identifier: MPL-2.0
--
-- 0200 — plugin-system v2 Phase A (#383): drop hreflang + language-selector.
--
-- Epic #380: hreflang and the language selector return as contributions
-- from the international-site plugin on the head composition point
-- (#391/#398) — implemented once, consumed identically by generator and
-- preview, instead of today's two hand-kept copies. The generator and
-- preview composer no longer read `pages_hreflang` or render the
-- `language-selector` structured-set kind.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

DROP TABLE IF EXISTS pages_hreflang;

-- The kind is gone from the structuredSetKind enum; surviving rows
-- would fail Zod validation on the next write. Delete, don't migrate.
DELETE FROM structured_sets WHERE kind = 'language-selector';

COMMIT;

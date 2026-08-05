-- SPDX-License-Identifier: MPL-2.0
--
-- 0199 — plugin-system v2 Phase A (#382): drop the locale management layer.
--
-- Epic #380: the §11.A propose/execute machinery for locales (queue
-- table, execute fan-out, Advanced-URL-Routing toggle) is deleted from
-- core. Locale definitions become plugin-owned data on the new plugin
-- foundation (#394); URL-shape changes will route through the generic
-- URL-migration proposal engine (#390). The `locales` table itself and
-- the read ops survive until the page-identity cut (#384).

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

DROP TABLE IF EXISTS locale_pending_actions;

ALTER TABLE site_settings DROP COLUMN IF EXISTS advanced_url_routing;

-- The homepage skill (0185) pointed the AI at the removed
-- propose_update_locale_strategy tool. Surgical replace, idempotent by
-- distinctive substring; the rest of rule 4 stays accurate.
UPDATE skills SET body = replace(body,
  $o$A locale prefix like `/en/` is the LOCALE URL-STRATEGY (admin-gated — `propose_update_locale_strategy`), plus,$o$,
  $n$A locale prefix like `/en/` is the LOCALE URL-STRATEGY (admin-gated), plus,$n$
) WHERE body LIKE '%propose_update_locale_strategy%';

COMMIT;

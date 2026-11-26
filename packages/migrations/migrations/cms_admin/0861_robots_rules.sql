-- SPDX-License-Identifier: MPL-2.0
--
-- 0861 (written as 0785; renumbered above v0.12.16's 0860 so upgraded and fresh installs apply it in the same order) — issue #1706: the Owner's own robots.txt rules.
--
-- robots.txt is built (CLAUDE.md §2: static files are data, robots.txt and
-- sitemap.xml are the generator's), and until now it held only
-- `User-agent: * / Allow: /` and the Sitemap lines. The Owner may now add
-- Allow and Disallow paths per user agent, through Settings → SEO or the
-- AI's approval-gated propose_set_site_seo. Each element:
-- { "userAgents": [...], "allow": [...], "disallow": [...] }, validated by
-- robotsRulesSchema (packages/shared/src/robots-rules.ts) at every write.
--
-- A rendered setting (docs/dev/redirects-and-settings-sync.md): stored live
-- here, read by the build, and carried by it on its run
-- (deploy_runs.robots_rules), because Publish live and a rollback rewrite
-- robots.txt for the live target from the build they ship, never from what
-- the setting says by then. Null on a run from before the rules existed:
-- that build had none.
--
-- Expand only: a server of the previous release reads neither column.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE site_defaults
  ADD COLUMN IF NOT EXISTS robots_rules jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(robots_rules) = 'array');

ALTER TABLE deploy_runs
  ADD COLUMN IF NOT EXISTS robots_rules jsonb
    CHECK (robots_rules IS NULL OR jsonb_typeof(robots_rules) = 'array');

COMMIT;

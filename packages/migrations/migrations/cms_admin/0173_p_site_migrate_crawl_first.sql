-- SPDX-License-Identifier: MPL-2.0
--
-- 0173 — site-migrate: crawl BEFORE you theme or build.
--
-- Live onboarding trace (thinking on): after inspecting the homepage +
-- mapping page types, the AI richly inspected the homepage sample and
-- proposed a THEME (propose_create_theme) — but never proposed the crawl
-- (propose_site_import). The onboarding contract is "a domain message
-- becomes a crawl PROPOSAL": you have only seen the homepage, so theming
-- or building before the whole site is crawled is premature. Thinking
-- makes the model plan ahead and jump to theming; this guard pins the
-- order. Surgical replace(), idempotent.

BEGIN;

UPDATE skills SET body = replace(
  body,
  'Bring in the source truth for the pages you will build with a SCOPED, list-mode import',
  'CRAWL FIRST — your FIRST gated proposal on a domain migration is ALWAYS the crawl (propose_site_import). You have only seen the homepage at this point: do NOT propose a theme (propose_create_theme), richly inspect samples, or build any page until the crawl is approved and reaches ready_for_review. Bring in the source truth for the pages you will build with a SCOPED, list-mode import'
)
WHERE slug = 'site-migrate';

COMMIT;

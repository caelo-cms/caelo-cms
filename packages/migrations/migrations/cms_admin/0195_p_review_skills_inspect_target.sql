-- SPDX-License-Identifier: MPL-2.0
--
-- 0195 — qa-check / legal-check: fetch the page CONTENT, not just the summary.
--
-- `inspect_page_render` now returns a SLIM SUMMARY by default (module list +
-- byte sizes, no bodies); the rendered content is pulled with
-- `target:"composed"`. The two review skills say "read the page via
-- inspect_page_render" — with the new default that yields a summary, not the
-- text they need to review. Point them at `target:"composed"`.
--
-- Surgical replace()s, idempotent by distinctive substring.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills SET body = replace(body,
  $o$Use `inspect_page_render` if a page id was supplied.$o$,
  $n$Use `inspect_page_render({pageId, target:"composed"})` (target "composed" returns the rendered page content to review; the bare call returns only a structure summary) if a page id was supplied.$n$
) WHERE slug = 'qa-check';

UPDATE skills SET body = replace(body,
  $o$Read the page via `inspect_page_render`.$o$,
  $n$Read the page's rendered content via `inspect_page_render({pageId, target:"composed"})` (the bare call returns only a structure summary).$n$
) WHERE slug = 'legal-check';

COMMIT;

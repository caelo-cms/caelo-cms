-- SPDX-License-Identifier: MPL-2.0
-- Issue #417 — field-naming guidance: role-based names + the
-- repeating-content rule + "module-list is safe; when unsure prefer
-- text-list/link-list over scalar fanout".
--
-- Background: the 2026-08-03 dogfood run minted card grids with
-- content-derived scalar field names (quote_justamazing,
-- logo_marktforschung) instead of a module-list of card sub-modules,
-- because the module-list authoring contract was unverified. The
-- mechanical half (numbered-scalar fanout) is now rejected by the
-- module-field validator; content-derived naming is not mechanically
-- detectable, so this guidance is the enforcement layer for it (§1A).
--
-- ADDITIVE ON PURPOSE: appends a new subsection to the skill bodies via
-- `body || …` with a sentinel-phrase idempotency guard — no string
-- replacement of existing text — so it cannot conflict with the
-- parallel in-flight skill migrations (issue #414's docs pass, the
-- plugin-v2 chain holding 0200-0201, and 0202-0207 reserved by other
-- PRs — hence this file's 0208). Targets both authoring skills:
-- manage-module (module authoring) AND compose-page (build_page turns
-- engage it without manage-module).

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = body || E'\n\nFIELD NAMES DESCRIBE THE ROLE, NEVER THE CONTENT:\n'
     || E'- A field name says what the slot IS FOR (`quote_text`, `author_name`, `logo_image`), never what happens to be in it today (`quote_justamazing`, `logo_marktforschung`). Content-derived names make the module semantically non-reusable: the next page''s content turns every name into a lie.\n'
     || E'- Repeating content is ONE list field holding N items: `text-list` (strings), `link-list` ({label, href} pairs), or a `module-list` of card sub-modules for rich per-item structure — never numbered scalars (`label`, `label2`, `label3`) and never one scalar field per concrete item. The validator rejects 3+ numbered scalar siblings loudly; a two-field layout split (`col1`/`col2`) stays fine.\n'
     || E'- The `module-list` path is verified end to end and safe to use: in build_page, mint each card sub-module as a DETACHED entry (`ref`, no `blockName`) and pass the parent''s module-list field value as [{"$ref": "<ref>"}, ...] — one call, cards render in order.\n'
     || E'- If you are still unsure whether a repeat needs module-list, prefer `text-list`/`link-list` over any scalar fanout — a list field is always right for repeating content; per-item scalar fields never are.'
 WHERE slug IN ('manage-module', 'compose-page')
   AND position('FIELD NAMES DESCRIBE THE ROLE, NEVER THE CONTENT' in body) = 0;

COMMIT;

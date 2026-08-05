-- SPDX-License-Identifier: MPL-2.0
--
-- 0209 — retire the Design Manifest store (issue #430).
--
-- 0108 introduced `design_manifests` as a separate, latest-wins record of
-- the site's design language, written by a `set_design_manifest` call at
-- the end of Site Genesis. On the dogfood install that call never
-- happened once: it was pure bookkeeping, it produced nothing the
-- operator could see, and it only existed on the Genesis path (the site
-- was built by migration). The empty row then disabled the write-time
-- design guard, including the one check that never needed the manifest —
-- so 18 modules were written with no supervision at all.
--
-- Everything the manifest held is now stored where it is already
-- produced: token ROLES ride on the token's own `$description` (set in
-- the same call as its value, and preserved across later value edits),
-- and page PATTERNS are the module rows, which already carry
-- displayName / kind / type / description. Nothing to capture first, so
-- the guard works on every install including migrated ones.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

DROP TABLE IF EXISTS design_manifests;

-- 0108 appended a "write the Design Manifest" step to the site-genesis
-- skill. Replace that paragraph in place (later migrations appended
-- further text, so this must not truncate the tail) with the guidance
-- that matches where the record now lives.
UPDATE skills
SET body = replace(
  body,
  'After materialising, write the Design Manifest: `set_design_manifest` with the token ROLES you just decided (which var is for CTAs, which surfaces alternate), the typography + rhythm rules, and one pattern entry per section type you built (name + module type + one-line spec). Every future page follows this manifest — it is how page B stays on page A''s line.',
  'Record each token''s ROLE as you set it — pass `$description` inside the value envelope in the SAME `propose_create_theme` / `set_theme_tokens` call (e.g. `{$type: ''color'', $value: ''#4f46e5'', $description: ''CTAs, links and selected states — never large background fills''}`). Say where a token must NOT be used, not only where it should. That is the whole design-system record: every module write replays the roles of the vars its CSS references, so page B stays on page A''s line without a separate document to maintain.'
)
WHERE slug = 'site-genesis'
  AND body LIKE '%set_design_manifest%';

-- 0117 gave the compose/migrate skill the same closing instruction.
UPDATE skills
SET body = replace(
  body,
  ' Finish by writing the Design Manifest (`set_design_manifest`) with the token roles and one pattern entry per confirmed page type — that is what keeps every future page on the migrated design''s line.',
  ' Record the token ROLES as you set the theme — `$description` inside each value envelope in the same `set_theme_tokens` call — so the measured palette carries its own usage rules. That, plus the module rows you just wrote, is what keeps every future page on the migrated design''s line.'
)
WHERE body LIKE '%Finish by writing the Design Manifest%';

-- 0169's theme-branding workflow skill names both tools in its body and
-- whitelists them in `tools`. A skill that points at a tool the runner no
-- longer serves is a dead end mid-task, so patch both.
UPDATE skills
SET body = replace(
  body,
  'set_theme_meta edits theme name / metadata; set_design_manifest / get_design_manifest carry the higher-level design intent (mood, references) that guides craft.',
  'set_theme_meta edits theme name / metadata. A token''s ROLE — what it is for and where it must NOT be used — rides on the token itself: pass `$description` inside the value envelope in the same set_theme_tokens call. Module writes replay those roles back to you, so they are the site''s design system; there is no separate manifest.'
),
    allowlisted_tools = (
      SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
      FROM jsonb_array_elements(allowlisted_tools) AS t
      WHERE t NOT IN ('"set_design_manifest"'::jsonb, '"get_design_manifest"'::jsonb)
    )
WHERE slug = 'theme-branding';

COMMIT;

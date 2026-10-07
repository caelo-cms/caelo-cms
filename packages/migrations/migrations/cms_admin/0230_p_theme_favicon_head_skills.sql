-- SPDX-License-Identifier: MPL-2.0
--
-- 0230 — the theme favicon is emitted into <head> by the platform.
--
-- A favicon bound with `set_theme_asset({slot:'favicon'})` now becomes a
-- `<link rel="icon">` in every page's <head> (composer, preview + static
-- build). Before, nothing was emitted, and four skill bodies told the AI
-- to place the favicon itself via the `{{theme_favicon_url}}` module
-- placeholder — which can only land the tag in <body>, per-layout, and is
-- easy to forget. Rewrite those sentences so the AI binds the favicon and
-- stops there.
--
-- Each UPDATE is a targeted `replace()` guarded by `body LIKE` on the
-- exact old sentence: idempotent, a no-op on an install whose skill text
-- has already moved on, and it never touches an Owner-edited body that
-- no longer carries the sentence.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = replace(
     body,
     '- Brand assets (logo, dark logo, favicon, social share image) are bound with set_theme_asset — modules reference them via the reserved `{{theme_logo_url}}` / `{{theme_favicon_url}}` placeholders.',
     '- Brand assets (logo, dark logo, favicon, social share image) are bound with set_theme_asset. Binding the favicon is all it takes: the platform emits its `<link rel="icon">` into every page''s <head> — never hand-write an icon tag into a module (it would land in <body>). Modules place the logo via the reserved `{{theme_logo_url}}` / `{{theme_logo_dark_url}}` placeholders.'
   )
 WHERE slug = 'theme-branding'
   AND body LIKE '%modules reference them via the reserved `{{theme_logo_url}}` / `{{theme_favicon_url}}` placeholders.%';

UPDATE skills
   SET body = replace(
     body,
     'reference brand assets (logo, favicon) through the reserved theme placeholders (`{{theme_logo_url}}` etc.), never a hard-coded src.',
     'reference brand assets (logo) through the reserved theme placeholders (`{{theme_logo_url}}` etc.), never a hard-coded src. The favicon is never module markup: bind it with set_theme_asset and the platform emits it in <head>.'
   )
 WHERE slug = 'manage-media'
   AND body LIKE '%reference brand assets (logo, favicon) through the reserved theme placeholders%';

UPDATE skills
   SET body = replace(
     body,
     '`{{theme_social_share_url}}`) rather than hard-coded srcs;',
     '`{{theme_social_share_url}}`) rather than hard-coded srcs (the favicon needs no module markup — a bound theme favicon is emitted into <head> automatically);'
   )
 WHERE slug = 'manage-module'
   AND body LIKE '%`{{theme_social_share_url}}`) rather than hard-coded srcs;%';

UPDATE skills
   SET body = replace(
     body,
     'reference `{{theme_logo_url}}`; favicon the same way)',
     'reference `{{theme_logo_url}}`; bind the favicon with `set_theme_asset({slot:''favicon''})` — the platform emits its <head> link, no module markup)'
   )
 WHERE slug = 'site-migrate'
   AND body LIKE '%reference `{{theme_logo_url}}`; favicon the same way)%';

COMMIT;

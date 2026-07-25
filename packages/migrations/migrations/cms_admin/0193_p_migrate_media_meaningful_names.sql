-- SPDX-License-Identifier: MPL-2.0
--
-- 0193 — site-migrate: the AI names each imported asset meaningfully.
--
-- `import_media_from_urls` now takes `assets: [{url, name?}]` (was `urls: []`).
-- The `name` becomes the asset's slug and thus its PUBLIC URL
-- (`/_assets/searchviu-logo.png`) + admin preview URL
-- (`/_caelo/media/searchviu-logo`); the UUID id stays internal. So the AI must
-- give each asset a short meaningful name (from its role/alt), not leave it to
-- a URL-derived filename.
--
-- Surgical replace()s on the 0187 body, idempotent by distinctive substring.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

-- R1 — logo import: named asset.
UPDATE skills SET body = replace(body,
  $o$IMPORT it FIRST with `import_media_from_urls({urls:[<logo url>]})` (or bind it once with `set_theme_asset({slot:'logo'})`$o$,
  $n$IMPORT it FIRST with `import_media_from_urls({assets:[{url:<logo url>, name:'<Brand> logo'}]})` — the `name` you give becomes the public URL (`/_assets/<brand>-logo.png`), so name it meaningfully (or bind it once with `set_theme_asset({slot:'logo'})`$n$
) WHERE slug = 'site-migrate';

-- R2 — homepage assets: named, batched.
UPDATE skills SET body = replace(body,
  $o$IMPORT the images the homepage will use with `import_media_from_urls({urls:[...]})` — the relevant ones from the `images` facet, BATCHED in one call; it returns the Caelo media URLs.$o$,
  $n$IMPORT the images the homepage will use with `import_media_from_urls({assets:[{url, name}, …]})` — the relevant ones from the `images` facet, BATCHED in one call, GIVING EACH A SHORT MEANINGFUL NAME (logo → 'SearchVIU logo', hero → 'SearchVIU hero'): the name becomes the public asset URL (`/_assets/searchviu-hero.png`), the id stays internal. It returns the Caelo media URLs.$n$
) WHERE slug = 'site-migrate';

-- R3 — cross-cutting media rule: name each asset.
UPDATE skills SET body = replace(body,
  $o$Source images/fonts/media enter the site ONLY via `import_media_from_urls` (you name the exact URLs — from the inspect `images` facet, or `list_page_assets({runId, search})` to enumerate/search a crawled page's assets), which returns Caelo media URLs$o$,
  $n$Source images/fonts/media enter the site ONLY via `import_media_from_urls` (you name the exact URLs — from the inspect `images` facet, or `list_page_assets({runId, search})` — AND give each asset a short meaningful `name`, e.g. logo → 'SearchVIU logo': that name becomes the public URL `/_assets/searchviu-logo.png`, the id stays internal), which returns Caelo media URLs$n$
) WHERE slug = 'site-migrate';

COMMIT;

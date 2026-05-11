-- SPDX-License-Identifier: MPL-2.0

-- v0.2.85 — per-target page emission style.
--
-- 'directory'    → existing behavior, emit `<slug>/index.html`.
--                  GCS bucket-website mode serves `/<slug>/` →
--                  `<slug>/index.html`. Exposes `/<slug>/index.html`
--                  in the URL bar when visitors arrive without
--                  trailing slash (the original /features → /features/
--                  index.html bug).
--
-- 'no-extension' → emit `<slug>` directly (no extension) with
--                  Content-Type: text/html. `/<slug>` → 200 page;
--                  `/<slug>/` and `/<slug>/index.html` don't exist
--                  → 404. Canonical URLs become `/<slug>` (no
--                  trailing slash). No redirects needed because
--                  there's nothing to redirect away from.
--
-- Default 'directory' preserves existing-install behavior;
-- operators opt in via UPDATE or via a Pulumi config knob.

ALTER TABLE deploy_targets
  ADD COLUMN IF NOT EXISTS page_url_style text NOT NULL DEFAULT 'directory'
    CHECK (page_url_style IN ('directory', 'no-extension'));

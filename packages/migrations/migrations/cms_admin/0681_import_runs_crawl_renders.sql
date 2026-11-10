-- SPDX-License-Identifier: MPL-2.0
--
-- 0681 — the renders a site import's crawl has asked for (issue #1360).
--
-- The crawl runs in a reporting job of its own (0680) and asks the admin to
-- render each page through the install's renderer (the capture job on Google
-- Cloud). The job read third-party pages, so the admin trusts it no more
-- than its data: `crawl_renders` counts the renders of the run, and the
-- admin refuses one past a budget the run's page cap sets, so a job that
-- went wrong cannot keep starting renders for as long as its attempts last.
--
-- Expand-only: one column with a default, counted by `imports.take_render`.
-- import_runs is exempt from the change journal (change-journal.ts), so
-- nothing derived follows it.

ALTER TABLE import_runs
  ADD COLUMN IF NOT EXISTS crawl_renders integer NOT NULL DEFAULT 0
  CHECK (crawl_renders >= 0);

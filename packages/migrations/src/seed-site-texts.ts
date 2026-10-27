// SPDX-License-Identifier: MPL-2.0

/**
 * #1142 — the "Site texts" list is part of the shipped seed (migration
 * 0358), like the list types: module HTML reads `{{site_text.<key>}}`
 * from it and the AI adds keys to it. Resets that empty `lists` (the dev
 * `truncate.ts`, the test preload) put it back with this statement, so a
 * reset install looks like a fresh one. Idempotent; a no-op while the
 * `site-texts` type is missing.
 */
export const SEED_SITE_TEXTS_LIST_SQL = `
INSERT INTO lists (slug, name, purpose, list_type_id)
SELECT 'site-texts', 'Site texts',
       'The fixed interface texts of the website (breadcrumb aria-label, repeated button and link texts), read by key in module HTML with {{site_text.<key>}}.',
       lt.id
  FROM list_types lt
 WHERE lt.slug = 'site-texts' AND lt.chat_branch_id IS NULL AND lt.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM lists l
      WHERE l.slug = 'site-texts' AND l.chat_branch_id IS NULL AND l.deleted_at IS NULL
   )`;

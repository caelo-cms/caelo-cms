# Internal links as page references

Epic [#724](https://github.com/caelo-cms/caelo-cms/issues/724). An internal link is a **reference to a page**, not the page's path as text. Renaming or moving a page, or adding a locale, changes no stored link. The URL is computed when a page is rendered, for that render's environment and URL style. External links stay literal URLs.

## The model in one paragraph

Authors (operators and the AI) write `/about#team`. The write op stores `caelo:page/<pageId>#team` (write-time canonicalisation). Every render resolves the reference to the target's current path (render-time resolution). Reads that hand content back to the AI or the editor turn references into paths again (humanising), so nobody ever sees an id. A move only touches the page's own row and the redirect table.

## Grammar

| Form | Meaning |
|---|---|
| `caelo:page/<pageId>[?query][#anchor]` | a page of this site |
| `caelo:media/<mediaId>[/<variant>]` | a media asset |

It is a plain string, so `link`/`url` fields, `link-list` items, structured-set items, `href`/`src`/`srcset` in module HTML and rich text all carry it without schema changes. Grammar, parser and the embedded-reference scanner: `packages/shared/src/link-refs.ts`.

## Where each step lives

| Step | Code |
|---|---|
| Canonicalise a write (values, module HTML, field defaults, structured sets, imports) | `packages/shared/src/link-canonicalise.ts` (pure), `packages/admin-core/src/links/canonicalise.ts` + `canonicalise-writes.ts` (site lookup, called inside each write op's transaction) |
| Humanise a read | `packages/admin-core/src/links/humanise.ts` |
| Resolve at render time (preview, live edit, static build) | `createSiteLinkIndex` in `link-refs.ts`; the chat's view of the site is loaded by `packages/admin-core/src/links/link-targets.ts` |
| Same-language target on a locale page | the `link-resolve` composition point (`packages/plugin-host/src/link-resolve.ts`), implemented by the international-site plugin (rollout D) |
| Missing or unpublished target | stays raw, reported in `missingSlots` as `link-target-missing:<kind>/<id>`; the build refuses a missing target and lists unpublished ones in `unpublishedLinkTargets` |

A link to no page is refused at write time with an AI-actionable message (CLAUDE.md §2 and §11). There is no fallback that guesses a path.

## Renames and moves

A slug change (`pages.update` / `update_many`), a subtree move (`pages.move_many`), a chat's moves going live at publish, and a snapshot revert all go through one function: `applyPathMoveEffects` in `packages/admin-core/src/ops/content/path-moves.ts`. It:

1. drops a redirect that sits on a page's new path (the page reclaims it);
2. collapses redirect chains that pointed at an old path;
3. creates a 301 from every old URL, unless the operator asked for the old URL to 404.

It rewrites **no stored link**. The 301s exist for links from outside the site: search engines, bookmarks, other sites. Links on the site follow the page because they are references. Up to rollout G a text rewriter (`path-link-rewrite.ts`, `pages.rewrite_module_links`, the structured-set rewrite in `path-moves.ts`) patched literal paths after every move. It was removed: it missed field defaults (where layout chrome content lives), plugin data and full-origin hrefs.

For the AI this means: write internal links as paths, and never update or re-check links after a rename or move. The `move_pages` and `update_pages_many` tool descriptions, the static system prompt and the `manage-redirects` skill (migration 0298) say so.

## Literal links left from before #724

Content written before #724 can still hold literal internal paths. Two rollouts deal with them, and a move no longer touches them:

- **The one-time migration (rollout E)** turns every literal internal link that resolves to a page into a reference. The ones it cannot resolve are reported, never guessed.
- **The reference-integrity check (rollout F)** blocks publishing a broken link. The staged-build `links` quality check ([quality-checks.md](./quality-checks.md)) reports a literal link to an old URL as `links/redirect-chain`, or as `links/broken-internal` when no redirect answers it. Fixing it through the write ops stores a reference.

So a literal link that survives the migration keeps working through the move's 301 and is reported until someone points it at the page. It is never rewritten silently.

## Tests

- `packages/shared/src/link-refs.test.ts`, `link-canonicalise.test.ts`: grammar, scanning, resolution, canonicalisation.
- `packages/admin-core/src/__tests__/link-canonicalise-writes.integration.test.ts`: every write surface.
- `packages/admin-core/src/__tests__/link-refs-preview.integration.test.ts`, `apps/static-generator/src/link-refs-build.integration.test.ts`: resolution in preview and the build.
- `apps/static-generator/src/link-refs-moves.integration.test.ts`: after a rename and a nested subtree move, the stored text is unchanged, the 301s exist, and preview and build show the new paths.
- `packages/admin-core/src/__tests__/nested-pages.integration.test.ts`: a move leaves a legacy literal link exactly as written.

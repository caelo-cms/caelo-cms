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

For the AI this means: write internal links as paths, and never update or re-check links after a rename or move. The `move_pages` and `update_pages_many` tool descriptions, the static system prompt and the `manage-redirects` skill (migration 0331) say so.

## Literal links left from before #724

Content written before #724 can still hold literal internal paths, as can content written before #1028 whose only links sat in rich text. A move no longer touches them; the boot migration converts them instead.

### The one-time migration (rollout E)

`links.migrate_to_references` (`packages/admin-core/src/ops/links.ts`) converts literal internal links into references. It reuses the shared canonicaliser in report mode, so there is no second set of link rules. It converts:

- module HTML (layout chrome modules included);
- module field defaults (where layout header/footer content lives);
- content values, read by the module's declared field kinds like the write path (a `text` value `"/month"` stays text);
- structured-set items, submenus included;
- plugin data, through the plugin hook `linkLocationsOperation`. The plugin names the locations; core converts, writes, snapshots and reverts them. The international-site plugin implements it for its chrome variants.

How it runs:

- **At boot, once per install and revision.** `apps/admin/src/hooks.server.ts` calls it with `{ trigger: "boot", onlyIfDue: true }` under an advisory lock, after the plugin host has loaded. Every run records the revision of the conversion it ran (`LINK_MIGRATION_REVISION`, migration 0346); the boot run converts again while no applied run of the current revision exists, unless the Owner reverted the latest run. Revision 2 (#1028) re-converts the rich-text links that content writes stored as literal paths before write-time canonicalisation looked inside rich text when nothing else in the write was a link. A failure is logged loudly and retried at the next start.
- **Dry run and re-run.** A dry run writes nothing and reports what would change. The op is idempotent: a second run over converted content changes nothing and writes no snapshot.
- **One snapshot for main.** Main-line rows are rewritten in place under one site snapshot. Every live chat's pending work is converted against that chat's view of the site by appending pending snapshots owned by the same chat task, so staging an older chat after the upgrade does not bring literal links back.
- **Per-run revert.** `links.revert_migration` restores exactly the parts one run changed (main, chat branches, plugin rows) under its own snapshot. A part edited since the run is a conflict: the revert refuses and names it, or, with `skipConflicts: true`, restores the rest and keeps the edit. `snapshots.revert_site` is not the tool for this: content that predates snapshots has no earlier snapshot state.
- **Who may run it.** Running and reverting are human + system only: they rewrite content on main outside any chat. The AI reads the report and fixes listed links through normal, branched edits.

Where to see the result:

- **Settings → Internal links** (`/settings/links`), for the Owner: the latest run, counts per place, the table of unconverted links, a dry run, convert now, revert (with the keep-edited-parts follow-up), and earlier runs.
- **`get_link_migration_report`** (AI tool, read only, over `links.get_migration_report`): counts per surface and every unconverted link, with where it lives (module, content, menu, plugin row), the field path, the reason, and whether it sits in a chat's unstaged work. The tool tells the AI to fix each link with the normal edit tools.

What it does not convert:

- **A link that matches no page or asset.** It stays exactly as written and appears in the migration report, never guessed.
- **Template and layout HTML.** That is page structure, not a link surface: references resolve only inside modules and sets. The removed text rewriter never touched it either.
- **`page_module_content`.** It is a legacy mirror; renders read content instances.

### Imports: links to pages not built yet

While an import run is active, a link to one of the pages the run has planned is not refused at write time, even though the page does not exist yet. "Planned" means the crawled source path, the requested path, or `/<proposed_slug>`, also as an absolute URL on the source host. Such a link stays literal and is recorded in `import_run_links` with status `pending`. A path the run does not plan is still refused.

The recorded links are converted by `resolve_import_links` (AI tool, over `imports.resolve_links`), which the site-migrate skill calls when the pages are built, and by `imports.cleanup_run` when the run completes. Each recorded link ends up `resolved` (now a reference) or `unresolved`. The unresolved ones appear in `get_import_run_report` (`internalLinks`), and are never guessed.

If a page is renamed or moved while one of its import links is still pending, that literal still converts: the canonicaliser follows one redirect hop, and the move created that 301.

### A literal link that stays literal

A literal internal link that neither the migration nor an import run could convert is listed in the migration report or the import report. After a move it keeps working through the move's 301. The staged-build `links` quality check ([quality-checks.md](./quality-checks.md)) reports it as `links/redirect-chain`, or as `links/broken-internal` when no redirect answers it. Fixing it through any write op stores a reference. It is never rewritten silently.

## Tests

- `packages/shared/src/link-refs.test.ts`, `link-canonicalise.test.ts`: grammar, scanning, resolution, canonicalisation.
- `packages/admin-core/src/__tests__/link-canonicalise-writes.integration.test.ts`: every write surface.
- `packages/admin-core/src/__tests__/nested-link-canonicalise.integration.test.ts` (#1028): rich-text-only values (build_page detached entries, `set_page_module_content`, `set_content_instance_values(_many)` on nested instances) store references and render canonically; the references check flags a stored literal in a nested entry and its fix converts it.
- `packages/admin-core/src/__tests__/link-refs-preview.integration.test.ts`, `apps/static-generator/src/link-refs-build.integration.test.ts`: resolution in preview and the build.
- `apps/static-generator/src/link-refs-moves.integration.test.ts`: after a rename and a nested subtree move, the stored text is unchanged, the 301s exist, and preview and build show the new paths.
- `packages/admin-core/src/__tests__/nested-pages.integration.test.ts`: a move leaves a legacy literal link exactly as written.
- `packages/admin-core/src/__tests__/link-migration.integration.test.ts`, `link-migration-import.integration.test.ts`, `international-site-link-migration.integration.test.ts`: the boot migration (dry run, every surface, branches, idempotence, revision re-run, report, revert) and the import flow.

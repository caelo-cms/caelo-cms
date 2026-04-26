# Phase 3 — Module, Template & Page content model

**Status:** ready to execute.
**Dependencies:** P1 (Query API + RLS), P2 (auth + permissions + audit + CSRF + rate limit).
**Unblocks:** P4 (snapshots — needs the three primitives to snapshot), P5 (AI module edit — needs modules to edit), P6 (static gen — needs pages to render).

## Goal

Implement the three content primitives — **modules**, **templates**, **pages** — through the Query API only, with admin CRUD UI and a server-side preview renderer. No raw HTML may ever land on a page; pages reference modules by id only. No AI yet, no snapshots yet, no Astro static generator yet — that scaffolding waits for P4/P5/P6.

This is the smallest layer that lets a human authoring user assemble a page from modules and see it render. It is intentionally narrow: AI surface and snapshot history bolt on cleanly in P4–P5 because the schema already separates *content storage* (here) from *version history* (there).

## End-to-end verification

1. As an editor, create a `templates/main.html` template with a named `<slot name="content">` block.
2. Create a `modules/hero` module (HTML + CSS + JS).
3. Create a `pages/home` page that references the template and orders `[hero]` into the `content` block.
4. Open `/content/pages/home/preview` — the rendered HTML composes the template, fills the block, injects module CSS into a `<style>` tag, includes module JS as a deferred `<script>`.
5. Attempt `pages.update` with an `html` field via curl/op call → Validator rejects it (`Err('Invalid')`), audit row records the failure with `succeeded=false`.
6. Editor without `content.write` (Reviewer role) is denied on every mutation route, can read everything.

Every step has a Playwright script under `apps/admin/e2e/`.

## Scope decisions

- **Locale on pages from day one.** Requirements §7.5 says pages key on `(slug, locale)`. Adding it later means changing the page PK, breaking every junction table that points at pages. Pay the cost now: `pages.locale` defaults to `'en'` and the unique constraint is `(slug, locale)`. Locale-config CRUD and URL strategy stay deferred to P9 — P3 just stores the column.
- **Translation-status columns deferred to P9.** Requirements §7.5 lists `content_hash`, `last_changed_at`, `translated_from_hash`, `translation_status` on the page row. P3 does **not** add these — they're tightly coupled to the locale config + glossary tables that P9 owns. Adding them stub-shaped now would tempt premature use; we add them in P9 alongside the recompute trigger that gives them meaning.
- **SEO fields belong to P8, not P3.** Requirements §11 calls for per-page, per-locale SEO fields. P3's `pages` table does **not** carry SEO columns. P8 introduces a `page_seo` table joined on `(page_id)` so the SEO surface (fill-once, optimize, structured `<head>`) lands as one coherent migration.
- **Templates use a `<caelo-slot name="…">` custom-element marker, not HTML5 `<slot>`.** Plain `<slot>` is a Shadow-DOM element with non-trivial render semantics — using it here would couple template authoring to Shadow DOM details we don't need. A bespoke `<caelo-slot>` custom element renders inline with no default behaviour, can't collide with anything in light DOM, and is trivially recognised by the compose scanner. Slot names live in a `template_blocks` table so the validator can check that a page's `block_name` actually exists on the template.
- **Live module references, never inlined HTML.** Page-level rendering joins `pages → page_modules → modules` at preview time. Module updates show on the next preview refresh; no caching at this layer (P6 will deal with build-time freezing).
- **No snapshot table writes here.** Mutations go straight to the live tables. P4 introduces the trigger/handler pattern that turns each write into a snapshot row; until then, history is `git log` of the data, which is fine for the manual-only P3 surface.
- **Site-wide content, not per-actor RLS.** Modules/templates/pages are shared site content — every authenticated actor (`human`, `ai`, `system`) sees the same rows. RLS still ENABLE+FORCEd, but the policy is `NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL` (i.e. any session that called `set_config('caelo.actor_kind', ...)`). Anonymous DB connections see nothing. Per-actor scoping returns in P11 plugin tables.
- **Two layers of access enforcement, mirroring the existing pattern.** Routes in `apps/admin/src/routes/content/**` call `requirePermission(locals, 'content.read')` / `'content.write'` from `$lib/server/guards.ts` — same shape as P2's `/security/users` routes. Ops in `packages/admin-core/src/ops/content/**` enforce **`actorScope`**, not permissions: `["human", "system"]` for every op in P3 (AI is intentionally excluded — P5 widens scopes when the AI surface lands). `actorScope` is already enforced by `execute()` in `@caelo/query-api` at line 51. **Ops do not call `requirePermission`** — the route is the Validator boundary for permissions, the op is the Validator boundary for actor kind.
- **Preview rendering is server-side, sandboxed in an iframe.** The admin page hosts the preview inside an `<iframe sandbox="allow-scripts" srcdoc>` so module CSS cannot leak into the admin shell and module JS cannot reach into `parent`. Same isolation principle that P11 will give plugins via Shadow DOM, applied here without needing the Web Component machinery.

## Schema additions

Two file changes following the existing convention:

1. **New schema migration `0005_p3_content_model.sql`** — hand-written, not drizzle-kit-generated. Matches the P2/P2.1/P2.2 pattern (numbered, descriptive name, statement-breakpointed) and keeps the SQL surface auditable as required by CLAUDE.md §2.
2. **RLS inlined into `0005_p3_content_model.sql`** — the migrate runner is keyed by basename and never re-applies a file once its hash is in `__drizzle_migrations`, so appending to the already-applied `9999_rls_policies.sql` would silently no-op. Same pattern P2.2 used for `rate_limit_buckets`. The drift check in `migrate.ts` still asserts every public-schema table has at least one policy after the migration set runs; `9999_rls_policies.sql` keeps the original P1/P2 baseline, new tables ship their RLS in the same migration file that creates them.
3. **Drizzle schema files added** under `packages/migrations/src/schema/cms_admin/{modules,templates,template_blocks,pages,page_modules}.ts` and re-exported from `index.ts`. These are *not* required by the SQL runner (it runs the .sql files directly) but they give downstream code (Query API ops, future drizzle-kit drift checks) typed access to the tables. `bun run db:generate` may flag drift between the hand-written SQL and the schema files — accept those snapshot updates without acting on them, the SQL is canonical.

```
modules
  id              uuid pk
  slug            text not null unique         -- stable identifier; AI uses it in P5
  display_name    text not null
  html            text not null                -- raw HTML body — module layer is the only place raw HTML lives
  css             text not null default ''
  js              text not null default ''
  created_at      timestamptz not null default now()
  updated_at      timestamptz not null default now()
  deleted_at      timestamptz                  -- soft delete, same shape as users (P2.2)

templates
  id              uuid pk
  slug            text not null unique
  display_name    text not null
  html            text not null                -- contains <slot name="..."> markers
  css             text not null default ''
  created_at      timestamptz not null default now()
  updated_at      timestamptz not null default now()
  deleted_at      timestamptz

template_blocks                              -- slot inventory per template
  template_id     uuid not null references templates(id) on delete cascade
  name            text not null               -- matches the <slot name=""> attribute
  display_name    text not null
  position        int not null                -- ordering for the editor UI
  primary key (template_id, name)

pages
  id              uuid pk
  slug            text not null
  locale          text not null default 'en'
  title           text not null
  template_id     uuid not null references templates(id)
  status          text not null default 'draft' check (status in ('draft','published'))
  created_at      timestamptz not null default now()
  updated_at      timestamptz not null default now()
  deleted_at      timestamptz
  unique (slug, locale)

page_modules                                 -- ordered modules per (page, block)
  page_id         uuid not null references pages(id) on delete cascade
  block_name      text not null               -- which template_blocks.name slot
  position        int not null                -- order within the slot
  module_id       uuid not null references modules(id)
  primary key (page_id, block_name, position)
```

Indexes: `pages(slug, locale)` (unique, already), `page_modules(page_id)`, `page_modules(module_id)` (so module-impact queries in P4 are O(rows touched)).

RLS policies (appended to `9999_rls_policies.sql`):

```sql
-- Site-wide content tables: any authenticated Query API caller (human / ai /
-- system) reads + writes; anonymous connections (no caelo.actor_kind set)
-- match no rows. Per-actor scoping returns at P11 for plugin tables.
ALTER TABLE modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE modules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS modules_authenticated_scope ON modules;
CREATE POLICY modules_authenticated_scope ON modules
  USING (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL)
  WITH CHECK (NULLIF(current_setting('caelo.actor_kind', true), '') IS NOT NULL);
-- repeat shape for templates, template_blocks, pages, page_modules
```

`__drizzle_migrations` already has its open policy — no change.

Drift check in `migrate.ts` will fail loudly if any of the five new tables ships without a `pg_policies` row, so the policy block is non-optional.

## Query API ops

All defined in `packages/admin-core/src/ops/content/`. One file per primitive plus a shared helper.

```
ops/content/modules.ts        → modules.list, modules.get, modules.create, modules.update, modules.delete
ops/content/templates.ts      → templates.list, templates.get, templates.create, templates.update, templates.delete
ops/content/template_blocks.ts → template_blocks.set (atomic replace per template)
ops/content/pages.ts          → pages.list, pages.get, pages.get_with_modules, pages.create, pages.update, pages.set_modules, pages.delete
ops/content/preview.ts        → pages.render_preview (read-only, returns composed HTML string)
```

Shared rules:

- Every op declares `actorScope: ["human", "system"]`. AI is deliberately not in scope — P5 will introduce ops that accept the `"ai"` scope, or widen these. The Validator (`execute()` in `@caelo/query-api`) rejects out-of-scope callers before the handler runs, so an AI tool call that tries `modules.update` in P3 fails with `Err('ActorOutOfScope')`.
- Permissions are enforced **at the route layer** via `requirePermission(locals, 'content.read'|'content.write')` from `apps/admin/src/lib/server/guards.ts` — same pattern P2 uses for `/security/users`. Ops do not check permissions; they trust their caller (the route already gated).
- Every mutation calls `recordAudit(tx, { actorId, operation, input, succeeded, entityId, resultSummary })` from P2.2 — `entity_id` is the affected module/template/page id; `result_summary` is e.g. `slug=hero`, `position=0..3`. Sensitive keys never appear in `input` here (no passwords/tokens in content payloads), so the existing redaction helper passes through unchanged.
- Read ops (`*.list`, `*.get`, `*.get_with_modules`, `pages.render_preview`) do not write audit rows — same convention as `users.list` today.
- Soft delete sets `deleted_at = now()`; list ops filter `WHERE deleted_at IS NULL` unless `includeDeleted: true` (Owner-only — UI shows the toggle only when `settings.read` is granted; the op itself accepts the flag from any in-scope caller).
- `pages.set_modules` is atomic: `DELETE FROM page_modules WHERE page_id = $1; INSERT ...` inside one transaction (handlers already run inside a tx) so a partial reorder cannot land.
- `pages.get_with_modules` follows the existing two-query + Map-merge pattern from `users.list` (one query for the page row, one for the modules-by-block, joined in app code) rather than crafting json-aggregating SQL.

### Validator rules (Zod, in `packages/shared/src/content.ts`)

- `slug`: `/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/` — lowercase, hyphenated, no leading/trailing hyphen.
- `locale`: BCP-47 shape `^[a-z]{2}(-[A-Z]{2})?$` (P9 widens this).
- Module `html`/`css`/`js` size caps: 256 KiB / 128 KiB / 256 KiB. Above the cap → `Err('Invalid')` with which field. (Caps are arbitrary but cheap to relax later; large blobs almost always indicate paste-of-binary mistakes.)
- **Page payloads have no `html` field.** Schema is `z.object({ slug, locale?, title, templateId, status? }).strict()` — `.strict()` causes Zod to reject any extra key, so an AI tool call (or a curl) trying to set `html` on a page is rejected at the Validator before the handler runs. This is the §3.1 "no raw HTML on pages" invariant enforced *in code*, with a `raw-html-detector.test.ts` unit test that asserts the rejection.
- `pages.set_modules` payload: `{ pageId, blocks: [{ blockName, moduleIds: [uuid, ...] }, ...] }`. The handler verifies (a) every `blockName` exists on the page's template, (b) every `moduleId` is non-deleted. Both fail with `Err('Invalid')` and a structured `details` field listing the offending values, so the UI can highlight bad inputs.

## Admin UI

New route group `apps/admin/src/routes/content/`:

```
/content                          → index linking to modules / templates / pages
/content/modules                  → list, search by slug, "New module" button
/content/modules/[id]             → editor with HTML / CSS / JS tabs + live preview pane
/content/templates                → list
/content/templates/[id]           → editor with HTML + named-block manager
/content/pages                    → list, filter by locale, status badge
/content/pages/[id]               → composer: pick template → drag modules into blocks
/content/pages/[id]/preview       → full-bleed iframe preview (no admin chrome)
```

Composer UX:

- Left pane: blocks list from the chosen template (`template_blocks` rows in `position` order).
- Right pane: search/list of modules filtered by `deleted_at IS NULL`.
- Drop a module into a block → adds a new `page_modules` row at the next `position`.
- Reorder within a block by drag → emits a single `pages.set_modules` op with the full new ordering.
- "Preview" button opens `/content/pages/[id]/preview` in an iframe panel.
- **No batched "publish" pill in P3** — saving uses plain SvelteKit form actions that commit immediately to the live tables. The pill UX (auto-apply preview, batched diffs, single confirm) belongs to P5 because it's coupled to the AI auto-edit flow; introducing it here without an AI surface would over-promise. P3 has explicit per-form "Save" buttons.

`+layout.server.ts` for `/content/*` calls `requirePermission(locals, 'content.read')`; per-route actions call `requirePermission(locals, 'content.write')`.

CSRF: every form action in the content tree consumes `_csrf` via the existing `assertCsrfToken` helper (P2.1).

## Preview rendering

`pages.render_preview` returns `{ html: string }` for one page id (Zod outputs are objects per the existing `defineOperation` convention; the route handler unwraps the string into a `text/html` response).

Algorithm (in `packages/admin-core/src/preview/compose.ts`):

1. Load page row + its template.
2. Load `template_blocks` for that template (ordered by `position`).
3. Load `page_modules` for the page, joined to `modules`, grouped by `block_name`.
4. Walk the template HTML with a forgiving HTML-aware tokenizer (small hand-rolled scanner — no full HTML parser dep). For each `<caelo-slot name="X">…</caelo-slot>` element, replace its inner HTML with the concatenated module HTML for that block in `position` order. Slots with no modules render empty (the `<caelo-slot>` wrapper itself is preserved so CSS selectors targeting it keep working).
5. Collect every module's CSS into one `<style data-source="modules">…</style>` block injected before `</head>` (template stays the source of truth for `<head>`; we just append).
6. Collect every module's JS into one `<script defer data-source="modules">…</script>` injected before `</body>`.
7. Return the composed string.

The route `/content/pages/[id]/preview` is a SvelteKit endpoint that responds with `text/html` from `pages.render_preview`. The composer page embeds it via `<iframe sandbox="allow-scripts" srcdoc="…">` — `sandbox` blocks form submissions, top navigation, and same-origin escapes; the absence of `allow-same-origin` means module JS cannot read the parent admin DOM. This isolation is *temporary scaffolding* — P11's Shadow-DOM Web Component path replaces it for plugin-rendered surfaces; raw module HTML at the page layer keeps the iframe fence forever.

No template language. No partials. Modules are pure HTML + CSS + JS string concatenation by design — that's the shape AI can safely author against.

## Files added

```
packages/migrations/migrations/cms_admin/0005_p3_content_model.sql
packages/migrations/migrations/cms_admin/0006_p3_content_rls.sql            (or appended to 9999_)
packages/migrations/src/schema/cms_admin/modules.ts
packages/migrations/src/schema/cms_admin/templates.ts
packages/migrations/src/schema/cms_admin/template_blocks.ts
packages/migrations/src/schema/cms_admin/pages.ts
packages/migrations/src/schema/cms_admin/page_modules.ts
packages/migrations/src/schema/cms_admin/index.ts                           (export the new tables)

packages/shared/src/content.ts                                              (Zod schemas)
packages/shared/src/index.ts                                                (re-export)

packages/admin-core/src/ops/content/modules.ts
packages/admin-core/src/ops/content/templates.ts
packages/admin-core/src/ops/content/template_blocks.ts
packages/admin-core/src/ops/content/pages.ts
packages/admin-core/src/ops/content/preview.ts
packages/admin-core/src/preview/compose.ts
packages/admin-core/src/preview/scanner.ts                                  (the slot tokenizer)
packages/admin-core/src/register.ts                                         (register all new ops)

apps/admin/src/routes/content/+layout.server.ts
apps/admin/src/routes/content/+page.svelte
apps/admin/src/routes/content/modules/+page.server.ts
apps/admin/src/routes/content/modules/+page.svelte
apps/admin/src/routes/content/modules/[id]/+page.server.ts
apps/admin/src/routes/content/modules/[id]/+page.svelte
apps/admin/src/routes/content/templates/+page.server.ts
apps/admin/src/routes/content/templates/+page.svelte
apps/admin/src/routes/content/templates/[id]/+page.server.ts
apps/admin/src/routes/content/templates/[id]/+page.svelte
apps/admin/src/routes/content/pages/+page.server.ts
apps/admin/src/routes/content/pages/+page.svelte
apps/admin/src/routes/content/pages/[id]/+page.server.ts
apps/admin/src/routes/content/pages/[id]/+page.svelte
apps/admin/src/routes/content/pages/[id]/preview/+server.ts
```

## Tests (per CLAUDE.md §6 three-tier strategy)

Test file location follows the existing convention: shared colocates `*.test.ts` next to source (e.g. `packages/shared/src/index.test.ts`); admin-core uses a `__tests__/` directory at `packages/admin-core/src/__tests__/`.

**Unit** (no DB):
- `packages/shared/src/content.test.ts` — slug regex accepts/rejects boundary cases; locale regex; size caps; `pages.create` strict mode rejects `html` key (covers the §3.1 invariant *in code*, not just at runtime).
- `packages/admin-core/src/__tests__/preview-scanner.test.ts` — `<caelo-slot>` replacement: missing slot, unknown attribute, nested slot, malformed HTML stays unchanged outside slots; property test of "no slot tags → output equals input".
- `packages/admin-core/src/__tests__/preview-compose.test.ts` — fixture in/out: template + 2 modules → expected composed HTML byte-for-byte.

**Integration** (real Postgres, real adapter — every file lives at `packages/admin-core/src/__tests__/`):
- `content-modules.integration.test.ts` — full CRUD, soft-delete hides from `list`, `includeDeleted: true` reveals; an `actorScope: ["ai"]` execution context is rejected with `ActorOutOfScope` (proves AI cannot reach the content layer until P5 widens scopes).
- `content-templates.integration.test.ts` — CRUD; `template_blocks.set` is atomic (partial failure leaves zero rows changed); a page referencing a deleted template fails `pages.create` with a typed `HandlerError`.
- `content-pages.integration.test.ts` — CRUD; `set_modules` atomic reorder; `set_modules` rejects unknown `block_name` and deleted `module_id` with structured `details`; `(slug, locale)` uniqueness enforced.
- `content-no-raw-html.integration.test.ts` — a `pages.update` payload containing `{ html: "<p>x</p>" }` is rejected by the Zod `.strict()` schema (returns the existing `Err('Invalid')`) before the handler runs; this is the §3.1 invariant under regression test.
- `content-rls.integration.test.ts` — direct SQL connection without `set_config('caelo.actor_kind', ...)` cannot SELECT from any of the five new tables (mirrors the existing pattern from P1's RLS adversarial suite); authenticated callers can.
- `content-preview.integration.test.ts` — end-to-end compose against a seeded template + modules; output contains the module CSS in `<style data-source="modules">`, module JS in `<script defer data-source="modules">`, the `<caelo-slot>` wrapper survives, and the inner content matches the seeded module HTML.

**Playwright E2E** (`apps/admin/e2e/`):
- `content-compose.browser.ts` — login as the dev owner (uses the new `seed:dev` script), create template + module + page through the UI, drop the module into the block, open the preview iframe, assert it contains the module's text.
- `content-raw-html-rejected.browser.ts` — open the page editor, attempt to inject a raw HTML field via the form (POST a tampered field name), confirm a 400-class response and the page's modules list is unchanged.
- `content-reviewer-readonly.browser.ts` — log in as a Reviewer (created via the existing role assignment UI), navigate the content tree, confirm "Save" / "New module" affordances are absent and direct POSTs return 403.

CI block: every E2E flow named in the verification table must have a corresponding `.browser.ts` file or the e2e job fails with a missing-flow error (the existing P2 e2e job structure already supports this — extend the assertion list in `playwright.config.ts`).

## Audit + RLS coverage matrix

| Op | Permission | Audit `entity_id` | RLS surface |
|---|---|---|---|
| modules.create | content.write | new module id | site-wide write |
| modules.update | content.write | module id | site-wide write |
| modules.delete | content.write | module id | site-wide write (soft) |
| templates.* | content.write | template id | site-wide write |
| template_blocks.set | content.write | template id | site-wide write |
| pages.create | content.write | new page id | site-wide write |
| pages.update | content.write | page id | site-wide write |
| pages.set_modules | content.write | page id | site-wide write |
| pages.delete | content.write | page id | site-wide write (soft) |
| any *.list / *.get | content.read | null | site-wide read |
| pages.render_preview | content.read | page id | site-wide read |

## Implementation order

1. Hand-written `0005_p3_content_model.sql` + appended RLS in `9999_rls_policies.sql` + drizzle schema files. Run `bun run db:migrate` against the dev DB; drift check should pass.
2. Zod schemas in `@caelo/shared` (colocated `content.test.ts` for unit coverage). Unit tests green.
3. Query API ops in `packages/admin-core/src/ops/content/*.ts`, registered in `registerAdminOps`. Each op declares `actorScope: ["human", "system"]` and writes audit rows on mutation. Integration tests green against real Postgres.
4. Preview composer (`scanner.ts` + `compose.ts`) under `packages/admin-core/src/preview/`. Unit + integration tests green.
5. Admin routes + composer UI under `apps/admin/src/routes/content/**`. Each `+page.server.ts` calls `requirePermission(locals, ...)` and `assertCsrfToken` on POSTs. `bun run typecheck` clean.
6. Playwright flows (`*.browser.ts`) using the dev-owner seed (`bun run --filter @caelo/admin seed:dev`). `bun run --filter @caelo/admin e2e` green locally.
7. CLAUDE.md update only if a new invariant emerged (none expected — the no-raw-HTML and structured-block invariants are pre-existing in §2).

## Out of scope (explicit)

- Snapshots / version history → P4.
- Chat-keyed Undo/Redo → P4.
- AI module edit, live preview overlay, click-to-chat chips → P5.
- Astro static generator + deploy → P6.
- Media library, image references in modules → P7 (modules can hardcode URLs in the meantime; replaced by media refs later).
- SEO `<head>` fields → P8.
- Multi-locale beyond storing the column → P9.
- Plugin slots inside modules → P11.

## Risks & mitigations

- **Hand-rolled HTML scanner regressions.** Cover with property tests (random HTML strings round-trip unchanged when no slots present).
- **`pages.set_modules` race when two editors save the same page.** Acceptable in P3 (last write wins) — P4's snapshot model + P5's ephemeral chat branches are the real fix; do not paper over it now with optimistic concurrency tokens.
- **Template HTML is raw and unsanitized.** That's intentional — templates are the highest layer of trust beneath modules and only `content.write` actors can touch them. Document in CLAUDE.md §2 that template HTML is admin-trust, never AI-authorable as a raw blob (P5 will gate AI to specific block-level edits).

## Exit criteria

- All unit + integration + E2E tests above pass in CI.
- Manual run of the verification flow above produces a working preview.
- `bun run typecheck` and `bun run lint` clean across the workspace.
- Phase file in `plans/phases/phase_3_content_model.md` updated to mirror this document.
- One commit per logical step (schema, ops, ui, preview, tests) following Conventional Commits.

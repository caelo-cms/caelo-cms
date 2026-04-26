# Phase 4 — Snapshot versioning + revert

**Status:** ready to execute.
**Dependencies:** P3 (content primitives — there has to be something to snapshot).
**Unblocks:** P5 (AI module edits emit snapshots and consume the revert API), P6 (static gen reads from snapshot state when "preview at snapshot N" is requested), P12A (A/B variants ride on the same `module_snapshots` table).

## Goal

Every write through the Query API emits an *atomic* snapshot in the same transaction as the write itself, so the live tables and the snapshot history can never disagree. A `site_snapshots` row groups one or more entity-level snapshots (`module_snapshots`, `template_snapshots`, `page_snapshots`, `page_layout_snapshots`) into a single revertible unit; consecutive snapshots sharing a `chat_task_id` collapse into one timeline entry but remain individually revertible. Per-site and per-module revert ship in an "Advanced History" drawer and are the primary surface in P4; the chat-keyed Undo/Redo wrapper that becomes the editor-facing surface lands in P5 because it requires the chat-session model.

The Module A/B-variant feature (P12A) and ephemeral chat branches (P5) bolt onto the same tables — `module_snapshots` carries optional `experiment_id` + `variant_label`, every snapshot table carries an optional `chat_branch_id`. Both columns are NULL in P4 and only populated by later phases; P4 just gets the schema right so neither feature requires a migration churn later.

## End-to-end verification

1. Edit a module's HTML through `modules.update` → verify `modules` and `module_snapshots` updated atomically; the new snapshot row points at a fresh `site_snapshots` row whose `actor_id` matches the caller.
2. Open the Advanced History drawer for the site → see the new entry with the affected modules + pages listed, severity-grouped.
3. Trigger "Revert this snapshot" → all three live tables (`modules`, `pages`, `page_modules`) are restored to the state at that snapshot, atomically; the revert itself emits a new "revert" snapshot (history is append-only — no destructive rewinds).
4. Trigger "Revert just this module" → only that module's row is restored; the unrelated page edit at the same snapshot is left alone.
5. Re-run with two writes sharing a `chat_task_id` → drawer shows them collapsed into one row that expands to two; reverting the row reverts both atomically.
6. Impact-preview op for a module returns affected pages grouped by severity (`low` / `medium` / `high`).
7. Adversarial test: a handler that writes then throws leaves zero snapshot rows behind (snapshot emission must live inside the same `tx`).

Every step has a Bun integration test; the drawer flow has a Playwright spec.

## Scope decisions

- **Snapshots are a side effect of writes — never an explicit op.** The existing P3 ops (`modules.update`, `templates.update`, `pages.update`, `pages.set_modules`, `template_blocks.set`, soft-delete ops, plus the create ops for completeness) call a single `emitSnapshot(tx, …)` helper at the end of their handler, *inside the same transaction*. The helper inserts the `site_snapshots` row first, then one entity-level snapshot per affected entity. If the write throws, the snapshot rolls back with it — invariant CLAUDE.md §2 "every write emits a snapshot" + the P1.1 rollback-regression idea generalised.
- **Snapshot row stores entity state as JSONB**, not a structural mirror of the live tables. JSONB is flexible enough for templates, modules, and page-layout snapshots (which need to capture the ordered `page_modules` array, not just the `pages` row) without one snapshot table per primitive. Indexed by `(entity_id, site_snapshot_id)`, `(site_snapshot_id)`, `(chat_task_id)` per CMS_REQUIREMENTS §5.
- **One snapshot table per entity kind, not a polymorphic union.** Postgres FKs + RLS get noisy when one table holds rows pointing at four different parents. `module_snapshots`, `template_snapshots`, `page_snapshots`, `page_layout_snapshots` (the last is a separate kind so reordering modules within a page doesn't bloat the page snapshot itself). Each table has the same shape (`site_snapshot_id`, `entity_id`, `state` JSONB, plus the future-feature columns).
- **`chat_task_id` is just a UUID.** P4 does not introduce the chats table — it ships a NULL-for-now `chat_task_id uuid NULL` column on `site_snapshots`. P5 introduces the chats table and starts populating it. The grouping query already works with NULLs (NULL groups don't collapse). Same pattern for `chat_branch_id`.
- **A/B variant columns on `module_snapshots`** added now — `experiment_id uuid NULL`, `variant_label text NULL`. P4 does not write to them; P12A activates the feature. The columns being there now means the Advanced History drawer (and the future Experiments dashboard) can sort/filter on them without a migration.
- **Linear history with append-only reverts.** Reverting a snapshot does not delete later snapshots — it produces a *new* snapshot whose entity states are copied from the target. This keeps the audit trail intact (CLAUDE.md §7 "all writes pass through the audit log") and matches §5.1 "no merge or branch support". The Advanced History drawer surfaces a "this is a revert of #42" badge by reading the new snapshot's `revert_of` column.
- **Per-module revert** restores one entity's state without touching others at the same snapshot. Implemented as `modules.revert_to_snapshot` taking `{ moduleId, snapshotId }`; emits a fresh snapshot containing only that module so the timeline stays accurate.
- **Severity heuristic ships in P4 as a pure function, not a database column.** The function takes `{ moduleId, affectedPages }` and returns `{ severity: 'low'|'medium'|'high', reasons: string[] }`. P4 inputs: count of pages referencing the module + whether the module appears in a templates' header/nav slot (proxy for "above the fold" / cross-template presence) + number of distinct templates. P6 will refine with thumbnailer output; P4 surface is the list-grouped-by-severity, no thumbnails yet.
- **Chat-keyed Undo/Redo wrapper deferred to P5** — the chat-session model is its dependency. P4 ships the underlying primitives (per-site revert, per-module revert, list-snapshots-since-id) so the P5 wrapper is a thin one-route layer.
- **Static-generator hooks reserved but inert.** The plan calls out that P4 generator A/B variant emission needs the snapshot table — P6 is the consumer. P4 just makes sure the column shape works.
- **Schema changes are additive only** — no migration touches existing P3 tables. New tables; the snapshot helper is a new module under `packages/admin-core/src/snapshots/`.

## Schema additions

New migration `0007_p4_snapshots.sql`. Hand-written, RLS inline, follows the P3 + P2.2 pattern.

```
site_snapshots
  id              uuid pk
  actor_id        uuid not null references actors(id)
  description     text not null            -- short human label, e.g. "modules.update slug=hero"
  chat_task_id    uuid null                -- populated in P5; groups consecutive snapshots
  chat_branch_id  uuid null                -- populated in P5 for ephemeral chat branches
  revert_of       uuid null references site_snapshots(id)  -- non-null when this snapshot is itself a revert
  created_at      timestamptz not null default now()

module_snapshots
  id                 uuid pk
  site_snapshot_id   uuid not null references site_snapshots(id) on delete cascade
  module_id          uuid not null references modules(id)
  state              jsonb not null         -- { slug, displayName, html, css, js, deletedAt }
  experiment_id      uuid null              -- P12A
  variant_label      text null              -- P12A ("control", "variant-a", …)
  primary key (id)

template_snapshots
  id                 uuid pk
  site_snapshot_id   uuid not null references site_snapshots(id) on delete cascade
  template_id        uuid not null references templates(id)
  state              jsonb not null         -- { slug, displayName, html, css, blocks: [...], deletedAt }

page_snapshots
  id                 uuid pk
  site_snapshot_id   uuid not null references site_snapshots(id) on delete cascade
  page_id            uuid not null references pages(id)
  state              jsonb not null         -- { slug, locale, title, templateId, status, version, deletedAt }

page_layout_snapshots                       -- separate so reordering doesn't bloat page_snapshots
  id                 uuid pk
  site_snapshot_id   uuid not null references site_snapshots(id) on delete cascade
  page_id            uuid not null references pages(id)
  state              jsonb not null         -- { blocks: [{ blockName, moduleIds: [uuid, ...] }, ...] }
```

Indexes per §5: `module_snapshots(module_id, site_snapshot_id)`, `template_snapshots(template_id, site_snapshot_id)`, `page_snapshots(page_id, site_snapshot_id)`, `page_layout_snapshots(page_id, site_snapshot_id)`, `site_snapshots(chat_task_id)` and `site_snapshots(created_at desc)` for the timeline query.

RLS: site-wide content same shape as P3 (any authenticated actor reads + writes; anonymous SQL connection sees nothing). Inlined in the same migration file.

## Snapshot emission helper

`packages/admin-core/src/snapshots/emit.ts`:

```typescript
interface SnapshotInput {
  readonly actorId: string;
  readonly description: string;
  readonly chatTaskId?: string | null;
  readonly modules?: { moduleId: string; state: ModuleState }[];
  readonly templates?: { templateId: string; state: TemplateState }[];
  readonly pages?: { pageId: string; state: PageState }[];
  readonly pageLayouts?: { pageId: string; state: PageLayoutState }[];
  readonly revertOf?: string | null;
}

export async function emitSnapshot(tx: TransactionRunner, input: SnapshotInput): Promise<{ siteSnapshotId: string }>
```

Each existing P3 mutation op gets a one-line call to `emitSnapshot(tx, …)` after its writes. The helper inserts `site_snapshots` first to obtain the id, then bulk-inserts the entity-level rows. Same `tx` as the original write so rollback semantics are atomic.

## New ops

```
ops/snapshots/list.ts                  → snapshots.list ({ since?, limit?, includeChatBranchId? })
ops/snapshots/get.ts                   → snapshots.get_with_entities ({ snapshotId })
ops/snapshots/impact.ts                → snapshots.module_impact ({ moduleId }) — affected-pages + severity
ops/snapshots/revert_site.ts           → snapshots.revert_site ({ snapshotId })
ops/snapshots/revert_module.ts         → snapshots.revert_module ({ moduleId, snapshotId })
ops/snapshots/revert_template.ts       → snapshots.revert_template ({ templateId, snapshotId })
ops/snapshots/revert_page.ts           → snapshots.revert_page ({ pageId, snapshotId })
```

Same shape rules as P3:
- `actorScope: ["human", "system"]` everywhere; AI gets revert access in P5 (`scoped-edit` etc.).
- Routes enforce `content.write` for revert ops, `content.read` for list/get/impact.
- Every revert op emits its own snapshot (with `revert_of` populated) — append-only history.
- Audit logging via `recordAudit` from P2.2.

## Severity heuristic (`packages/admin-core/src/snapshots/severity.ts`)

```typescript
interface SeverityInput {
  affectedPages: { pageId: string; templateId: string; blockName: string }[];
  templateBlockIsHeader: (templateId: string, blockName: string) => boolean;
}

export function classifySeverity(input: SeverityInput): { severity: "low" | "medium" | "high"; reasons: string[] }
```

Rules in P4 (refined in P6 with thumbnailer signals):
- **High** when `affectedPages.length >= 5` OR the change touches a header/nav slot in any template.
- **Medium** when `affectedPages.length >= 2` OR the change spans 2+ templates.
- **Low** otherwise (single page, footer/body slot).

Pure function; unit-tested with fixtures.

## Admin UI — Advanced History drawer

New routes under `apps/admin/src/routes/content/history/`:

```
/content/history                            → list of site snapshots (timeline)
/content/history/[snapshotId]               → expanded view: affected modules + templates + pages
/content/modules/[id]/history               → per-module timeline (filtered list)
/content/pages/[id]/history                 → per-page timeline (filtered list)
```

UX choices:
- Timeline rows that share a `chat_task_id` collapse into one expandable row labelled with the first description + count. P4 always sees NULL `chat_task_id` so every row is its own group; rendering still works because the NULL grouping is a single-row group.
- Per-row "Revert" button on each entity-level snapshot triggers the matching `snapshots.revert_*` op via a SvelteKit form action (CSRF + permission gates — same as P3).
- Severity badge (low/medium/high) shown on the timeline entry; impact-preview pane lists the affected pages grouped by severity, defaulting to "show high + medium, hide low behind a toggle".
- Confirm modal before any revert because reverts emit a new snapshot — irreversible-ish in the linear history sense (not destructive, but the revert is recorded).

A "Revert" button also lands on the existing `/content/modules/[id]` and `/content/pages/[id]` editors as a small "View history" link in the danger zone — entry point parity with the P3 surface.

## Validator rules (Zod, in `packages/shared/src/snapshots.ts`)

- `snapshots.list` input: `{ since?: ISO timestamp, limit?: 1..200, includeChatBranchId?: uuid }`. P4 surface ignores `includeChatBranchId` (always NULL); P5 wires it.
- All revert op inputs: `{ snapshotId: uuid, ... }` `.strict()`.
- Snapshot state JSONB is *not* validated by Zod at the boundary — it's emitted by trusted ops, never user-supplied. Bringing Zod schemas for each `state` shape would be churn for no security gain (the writer is already typed in TS).

## Files added

```
packages/migrations/migrations/cms_admin/0007_p4_snapshots.sql
packages/migrations/src/schema/cms_admin/site_snapshots.ts
packages/migrations/src/schema/cms_admin/module_snapshots.ts
packages/migrations/src/schema/cms_admin/template_snapshots.ts
packages/migrations/src/schema/cms_admin/page_snapshots.ts
packages/migrations/src/schema/cms_admin/page_layout_snapshots.ts
packages/migrations/src/schema/cms_admin/index.ts                (re-export)

packages/shared/src/snapshots.ts                                 (Zod schemas)
packages/shared/src/index.ts                                     (re-export)

packages/admin-core/src/snapshots/emit.ts                        (the helper)
packages/admin-core/src/snapshots/state.ts                       (typed `state` shapes for each entity kind)
packages/admin-core/src/snapshots/severity.ts                    (pure function)
packages/admin-core/src/ops/snapshots/list.ts
packages/admin-core/src/ops/snapshots/get.ts
packages/admin-core/src/ops/snapshots/impact.ts
packages/admin-core/src/ops/snapshots/revert_site.ts
packages/admin-core/src/ops/snapshots/revert_module.ts
packages/admin-core/src/ops/snapshots/revert_template.ts
packages/admin-core/src/ops/snapshots/revert_page.ts
packages/admin-core/src/register.ts                              (register the new ops)

# wired into existing ops:
packages/admin-core/src/ops/content/modules.ts                   (call emitSnapshot)
packages/admin-core/src/ops/content/templates.ts                 (call emitSnapshot)
packages/admin-core/src/ops/content/pages.ts                     (call emitSnapshot)
packages/admin-core/src/ops/content/template_blocks.ts           (call emitSnapshot)

apps/admin/src/routes/content/history/+layout.server.ts
apps/admin/src/routes/content/history/+page.server.ts
apps/admin/src/routes/content/history/+page.svelte
apps/admin/src/routes/content/history/[snapshotId]/+page.server.ts
apps/admin/src/routes/content/history/[snapshotId]/+page.svelte
apps/admin/src/routes/content/modules/[id]/history/+page.server.ts
apps/admin/src/routes/content/modules/[id]/history/+page.svelte
apps/admin/src/routes/content/pages/[id]/history/+page.server.ts
apps/admin/src/routes/content/pages/[id]/history/+page.svelte
```

## Tests (per CLAUDE.md §6 three-tier strategy)

**Unit** (no DB):
- `packages/shared/src/snapshots.test.ts` — Zod input schemas; `.strict()` rejects unknown keys.
- `packages/admin-core/src/__tests__/snapshots-severity.test.ts` — fixtures for low / medium / high cases.

**Integration** (real Postgres):
- `snapshots-emit.integration.test.ts` — `emitSnapshot` writes site_snapshots + entity rows in one tx; rollback test (handler throws → zero snapshot rows).
- `snapshots-content-writes.integration.test.ts` — every P3 mutation op now also lands a corresponding snapshot row; verify shape of `state` JSONB.
- `snapshots-list-get.integration.test.ts` — list paging, filter by `since`, get expansion to entity-level rows.
- `snapshots-revert-site.integration.test.ts` — full-site revert restores all three live tables atomically; emits a new snapshot with `revert_of` set.
- `snapshots-revert-module.integration.test.ts` — per-module revert touches only the target module; unrelated edits at the same snapshot stay applied.
- `snapshots-revert-page.integration.test.ts` — per-page revert restores `pages` + `page_modules` (ordered) atomically.
- `snapshots-impact.integration.test.ts` — impact op returns affected pages grouped correctly; severity classification matches fixtures.
- `snapshots-rls.integration.test.ts` — anonymous SQL connection sees zero snapshot rows.

**Playwright E2E** (`apps/admin/e2e/`):
- `history-drawer.browser.ts` — login as dev owner, edit a module twice, open `/content/history`, see two entries, click into one, hit "Revert", confirm modal, page reloads with history showing a third entry (the revert) and the module restored.
- `history-impact.browser.ts` — module referenced by 6 pages → impact view marks it `high`; module referenced by 1 page → `low`.

## Audit + RLS coverage matrix

| Op | Permission | Audit `entity_id` | Snapshot emitted? |
|---|---|---|---|
| (existing) modules.* / templates.* / pages.* mutations | content.write | as P3 | yes (one row per affected entity) |
| snapshots.list | content.read | null | no |
| snapshots.get_with_entities | content.read | snapshot id | no |
| snapshots.module_impact | content.read | module id | no |
| snapshots.revert_site | content.write | site_snapshot id | yes (new revert snapshot) |
| snapshots.revert_module | content.write | module id | yes |
| snapshots.revert_template | content.write | template id | yes |
| snapshots.revert_page | content.write | page id | yes |

## Implementation order

1. Migration + drizzle schema files. `bun run db:migrate` green; drift check passes.
2. `packages/admin-core/src/snapshots/{state,emit,severity}.ts` — pure types + helpers, unit-tested.
3. Wire `emitSnapshot` into the four P3 mutation op files. Confirm `snapshots-content-writes.integration.test.ts` green.
4. New `ops/snapshots/*` files; register in `registerAdminOps`. Integration tests for list/get/impact + the four revert paths.
5. Admin routes under `/content/history/**` + entry-point links from existing module/page editors. Typecheck + lint clean.
6. Playwright flows. Full `bun run e2e` green.
7. CLAUDE.md update only if a new invariant emerges (none expected — "every write emits a snapshot" is already in §2; we're just operationalising it).

## Out of scope (explicit)

- Chat-keyed Undo/Redo editor surface → P5.
- Visual thumbnails on impact preview → P6 (renderer needed).
- AI-driven revert via `scoped-edit` skill → P5/P10A.
- Module A/B variant *behaviour* (winner promotion, traffic split, dashboard) → P12A. P4 only ships the schema columns.
- Ephemeral chat branches *behaviour* (per-chat preview branch isolation) → P5. P4 only ships the schema column.
- Cross-snapshot media references → P7 (media table doesn't exist yet; module HTML can reference media URLs as plain strings in the meantime).

## Risks & mitigations

- **Snapshot table size.** Every content write doubles the row count (live + snapshot). Mitigation: indexes per §5; if growth becomes a real problem in self-hosted installs, P12A's archival policy (rotate snapshots older than 90 days into a cold table) is the natural follow-up. Don't pre-optimise here.
- **JSONB schema drift.** `state` payload format must stay backwards-compatible — old snapshots need to revert against the new schema. Mitigation: typed `state` interfaces in `snapshots/state.ts` carry a `schema_version` field; revert ops walk the version-shape map. P4 only has version 1.
- **Snapshot emission inside the write tx adds latency.** Each mutation now does one extra INSERT into site_snapshots + N INSERTs into the per-entity table. Acceptable for the editing surface; if it bites under deploy-time bulk import (P14 site import), batch the inserts.
- **Revert under concurrent writes.** Two editors clicking "Revert" on the same snapshot at once should produce two new revert snapshots (additive history is fine), but the live tables must end up at the right state. The optimistic-concurrency token from P3 follow-up #1 covers per-page conflicts; module-level conflicts are rare enough that P4 accepts last-write-wins, with the revert audit trail as the safety net.

## Exit criteria

- All unit + integration + E2E tests above pass in CI.
- Manual run of the verification flow above produces a working drawer + revert.
- `bun run typecheck`, `bun run lint`, `bun run license:check` clean.
- Phase file in `plans/phases/phase_4_snapshots.md` updated to mirror this document.
- One commit per logical step (schema + helper, op wiring, snapshot ops, UI, e2e) following Conventional Commits.

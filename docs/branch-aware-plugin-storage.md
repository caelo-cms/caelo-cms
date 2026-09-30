# Branch-aware plugin storage — design

**Status:** accepted (2026-09-30). Implements CMS_REQUIREMENTS §14.7 ("writes never go straight to live") and closes the §14.13 items about live plugin writes and host-issued SQL.

## Problem

CMS_REQUIREMENTS §14.7 requires that no plugin writes the live state of `cms_admin` directly: authoring writes — to core data and to the plugin's own private storage — go through named operations that validate, audit and snapshot, and a write that originates in a chat lands on that chat's branch, is undoable with it, and reaches live only on publish.

Today none of that holds for plugins:

- **No invocation context reaches a plugin.** `runPluginOperation` and `makePluginContext` carry no caller actor, `chatBranchId` or `chatTaskId`. Chat tool calls, approval-gated tools, Power-MCP, workers, render hooks and the Owner panel all invoke plugins as the plugin's own actor, with no branch.
- **Private storage writes live, with SQL issued by the host.** `ctx.adminQuery` (`makeScopedQuery`, `plugin-host/src/capabilities.ts`) opens its own transaction per call and issues `INSERT`/`UPDATE`/hard `DELETE` directly — no audit, no snapshot, no lock, no branch.
- **Core writes by plugins go live too.** `ctx.cms.call` runs core operations with a branch-less plugin context, so e.g. `international-site`'s `translate_variant` (`page_module_content.set`, `pages.update`) and `create_variant` (`pages.duplicate`) change the live site from inside an unpublished chat, and plugin reads cannot see branch-created pages or modules.
- **Render-time plugin reads see no branch.** Preview passes a branch for core reads, but not to data lists, deferrals, head contributions, build assets or URL annotations.

Only `consent-manager` and `international-site` use private storage today; `comments` uses `ctx.cms` for its archive. The fix is still general: it defines the storage and write path every plugin gets.

## Design

### 1. Invocation context, plumbed everywhere

`runPluginOperation` gains a required `invocation`:

```ts
interface PluginInvocation {
  readonly origin: "chat" | "owner-panel" | "worker" | "render" | "visitor";
  readonly actorId: string;          // who acts: AI actor, Owner, system, visitor
  readonly operatorActorId?: string; // the human the chat belongs to
  readonly chatBranchId?: string;    // set for origin "chat" (and chat previews)
  readonly chatTaskId?: string;
}
```

Every dispatch site fills it: chat tool dispatch and gated tools (from `aiCtxWithBranch`), Power-MCP (already computes the branch and currently drops it), the Owner panel routes (the Owner's identity instead of the plugin actor), workers (`origin: "worker"`, no branch), render hooks (`origin: "render"`, the preview's branch or none for the static generator), and the gateway (`origin: "visitor"`). `ctx.invocation` is exposed read-only to the plugin.

### 2. Named operations instead of host SQL

Plugin storage becomes a core Query API operation family, executed with the invocation's context — so it inherits Validator, audit, snapshots, locks and branch handling like every other write:

| Operation | Purpose |
|---|---|
| `plugin_storage.list` / `plugin_storage.get` | Read rows of one declared table (equality filters, order, limit) |
| `plugin_storage.insert` / `update` / `delete` | Single-row writes |
| `plugin_storage.write_many` | A batch of inserts/updates/deletes in one transaction |

- **Two zones, one family.** `zone: "private"` (the plugin's `cms_admin` schema) and `zone: "public"` (`cms_public.<slug>`). `ctx.adminQuery` and `ctx.query` keep their SDK shape and become thin brokers over these operations; the host no longer issues SQL for plugins (§14.7).
- **Scoping is enforced twice:** the operation rejects tables not declared by the calling plugin, and RLS on `caelo.plugin_id` stays the backstop.
- **`ctx.cms.call` inherits the invocation's branch and task**, so core writes a plugin makes from a chat are branched, locked and snapshotted like the AI's own, and its core reads see branch state. Audit records the plugin and the operator it acted for.

### 3. Branch model for plugin rows — the core overlay pattern, generalised

The provisioner adds four host-owned columns to every private-zone table (plugins cannot declare or write them):

| Column | Meaning |
|---|---|
| `caelo_chat_branch_id uuid NULL` | Set on a row created on a branch; `NULL` = main |
| `caelo_deleted_at timestamptz NULL` | Soft delete; replaces the hard `DELETE` |
| `caelo_version int NOT NULL DEFAULT 1` | Optimistic version, bumped on every main write |
| `caelo_updated_at timestamptz NOT NULL DEFAULT now()` | Last write |

Writes follow the pattern `content_instances` and `modules` already use:

- **Branched insert:** the live row is inserted with `caelo_chat_branch_id = branch` — invisible to main and to other chats.
- **Branched update / delete:** the live row is **not** touched; the full new row state (or a tombstone) goes into a new snapshot table, `plugin_row_snapshots(site_snapshot_id, plugin_id, table_name, row_id, state jsonb)`, tagged with the branch through `site_snapshots`.
- **Reads in branch context** return main rows plus this branch's own rows, overlaid with the latest branch snapshot per row. **Main reads** return `caelo_chat_branch_id IS NULL AND caelo_deleted_at IS NULL`.
- **Without a branch** (Owner panel, worker, §11.A-approved execution) writes go to main, still through the operations — so they are audited and snapshotted.
- **Visitor writes** are allowed only in the public zone and stay live; the operation rejects a visitor-origin private write.

### 4. Publish, stage, undo, locks

- **Publish / Stage:** `mergeBranchSnapshotsToMain` gains a `pluginRow` kind: latest branch state per row is applied to the live row (update, or soft delete for a tombstone), and branch-created rows get `caelo_chat_branch_id = NULL`. Plugin rows referencing core rows (`ref:pages`, `ref:modules`) are applied after the core entities they point at. `list_pending_changes`, `branch_change_count`, the stage picker and `branch_edited_entities` list plugin rows, grouped by plugin.
- **Locks:** a `pluginRow` lock kind keyed by `(plugin, table, row)` — two unmerged chats cannot diverge on the same row (merge is last-writer-wins, as for core).
- **Undo before publish** is discarding the chat's branch state: nothing live changed. There is no branch-discard operation in core today (`chat.archive_session` only hides the chat); this design adds `chat.discard_branch` for all branch-tagged state — core rows and plugin rows alike — so "undo the chat" is exact rather than the approximate site revert.
- **Undo after publish** uses the main snapshots written at merge time.
- **Enums and lists to extend:** the `site_snapshots.op_kind`, `chat_branch_publish_marks.entity_kind` and `chat_entity_locks.entity_kind` CHECKs; the `SnapshotEntity`, `LockedEntityKind` and stage-picker unions; the kind lists in the merge loop, pending-changes and change-count queries.

### 5. Render-time reads

Data lists, deferrals, head contributions, build assets and URL annotations receive the render's invocation: the preview's branch in the admin preview, none in the static generator. A branch preview therefore renders plugin state exactly as it will look after publish, and the deployed site renders main only. `buildAssets` output is computed per preview branch; the deployed bytes come from main.

### 6. Plugin-side changes

- **No authoring writes outside authoring contexts.** Lazy seeding on first read (consent-manager's `settingsOf` / `categoriesOf`, reachable from visitor and render paths) moves to an `onActivate` hook, which runs once as the activating Owner, on main.
- **Reads never write.** `list_embeds` stops running `syncGuards`; it reads guards plus a live scan of the requested modules (the same `moduleHosts` judgement as the gate) without persisting.
- **Workers stay on main** by design. consent-manager's scan and international-site's staleness tick keep operating on published state; the staleness tick already ignores branch events.
- **Process-global caches** (international-site's `localeCache`) are main-only and are not consulted for branch reads.

## Rollout

Each step is its own PR, green on its own:

1. **Invocation context** through every dispatch site; `ctx.invocation`; `ctx.cms.call` inherits branch and task.
2. **`plugin_storage.*` operations**; `ctx.adminQuery` and `ctx.query` become brokers over them; host-owned columns added by the provisioner; soft delete. Behaviour on main unchanged.
3. **Branch semantics:** branched insert/update/delete, overlay reads, `plugin_row_snapshots`, locks, merge, stage and pending-change listings, `chat.discard_branch`.
4. **Render hooks** receive the preview branch.
5. **Plugin conversions:** consent-manager (seeding to `onActivate`, read-only `list_embeds`) and international-site (branch-aware reads, cache main-only).
6. Then **#478** rebases onto this: external plugins get private storage and tools through the same path; approval bindings are consumed once.

## Decisions (2026-09-30)

1. Owner-panel and worker writes go to main, audited and snapshotted, as core panel edits do today.
2. §11.A-approved plugin actions execute on main at approval, as the propose/execute engine does today.
3. `chat.discard_branch` covers all branch-tagged state — core entities and plugin rows alike.

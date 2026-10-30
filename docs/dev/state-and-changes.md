# State and changes: one change journal

Where state is written in Caelo, what is derived from it, and how a change reaches everything that depends on it (issue #1267). CLAUDE.md §2 points here; a change that writes, derives or reacts to state follows this page.

Before #1267, seven mechanisms told consumers "what changed": the `domain_events` outbox, the `font_usage_changes` xid log, the `site_view_generation` counter, an in-process module-change push, op-name live topics delivered within one process, the public-projection outbox and plugin-data dirty marks. None was general, so request paths recomputed from the whole site or the whole history on every read. There is now one mechanism for "what changed": the **entity change journal**.

## 1. Source of truth

Entity tables and snapshots in `cms_admin`, plugin storage rows and row snapshots. Only named write operations change them (CLAUDE.md §2: no raw SQL). Unchanged by #1267.

## 2. The change journal (`entity_changes`, migration 0430)

**A row** is one changed row of a journaled table per transaction, keyed `(xid, table_name, row_id)`:

| column | meaning |
|---|---|
| `xid` | the writing transaction (`xid8`) |
| `table_name` | the physical table (`plugin_<slug>.<table>` for plugin storage) |
| `row_id` | the entity id (`*` for a truncate) |
| `kind` | the entity kind (`page`, `module`, `list`, … — `JOURNAL_KINDS`) |
| `op` | `insert`, `update`, `delete` or `truncate` |
| `changed_columns` | the columns an update changed; `NULL` = every column |
| `parent_id` | the entity it belongs to, when the kind has one (a placement's page, an instance's module, a plugin row's table) |
| `plugin_id` | the owning plugin, for plugin storage and plugin row snapshots |
| `chat_branch_id` | the branch the change is on AFTER the change; `NULL` = main (a live write) |
| `owner_chat_session_id` | the chat that owns the change (a subagent's parent), resolved once at write time |
| `site_snapshot_id`, `prev_snapshot_id` | for snapshot tables: the snapshot this state was recorded in, and the one it replaced (diff the two) |
| `op_name` | the Query API operation that wrote it; `NULL` for a migration or a psql session |
| `created_at` | when the row was written |

**Who writes it.** A generic statement-level trigger (`caelo_journal_rows`, transition tables) on every journaled table, attached by `caelo_journal_attach(...)` in the migration that creates or registers the table. This is an explicit architecture decision, not hidden logic: the snapshot emitter is *not* a complete chokepoint (child snapshots are inserted outside it; Stage, undo and takeover are UPDATEs that re-point rows; media, settings, plugins, grants and redirects change without a snapshot), while a trigger on a registered table set counts an op, a Stage, an undo, a migration and a psql session alike — the reason migration 0394 used triggers too.

- Set-based: one INSERT per statement, however many rows it changed.
- Different transactions insert different keys, so writers never wait on each other through the journal. A second statement of the *same* transaction on the same row merges into its row (`ON CONFLICT DO UPDATE`, limited by RLS to the transaction's own rows): changed columns are unioned; a truncate or delete wins; otherwise the first statement's op stays, so an entity created in the transaction stays an insert and an existing row touched again stays an update.
- A rolled-back write leaves no row. An UPDATE that changed nothing, or only `updated_at`, leaves none either — so no consumer ever reacts to a write that changed nothing.
- `prev_snapshot_id` of an inserted snapshot is the newest earlier snapshot of the same entity pending on the same branch, else the newest of the main line (a live snapshot, or a branch snapshot a Stage landed), not undone: a first draft edit diffs against what main shows. It is found by walking the entity's `(key, created_at DESC)` index from the newest snapshot down: O(log k) for an entity with k snapshots.
- Live entity rows carry no snapshot id: handlers write the live row before they emit its snapshot. The snapshot row of the same transaction (same `xid`, `kind`, `row_id`) carries it.

**Attribution.** The Query API's `execute()` sets transaction-local settings alongside the actor (`packages/query-api/src/adapter.ts`, `#setIdentity`): `caelo.chat_branch_id`, `caelo.chat_task_id` and `caelo.op_name`. The trigger resolves the owner chat with `caelo_chat_owner`. For snapshot tables, branch, chat and snapshot id come from the snapshot's own `site_snapshots` header, so they are exact on every path, including writes outside an op.

**The registered table set.** `packages/shared/src/change-journal.ts` lists every `cms_admin` table: journaled (`JOURNALED_TABLES`, with the exact trigger arguments) or exempt with a written reason (`JOURNAL_EXEMPT_TABLES`). `packages/migrations/src/change-journal-registry.integration.test.ts` fails on a table that is neither, on a registry entry whose triggers do not match, and on a plugin storage table without its trigger. Adding a table: decide which it is, then either attach the trigger in its migration (`SELECT caelo_journal_attach('t', 'kind', 'key', 'row', 'id', …)`) and add the entry, or add the exemption with its reason.

**Kinds are a registry.** A new core domain adds its kind to `JOURNAL_KINDS`. Plugin storage needs no journal migration: the host attaches the trigger whenever it provisions a plugin's `cms_admin` schema (`caelo_journal_attach_plugin_schema`), under the kind `plugin_storage`, keyed on the plugin's **id**, never on its reusable slug.

**Out of scope: `cms_public`.** It is a separate database with its own xid space. Derived state on visitor writes (a ratings aggregate) is maintained inside the `publicOperation` that writes it.

## 3. Derived state: two kinds, both rebuildable

- **Synchronous** — maintained in the same transaction by registered statement-level triggers on journaled tables. Only where a hot read must be exact at commit (first user: the draft head of #1268). Never hand-written into individual ops.
- **Asynchronous** — consumers with a cursor over the journal: in-memory caches, plugin reactions, background scans, the projection, the live fan-out.

Every derived structure ships a rebuild-from-source operation, a consistency test "maintained == rebuilt" over the integration fixtures, and a backfill in its migration. Changing a derived shape later is a new rebuild and a migration; source data is never lost. Forbidden: TTL caches, and "recompute if missing" (CLAUDE.md §2, no fallbacks) — drift fails loudly.

The derived structures on the journal today:

| structure | kind | reads | rebuild |
|---|---|---|---|
| site view cache (`packages/admin-core/src/site-view.ts`) | in-memory, per branch | `checkJournalMark` per render | re-read on a stale mark; `preview-site-view-cache.integration.test.ts` |
| font usage cache (`apps/static-generator/src/font-usage-sources.ts`) | in-memory | `checkJournalMark` per scan | re-scan on a stale mark; `font-reads.integration.test.ts` |
| consent-manager embed verdicts | plugin consumer, every branch | `changeConsumer` | `scan_modules` |
| international-site translation staleness | plugin consumer, main line | `changeConsumer` | `rebuild_translation_staleness` |
| the editor's `draft` live topic | in-memory cursor per instance | `readChanges` | a cursor behind the horizon publishes `draft` once and restarts at "now" |

## 4. Cursor semantics

A cursor is a `pg_current_snapshot()` taken in the same statement as the read (READ COMMITTED takes a new snapshot per statement). Delivered are the rows visible now and not visible in the cursor. So a transaction that started before the last read and committed after it is delivered on the next read — never skipped. That is a regression test (`change-journal.integration.test.ts`): the retired `id > cursor` read of `ctx.events.poll` skipped it, because ids are handed out in start order, not commit order.

- **Paged reads** pin their target snapshot (`change_consumers.page_target` plus the last delivered key), so rows committing between pages are left for the next round instead of being marked seen without delivery.
- **Long transactions.** A long transaction (a build) holds the oldest running xid back; every read re-scans the journal above the cursor's xmin. The cost is the journal rows written during that transaction, through the primary-key index.
- **Retention and the horizon.** `change_journal.collect_garbage` (the maintenance worker, hourly, up to a million rows a pass) deletes rows past the retention window (24 hours — consumers run within seconds of a write, and the journal of a busy site is millions of rows a day) that belong to finished transactions, never waiting on a lock, and records the newest deleted xid as a horizon (`entity_change_horizons`). The horizon never passes the cursor of a live persisted consumer: rows at or above the lowest such cursor's xmin stay, so a consumer that was idle past the window (a quiet weekend on request-billed CPU, where no instance runs it) reads on where it stopped instead of rebuilding. A consumer whose oldest undelivered row is older than a week (`JOURNAL_STALLED_CONSUMER_MS`) is stalled — a plugin failing every batch, recorded loudly (#1008) — and holds nothing back; a deactivated plugin's consumers are dropped. A cursor whose xmin is at or below a horizon may have lost rows: the read reports `needsRebuild`, the consumer runs its rebuild and resets its cursor.
- **Rebuilds never lose a change.** A consumer created now, or behind the horizon, is marked `rebuild_pending` with its cursor taken BEFORE the rebuild reads its source; the flag clears only after the rebuild succeeded. A change committed during the rebuild is delivered after it, and a rebuild that failed or was interrupted runs again on the next run.
- **A deactivated plugin's cursors are dropped** (a trigger on `plugins.status`), and a later activation starts from its rebuild.
- **A rebuild is exact, never a blanket flag.** It recomputes the derived state from source: consent-manager rescans the modules; international-site compares each up-to-date variant's `source_hash` (the fingerprint of its source page's translatable content when the variant became up to date) with the source's content now and flags only the ones that differ. The incremental path decides the same way, so a change delivered after the translation it preceded flags nothing. Variants translated before #1267 get their hash from a backfill (rule 3): the plugin's `onActivate` gives every up-to-date variant without one its source's current fingerprint, once, and only while the plugin's cursor is continuous (`plugin_changes.cursor_state`), so every change since is still delivered; such a backfilled hash (`backfill:` prefix) is flagged by any change to its source, because the backfill cannot tell whether a change just before it was delivered yet, while a rebuild compares its fingerprint. Variants already `needs_update` stay as they are. Outbox work still outstanding at the upgrade (events past the plugin's `plugin_event_cursors` position) cannot be replayed by the journal: 0430 marks the siblings of sources with such a `page.updated` / `page.published` `needs_update` before it seeds the cursor (`caelo_intl_reconcile_retired_outbox`), and the backfill re-derives chrome and list statuses from their stored hashes, so no edited source becomes a baseline. A source page that is deleted (a soft delete keeps the variant linkage) is no basis for comparison: its variants stay as they are, in the tick and the rebuild, and the rest of the batch goes on.
- **One instance per consumer.** Each persisted consumer runs once per site at a time through a claim on its `change_consumers` row (`claimConsumer`: `FOR UPDATE SKIP LOCKED`, never waits; it expires on the database clock so a dead instance's consumer is taken over). The host renews it every third of its lease while a dispatch or a rebuild runs, and every state update is fenced on it (`commitChanges` / `finishConsumerRebuild` with the holder refuse once the claim lapsed or was taken over), so a run that outlived its claim changes nothing and its batch is delivered again. #1255 reuses this claim for "workers once per site".
- **Fair, and complete without another write.** One drain gives each consumer at most 40 batches of 500 before the next consumer's turn; a consumer that ran out of that budget with changes left (`DrainReport.more`) is drained again right after the round, so a burst larger than the budget is delivered without waiting for an unrelated write.

API: `packages/query-api/src/change-journal.ts` — `checkJournalMark` (in-memory caches), `readChanges` (in-memory cursors), `registerConsumer` / `pollChanges` / `commitChanges` / `beginConsumerRebuild` / `finishConsumerRebuild` / `claimConsumer` / `releaseConsumer` (persisted consumers), `collectJournalGarbage`. Plugins reach the persisted-consumer functions only through the host's named `plugin_changes.*` operations (`packages/plugin-host/src/change-consumers.ts`).

## 5. Cross-instance wake-up

The journal trigger NOTIFYs `caelo_entity_changes` (empty payload, so one notification per transaction). A notification is only a wake-up: the cursor is the truth, and a reader woken late or twice reads exactly what it has not seen. Its cost: Postgres serialises the commits of notifying transactions on its notification queue for the instant of the commit — microseconds per write, not the whole transaction, and nothing waits on a row.

- **LISTEN** runs on one dedicated connection per adapter and database, outside the pools (`DatabaseAdapter.listen`, `LISTEN_CONNECTIONS_PER_INSTANCE = 1`); #1254's pool budget counts it. Bun's `sql.listen` reconnects with backoff and re-subscribes; every listener re-reads on re-subscription, because notifications sent while the connection was down are lost.
- The spike behind this (Bun 1.4.4): a NOTIFY inside a transaction is delivered on commit and never on rollback; a killed LISTEN backend is re-subscribed within ~250 ms.
- The API gateway's caches of published state (settings, staging gate, rate-limit specs, the consent rule) are now served only while its LISTEN on the admin's publish notifications is acknowledged, and dropped on every notification and reconnect. Its former LISTEN never received anything and a 5 s TTL hid it; the TTL is gone (`apps/api-gateway/src/published-changes.ts`).
- **Request-billed CPU (`cpuIdle`).** A wake-up reaches an instance while it serves requests — which is when an editor's stream or wait is open there. Asynchronous consumers that must run without any request run as scheduler-tick jobs (#1140), not on an idle instance.
- **Providers.** NOTIFY / LISTEN needs a direct Postgres session. A pooler in transaction mode (PgBouncer `pool_mode = transaction`, some managed "pooled" endpoints) drops LISTEN: point `ADMIN_DATABASE_URL` / `PUBLIC_DATABASE_URL` at the direct endpoint. Google Cloud SQL (private IP, as provisioned), RDS and Azure flexible server connect directly as Caelo provisions them; self-hosted Postgres in Docker too.

## 6. Live topics

- **Operational topics** — `agents`, `pending`, `credentials`, `quality`, `crawl`, `deploys` — stay classified by operation name (`liveTopicsOfOperation`). They now cross instances: the committing transaction NOTIFYs `caelo_live_topics` with `<instance>|<topics>` (`setCommitNotice`, sent inside the transaction, so only on commit), and every instance's fan-out publishes another instance's topics locally (`startLiveFanOut`, `packages/admin-core/src/live-events.ts`). A reconnect publishes every topic once.
- **Entity-derived topics** come from the journal: `draft` fires on every instance when a committed write changed a journaled row, whoever made it (a chat, an MCP agent, a Stage, a settings change) — never for a write that changed nothing. Server-side consumers hear the rows themselves through `subscribeEntityChanges` (#1270's preview invalidation); a tab hears only the topic. The changes pill (#1268) and the preview (#1270) register on it.

## 7. Request-scoped computation

Every operation declares `readScope: "request" | "site"` (`packages/query-api/src/operation.ts`).

- `"request"`: one call reads what the request names (a page, its references, a page of a list), never the whole site.
- `"site"`: the operation's purpose is the whole site — the Stage build, a whole-site link check, an export, a rebuild op, garbage collection. It needs a `// Why site-wide: <reason>` comment right above the declaration; `scripts/op-read-scope.test.ts` fails without it.
- **No unbounded parameter lists.** `scripts/no-unbounded-bind-lists.test.ts` fails on an `IN (${sql.join(…)})` (or `ANY` / `ARRAY[…]`) built from a list: one bind parameter per element, which breaks Postgres's 65,535 limit on a large Stage. Bind one array: `= ANY(${uuidArray(ids)})` / `<> ALL(${textArray(values)})` from `@caelo-cms/query-api`. A list a schema provably bounds may stay with `// caelo:bounded-list <reason>`.
- **The rows-read test** (`packages/admin-core/src/__tests__/rows-read.integration.test.ts`, PR CI job `rows-read`) runs each op of its inputs registry (`rows-read/inputs.ts`) on a small fixture and on the same fixture grown 10x along every history dimension, and reads per call — with `pg_stat_statements` reset right before — the statements, the rows they returned and the buffers they touched. An op fails when the large run issues a different number of statements or returns or touches more than 1.5x (plus a few buffers per statement for a deeper B-tree). Not-yet-compliant ops are on its allowlist, each `FIXME(#1268|#1269|#1270)`; the test fails when an allowlisted op complies, so the list only shrinks to empty. A new request op that sits on a hot path adds its entry to the registry.
- **The scale gate** (`docs/dev/scale-gate.md`): 50,000 pages, 20 MCP agents, 5 editors on db-f1-micro and a 1-vCPU admin, nightly and on the `perf-gate` label.

## 8. Plugins follow the same contract

- **Reading changes.** A plugin declares `changeConsumer` (kinds, own tables, `lines: "main" | "all"`, an operation per batch and a rebuild operation) and requests `change_journal`. Every core kind needs its read grant of core data (`cms_admin`), checked at registration; its own storage needs none; another plugin's rows are never delivered (the filter is keyed on the plugin's id). The host runs the consumer once per site at a time, woken by the journal, and dispatches each batch per branch in that branch's scope, so the plugin's own writes land where the change is. It commits the cursor only after every dispatch of the batch succeeded (at least once). This replaces `domain_events` / `ctx.events.poll` and `moduleChangesOperation`.
- **Approval.** A shipped plugin whose release asks for a capability the Owner has not approved for it does not run until the Owner approves it: on the upgrade that introduced `change_journal`, the Owner re-approves international-site and consent-manager (`plugins.approved_capabilities`, migration 0431; Settings → Plugins → Approve new permissions; Settings → Updates says so). Until then they stay active but do not run — in the admin host and in the API gateway, which reads the approved set from the published registry (cms_public `published_plugins.approved_capabilities`, migration 0432) and attaches no release-signed plugin whose shipped definition asks for more. This gate is added on top of what shipped plugins had: it is not the per-artifact-digest grant of runtime-installed plugins (`plugin_capability_grants`, which it does not touch), so a release that changes a shipped plugin's code without changing its capabilities still runs without a click — the gap CMS_REQUIREMENTS §14 lists under shipped plugins.
- **What plugins receive and may write.** Render hooks receive the page's reference set from core (#1270). Plugin caches follow rule 3. A plugin never writes core derived state.

## Expand / contract

This release stops reading `site_view_generation` and `font_usage_changes`, stops writing `domain_events` (the ops no longer insert), and removes `moduleChangesOperation`. The writer triggers of `site_view_generation` and `font_usage_changes` stay for one release: the previous admin image serves during the roll and again after a failed rollout's rollback, and its caches validate only through them (so the `site_view_generation` singleton bump is still paid on every write until then). The journal's GC trims `font_usage_changes` meanwhile, with the previous image's horizon rule. Migration 0442, in the next release, drops the triggers and all three tables, marked `caelo:requires-earlier-run 0430_entity_change_journal.sql` (`packages/migrations/src/run-order.ts`).

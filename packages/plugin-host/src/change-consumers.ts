// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — plugins react to the change journal
 * (docs/dev/state-and-changes.md, rule 8).
 *
 * A plugin declares `changeConsumer` (kinds, own tables, main or every
 * branch, an operation per batch and a rebuild operation). The host runs
 * each declared consumer once per site at a time (the journal's
 * single-instance claim): woken by the journal's NOTIFY on any instance,
 * it polls the plugin's cursor, dispatches the batch to the plugin's
 * operation — per branch, in that branch's scope, so the plugin's own
 * writes land where the change is — and commits the cursor only after
 * every dispatch of the batch succeeded (at least once). A cursor below
 * the journal's GC horizon, or a consumer seen for the first time, runs
 * the rebuild operation instead.
 *
 * It replaces the domain-event outbox (`ctx.events`) and the in-process
 * module-change push (#1214): that push ran in the committing process
 * after commit and was lost when the instance died; the cursor is not.
 *
 * Gating (§2, one plugin model): every core kind needs the plugin's read
 * grant of core data (`cms_admin`), checked when the plugin registers;
 * its own storage needs none and another plugin's is never delivered (the
 * filter is keyed on the plugin's id). All database access goes through
 * the named `plugin_changes.*` operations below — the host brokers no SQL.
 */

import type { PluginChange, PluginChangeKind, PluginInvocation } from "@caelo-cms/plugin-sdk";
import {
  type ChangeBatch,
  claimConsumer,
  commitChanges,
  type DatabaseAdapter,
  defineOperation,
  execute,
  type JournalChange,
  type JournalFilter,
  type ListenHandle,
  type OperationDefinition,
  type OperationRegistry,
  pollChanges,
  registerConsumer,
  releaseConsumer,
  resetConsumer,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err, JOURNAL_CHANNEL, ok } from "@caelo-cms/shared";
import { z } from "zod";
import {
  hostSystemActorId,
  isPluginDisabled,
  type LoadedPlugin,
  loadedPlugins,
  runPluginOperation,
} from "./dispatch.js";
import { hostInstanceId } from "./runtime-health.js";

/** The consumer name of a plugin: keyed on its id, never its reusable slug. */
export function changeConsumerName(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/** Changes one dispatch carries at most. */
const BATCH = 500;
/** Batches one drain of one consumer runs at most before yielding to the next wake-up. */
const MAX_BATCHES = 40;
/** The single-instance claim; renewed with every batch, released after the drain. */
const CLAIM_MS = 60_000;
/** How long a wake-up waits for the rest of its burst before it drains. */
const WAKE_COALESCE_MS = 50;

const OWN_KINDS = ["plugin_storage", "plugin_row"] as const;

/**
 * The journal rows a plugin's declared consumer reads: its core kinds, and
 * its own storage tables (rows of its own plugin id only).
 */
export function pluginChangeFilter(plugin: LoadedPlugin): JournalFilter {
  const spec = plugin.definition.changeConsumer;
  if (!spec) throw new Error(`plugin "${plugin.slug}" declares no changeConsumer`);
  const own = spec.ownTables ?? [];
  return {
    kinds: [...spec.kinds, ...(own.length > 0 ? OWN_KINDS : [])],
    ...(spec.lines === "main" ? { branchId: null } : {}),
    ...(own.length > 0
      ? { pluginIds: [plugin.pluginId], pluginTables: own }
      : { pluginIds: [plugin.pluginId] }),
  };
}

const journalFilterSchema = z
  .object({
    kinds: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(64),
    branchId: z.string().uuid().nullable().optional(),
    pluginIds: z.array(z.string().uuid()).max(1).optional(),
    pluginTables: z
      .array(z.string().regex(/^[a-z_][a-z0-9_]*$/))
      .max(64)
      .optional(),
  })
  .strict();

const consumerName = z.string().regex(/^plugin:[0-9a-f-]{36}$/);

const SYSTEM_ONLY = ["system"] as const;

/**
 * `plugin_changes.claim` — create the consumer at "now" when it does not
 * exist yet, and take (or renew) its single-instance claim; never waits.
 * One transaction, so a consumer created here is claimed by its creator.
 */
const claimOp = defineOperation({
  name: "plugin_changes.claim",
  // Why human-only: only the host's consumer runner claims.
  actorScope: SYSTEM_ONLY,
  readScope: "request",
  database: "cms_admin",
  input: z
    .object({
      name: consumerName,
      pluginId: z.string().uuid(),
      holder: z.string().min(1).max(200),
    })
    .strict(),
  output: z.object({ created: z.boolean(), claimed: z.boolean() }),
  handler: async (_ctx, input, tx) => {
    const created = await registerConsumer(tx, input.name, input.pluginId);
    const claimed = await claimConsumer(tx, input.name, input.holder, CLAIM_MS);
    return ok({ created, claimed });
  },
});

/** `plugin_changes.release` — give the claim back. */
const releaseOp = defineOperation({
  name: "plugin_changes.release",
  // Why human-only: only the host's consumer runner releases.
  actorScope: SYSTEM_ONLY,
  readScope: "request",
  database: "cms_admin",
  input: z.object({ name: consumerName, holder: z.string().min(1).max(200) }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await releaseConsumer(tx, input.name, input.holder);
    return ok({});
  },
});

/** `plugin_changes.poll` — the next batch past the consumer's cursor. */
const pollOp = defineOperation({
  name: "plugin_changes.poll",
  // Why human-only: only the host's consumer runner reads a plugin's cursor.
  actorScope: SYSTEM_ONLY,
  readScope: "request",
  database: "cms_admin",
  input: z
    .object({
      name: consumerName,
      filter: journalFilterSchema,
      limit: z.number().int().min(1).max(BATCH),
    })
    .strict(),
  output: z.custom<ChangeBatch>(),
  handler: async (_ctx, input, tx) =>
    ok(await pollChanges(tx, input.name, { filter: input.filter, limit: input.limit })),
});

/**
 * `plugin_changes.commit` — store a processed batch, and give the claim
 * back in the same transaction when `release` names the holder (the last
 * batch of a drain).
 */
const commitOp = defineOperation({
  name: "plugin_changes.commit",
  // Why human-only: only the host's consumer runner moves a cursor.
  actorScope: SYSTEM_ONLY,
  readScope: "request",
  database: "cms_admin",
  input: z
    .object({
      name: consumerName,
      token: z.string().min(2).max(100_000),
      release: z.string().min(1).max(200).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    try {
      await commitChanges(tx, input.name, input.token);
      if (input.release) await releaseConsumer(tx, input.name, input.release);
    } catch (thrown) {
      return err({
        kind: "HandlerError",
        operation: "plugin_changes.commit",
        message: thrown instanceof Error ? thrown.message : String(thrown),
      });
    }
    return ok({});
  },
});

/** `plugin_changes.reset` — cursor to "now", after the rebuild ran. */
const resetOp = defineOperation({
  name: "plugin_changes.reset",
  // Why human-only: only the host's consumer runner resets a cursor.
  actorScope: SYSTEM_ONLY,
  readScope: "request",
  database: "cms_admin",
  input: z.object({ name: consumerName }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await resetConsumer(tx, input.name);
    return ok({});
  },
});

const OPS = [claimOp, releaseOp, pollOp, commitOp, resetOp];

/** Register the `plugin_changes.*` operations (idempotent). */
export function registerPluginChangeOps(registry: OperationRegistry): void {
  for (const op of OPS) {
    if (!registry.has(op.name)) registry.register(op as OperationDefinition<unknown, unknown>);
  }
}

function systemCtx(): ExecutionContext {
  return { actorId: hostSystemActorId(), actorKind: "system", requestId: "plugin-changes" };
}

async function run<T>(
  adapter: DatabaseAdapter,
  registry: OperationRegistry,
  name: string,
  input: unknown,
): Promise<T> {
  registerPluginChangeOps(registry);
  const r = await execute(registry, adapter, systemCtx(), name, input);
  if (!r.ok) {
    throw new Error(`${name}: ${"message" in r.error ? String(r.error.message) : r.error.kind}`);
  }
  return r.value as T;
}

function toPluginChange(c: JournalChange): PluginChange {
  const own = c.kind === "plugin_storage" || c.kind === "plugin_row";
  return {
    kind: own ? "own" : (c.kind as PluginChangeKind),
    op: c.op,
    rowId: c.rowId,
    parentId: own ? null : c.parentId,
    table: own ? (c.kind === "plugin_row" ? c.parentId : (c.table.split(".")[1] ?? null)) : null,
    changedColumns: c.changedColumns,
    siteSnapshotId: c.siteSnapshotId,
    prevSnapshotId: c.prevSnapshotId,
  };
}

/** The invocation a batch runs under: its branch's scope, or main. */
function batchInvocation(chatBranchId: string | null): PluginInvocation {
  return chatBranchId
    ? { origin: "chat", actorId: hostSystemActorId(), chatBranchId }
    : { origin: "system", actorId: hostSystemActorId() };
}

/** What one drain did per plugin (tests, logs). */
export interface DrainReport {
  readonly slug: string;
  /** Changes dispatched. */
  readonly changes: number;
  /** Whether the rebuild operation ran. */
  readonly rebuilt: boolean;
  /** Another instance holds the claim; nothing ran here. */
  readonly skipped: boolean;
  /** Set when a dispatch failed; the batch stays uncommitted and is re-delivered. */
  readonly error?: string;
}

async function dispatch(
  plugin: LoadedPlugin,
  operationName: string,
  args: unknown,
  invocation: PluginInvocation,
): Promise<void> {
  const r = await runPluginOperation({ pluginSlug: plugin.slug, operationName, args, invocation });
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
}

async function drainOne(
  adapter: DatabaseAdapter,
  registry: OperationRegistry,
  plugin: LoadedPlugin,
): Promise<DrainReport> {
  const spec = plugin.definition.changeConsumer;
  if (!spec) throw new Error(`plugin "${plugin.slug}" declares no changeConsumer`);
  const name = changeConsumerName(plugin.pluginId);
  const holder = hostInstanceId();
  let changes = 0;
  let rebuilt = false;
  let released = false;
  const claim = { name, pluginId: plugin.pluginId, holder };
  const { created, claimed } = await run<{ created: boolean; claimed: boolean }>(
    adapter,
    registry,
    "plugin_changes.claim",
    claim,
  );
  if (!claimed) return { slug: plugin.slug, changes, rebuilt, skipped: true };
  try {
    if (created) {
      // First sight of this consumer (a first activation, or a
      // re-activation after its cursor was dropped): derive from source.
      await dispatch(plugin, spec.rebuildOperationName, {}, batchInvocation(null));
      rebuilt = true;
    }
    const filter = pluginChangeFilter(plugin);
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = await run<ChangeBatch>(adapter, registry, "plugin_changes.poll", {
        name,
        filter,
        limit: BATCH,
      });
      if (batch.needsRebuild) {
        await dispatch(plugin, spec.rebuildOperationName, {}, batchInvocation(null));
        await run(adapter, registry, "plugin_changes.reset", { name });
        rebuilt = true;
        continue;
      }
      const byBranch = new Map<string | null, PluginChange[]>();
      for (const c of batch.changes) {
        const list = byBranch.get(c.chatBranchId) ?? [];
        list.push(toPluginChange(c));
        byBranch.set(c.chatBranchId, list);
      }
      for (const [chatBranchId, list] of byBranch) {
        await dispatch(
          plugin,
          spec.operationName,
          { chatBranchId, changes: list },
          batchInvocation(chatBranchId),
        );
        changes += list.length;
      }
      // The last batch commits and releases in one transaction.
      const last = !batch.more || i === MAX_BATCHES - 1;
      await run(adapter, registry, "plugin_changes.commit", {
        name,
        token: batch.token,
        ...(last ? { release: holder } : {}),
      });
      if (last) {
        released = true;
        break;
      }
      await run(adapter, registry, "plugin_changes.claim", claim);
    }
    return { slug: plugin.slug, changes, rebuilt, skipped: false };
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    // The dispatcher already recorded a plugin's own failure under the
    // plugin (#1008); the batch is re-delivered on the next wake-up.
    console.error(`[plugin-host] change consumer of "${plugin.slug}" stopped: ${message}`);
    return { slug: plugin.slug, changes, rebuilt, skipped: false, error: message };
  } finally {
    if (!released) {
      await run(adapter, registry, "plugin_changes.release", { name, holder }).catch((e: unknown) =>
        console.error(`[plugin-host] could not release the change consumer of "${plugin.slug}"`, e),
      );
    }
  }
}

/**
 * Run every active plugin's change consumer once, to the end of what the
 * journal holds (bounded per call). Safe from any instance at any time: the
 * claim lets one instance run a consumer while the others skip it.
 *
 * @param only - limit to one plugin (tests and activation)
 */
export async function drainChangeConsumers(
  infra: { readonly adapter: DatabaseAdapter; readonly registry: OperationRegistry },
  only?: string,
): Promise<DrainReport[]> {
  const reports: DrainReport[] = [];
  for (const plugin of loadedPlugins.all()) {
    if (!plugin.definition.changeConsumer || isPluginDisabled(plugin.slug)) continue;
    if (only !== undefined && plugin.slug !== only) continue;
    reports.push(await drainOne(infra.adapter, infra.registry, plugin));
  }
  return reports;
}

/** A running consumer loop; `stop` unlistens. */
export interface ChangeConsumersHandle {
  stop(): Promise<void>;
  /** Run a drain now and wait for it (activation, tests). */
  drain(): Promise<void>;
}

/**
 * Start the wake-up loop: every journal NOTIFY (and every reconnect of the
 * LISTEN connection) drains the consumers. Wake-ups during a drain run one
 * more drain after it, so none is lost and none runs twice at once here.
 */
export async function startChangeConsumers(infra: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}): Promise<ChangeConsumersHandle> {
  let running: Promise<void> | null = null;
  let again = false;
  function wake(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        // One drain per burst: the commits of one agent turn arrive within
        // milliseconds of each other.
        await new Promise((resolve) => setTimeout(resolve, WAKE_COALESCE_MS));
        do {
          again = false;
          await drainChangeConsumers(infra);
        } while (again);
      } catch (thrown) {
        console.error("[plugin-host] draining the change consumers failed", thrown);
      } finally {
        running = null;
      }
    })();
    return running;
  }
  const handle: ListenHandle = await infra.adapter.listen(
    "admin",
    JOURNAL_CHANNEL,
    () => void wake(),
    () => void wake(),
  );
  return {
    async stop() {
      await handle.unlisten();
      await running;
    },
    drain: wake,
  };
}

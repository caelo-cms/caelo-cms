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
  beginConsumerRebuild,
  type ChangeBatch,
  checkJournalMark,
  claimConsumer,
  commitChanges,
  consumerClaimExpiresInMs,
  consumerCursorContinuous,
  consumerRebuildPending,
  type DatabaseAdapter,
  defineOperation,
  execute,
  finishConsumerRebuild,
  type JournalChange,
  type JournalCheck,
  type JournalFilter,
  type ListenHandle,
  type OperationDefinition,
  type OperationRegistry,
  pollChanges,
  registerConsumer,
  releaseConsumer,
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
import { setConsumerBackoff } from "./plugin-runtime-stats.js";
import { hostInstanceId, recordPluginError } from "./runtime-health.js";

/** The consumer name of a plugin: keyed on its id, never its reusable slug. */
export function changeConsumerName(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/** Changes one dispatch carries at most. */
const BATCH = 500;
/**
 * Batches one drain of one consumer runs at most before the next consumer's
 * turn (fairness); a consumer with more left is drained again right after
 * the round (`DrainReport.more`), not at the next wake-up.
 */
const MAX_BATCHES = 40;
/**
 * The single-instance claim. Renewed every third of it while a dispatch or a
 * rebuild runs, so a long one keeps it; every state update (batch commit,
 * finished rebuild) is fenced on it, so one that outlived it changes nothing.
 */
const CLAIM_MS = 60_000;

/** Overrides of the drain's limits (tests); production uses the defaults. */
export interface DrainLimits {
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly claimMs?: number;
  /** First retry delay of a failed consumer ({@link startChangeConsumers}). */
  readonly failureRetryMinMs?: number;
  /** Longest retry delay of a failed consumer ({@link startChangeConsumers}). */
  readonly failureRetryMaxMs?: number;
}
/** How long a wake-up waits for the rest of its burst before it drains. */
const WAKE_COALESCE_MS = 50;
/** How long after another instance's claim lapses the takeover retry runs. */
const TAKEOVER_SLACK_MS = 250;
/**
 * The retry of a consumer whose drain failed: 1 s, doubling to at most
 * 5 minutes, reset by its next drain without an error. Bounded in interval,
 * not in attempts: the consumer must deliver eventually, and every failure
 * is recorded (#1008). Per consumer (#1390), and it gates the NOTIFY
 * wake-ups too — see {@link startChangeConsumers}.
 */
const FAILURE_RETRY_MIN_MS = 1_000;
const FAILURE_RETRY_MAX_MS = 5 * 60_000;

/** A plugin operation of the consumer failed; the dispatcher recorded it under the plugin. */
class ConsumerDispatchError extends Error {
  override readonly name = "ConsumerDispatchError";
}

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
      leaseMs: z.number().int().min(1000).max(CLAIM_MS).optional(),
    })
    .strict(),
  output: z.object({
    claimed: z.boolean(),
    rebuildPending: z.boolean(),
    /** When not claimed: ms until the other holder's claim lapses. */
    retryInMs: z.number().int().nonnegative().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    await registerConsumer(tx, input.name, input.pluginId);
    const claimed = await claimConsumer(tx, input.name, input.holder, input.leaseMs ?? CLAIM_MS);
    return ok({
      claimed,
      rebuildPending: await consumerRebuildPending(tx, input.name),
      retryInMs: claimed ? null : await consumerClaimExpiresInMs(tx, input.name),
    });
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
      /** The claim's holder: the commit is refused once its claim lapsed. */
      holder: z.string().min(1).max(200),
      release: z.string().min(1).max(200).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    try {
      await commitChanges(tx, input.name, input.token, { holder: input.holder });
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

/**
 * `plugin_changes.begin_rebuild` — the cursor moves to "now" BEFORE the
 * rebuild reads its source, and the rebuild is marked pending, so a change
 * committed during it is delivered after it and a failed one runs again.
 */
const beginRebuildOp = defineOperation({
  name: "plugin_changes.begin_rebuild",
  // Why human-only: only the host's consumer runner starts a rebuild.
  actorScope: SYSTEM_ONLY,
  readScope: "request",
  database: "cms_admin",
  input: z.object({ name: consumerName }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await beginConsumerRebuild(tx, input.name);
    return ok({});
  },
});

/** `plugin_changes.finish_rebuild` — the rebuild succeeded. */
const finishRebuildOp = defineOperation({
  name: "plugin_changes.finish_rebuild",
  // Why human-only: only the host's consumer runner finishes a rebuild.
  actorScope: SYSTEM_ONLY,
  readScope: "request",
  database: "cms_admin",
  input: z.object({ name: consumerName, holder: z.string().min(1).max(200) }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    try {
      await finishConsumerRebuild(tx, input.name, { holder: input.holder });
    } catch (thrown) {
      return err({
        kind: "HandlerError",
        operation: "plugin_changes.finish_rebuild",
        message: thrown instanceof Error ? thrown.message : String(thrown),
      });
    }
    return ok({});
  },
});

/**
 * `plugin_changes.cursor_state` — the calling plugin's own consumer: whether
 * its cursor is continuous (exists, no rebuild pending, not passed by GC).
 * A plugin that adopts current content as a baseline (international-site's
 * `source_hash` backfill) may do so only then; otherwise its rebuild runs.
 */
const cursorStateOp = defineOperation({
  name: "plugin_changes.cursor_state",
  // Why system-only: no person or AI has a change consumer; it answers
  // the calling plugin about its own (actorScope plugin).
  actorScope: ["plugin"],
  readScope: "request",
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ continuous: z.boolean() }),
  handler: async (ctx, _input, tx) => {
    if (!ctx.pluginId) {
      return err({
        kind: "HandlerError",
        operation: "plugin_changes.cursor_state",
        message:
          "plugin_changes.cursor_state answers for a plugin's own consumer; call it from the plugin",
      });
    }
    return ok({
      continuous: await consumerCursorContinuous(tx, changeConsumerName(ctx.pluginId)),
    });
  },
});

/**
 * `plugin_changes.check_mark` — #1269: is an answer the host cached for a
 * plugin still what the plugin would answer now, as far as the plugin's
 * own declared tables reach; and the mark to keep with a fresh answer.
 */
const checkMarkOp = defineOperation({
  name: "plugin_changes.check_mark",
  // Why human-only: only the host checks the answers it caches for plugins.
  actorScope: SYSTEM_ONLY,
  readScope: "request",
  database: "cms_admin",
  input: z
    .object({
      mark: z
        .object({ snapshot: z.string().min(1).max(100_000), ownXid: z.string().nullable() })
        .strict()
        .nullable(),
      filter: journalFilterSchema.extend({
        columns: z
          .record(z.string().regex(/^[a-z_]{1,40}$/), z.array(z.string().max(63)).max(64))
          .optional(),
        branchOnlyKinds: z
          .array(z.string().regex(/^[a-z_]{1,40}$/))
          .max(8)
          .optional(),
        kindOps: z
          .record(
            z.string().regex(/^[a-z_]{1,40}$/),
            z.array(z.enum(["insert", "update", "delete", "truncate"])).max(4),
          )
          .optional(),
        unscopedOps: z
          .array(z.enum(["insert", "update", "delete", "truncate"]))
          .max(4)
          .optional(),
      }),
    })
    .strict(),
  output: z.custom<JournalCheck>(),
  handler: async (_ctx, input, tx) => ok(await checkJournalMark(tx, input.mark, input.filter)),
});

/** {@link checkMarkOp} through the Query API, as the system. */
export async function checkPluginJournalMark(
  adapter: DatabaseAdapter,
  registry: OperationRegistry,
  mark: { readonly snapshot: string; readonly ownXid: string | null } | null,
  filter: JournalFilter,
): Promise<JournalCheck> {
  return run<JournalCheck>(adapter, registry, checkMarkOp.name, {
    mark: mark ? { snapshot: mark.snapshot, ownXid: mark.ownXid } : null,
    filter,
  });
}

const OPS = [
  claimOp,
  releaseOp,
  pollOp,
  commitOp,
  beginRebuildOp,
  finishRebuildOp,
  cursorStateOp,
  checkMarkOp,
];

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
  /** The batch budget ran out with changes left: drain this consumer again. */
  readonly more: boolean;
  /**
   * Skipped because another instance holds the claim: ms until that claim
   * lapses. A holder that died mid-batch leaves no notification behind, so
   * the loop retries once then instead of waiting for an unrelated write.
   */
  readonly retryInMs?: number;
}

async function dispatch(
  plugin: LoadedPlugin,
  operationName: string,
  args: unknown,
  invocation: PluginInvocation,
): Promise<void> {
  const r = await runPluginOperation({ pluginSlug: plugin.slug, operationName, args, invocation });
  if (!r.ok) throw new ConsumerDispatchError(`${r.error.kind}: ${r.error.message}`);
}

/** Record a failure of the host's own consumer step (claim, poll, commit) under the plugin. */
async function recordHostStepError(
  adapter: DatabaseAdapter,
  registry: OperationRegistry,
  plugin: LoadedPlugin,
  message: string,
  thrown: unknown,
): Promise<void> {
  await recordPluginError({
    infra: { adapter, registry },
    systemActorId: hostSystemActorId(),
    slug: plugin.slug,
    pluginId: plugin.pluginId,
    phase: "worker",
    error: new Error(`change consumer: ${message}`, { cause: thrown }),
  });
}

async function drainOne(
  adapter: DatabaseAdapter,
  registry: OperationRegistry,
  plugin: LoadedPlugin,
  limits: DrainLimits,
): Promise<DrainReport> {
  const spec = plugin.definition.changeConsumer;
  if (!spec) throw new Error(`plugin "${plugin.slug}" declares no changeConsumer`);
  const batchSize = limits.batchSize ?? BATCH;
  const maxBatches = limits.maxBatches ?? MAX_BATCHES;
  const claimMs = limits.claimMs ?? CLAIM_MS;
  const name = changeConsumerName(plugin.pluginId);
  const holder = hostInstanceId();
  let changes = 0;
  let rebuilt = false;
  let released = false;
  let more = false;
  const claim = { name, pluginId: plugin.pluginId, holder, leaseMs: claimMs };
  let claimResult: { claimed: boolean; rebuildPending: boolean; retryInMs: number | null };
  try {
    claimResult = await run(adapter, registry, "plugin_changes.claim", claim);
  } catch (thrown) {
    // Nothing is claimed, so nothing to release; the consumer's backoff
    // retries it like a failed batch (#1390), not the other consumers.
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    await recordHostStepError(adapter, registry, plugin, message, thrown);
    return { slug: plugin.slug, changes, rebuilt, skipped: false, error: message, more: false };
  }
  const { claimed, rebuildPending, retryInMs } = claimResult;
  if (!claimed) {
    return {
      slug: plugin.slug,
      changes,
      rebuilt,
      skipped: true,
      more,
      ...(retryInMs !== null ? { retryInMs } : {}),
    };
  }
  // A dispatch or a rebuild may run longer than the claim: renew it while it
  // runs. A renewal that fails (another instance took the consumer over)
  // stops this drain after the operation; the fenced commit or finish
  // refuses its state update either way.
  const keepingClaim = async <T>(work: () => Promise<T>): Promise<T> => {
    let lost: string | null = null;
    const timer = setInterval(
      () => {
        run<{ claimed: boolean }>(adapter, registry, "plugin_changes.claim", claim)
          .then((r) => {
            if (!r.claimed) lost ??= "another instance took the consumer over";
          })
          .catch((e: unknown) => {
            lost ??= `the claim could not be renewed: ${e instanceof Error ? e.message : String(e)}`;
          });
      },
      Math.max(250, Math.floor(claimMs / 3)),
    );
    try {
      const out = await work();
      if (lost) throw new Error(`the change consumer's claim was lost while it ran: ${lost}`);
      return out;
    } finally {
      clearInterval(timer);
    }
  };
  // The rebuild-from-source: derive everything, then read the journal from
  // where the rebuild began (its cursor was taken before it ran).
  const rebuild = async () => {
    await keepingClaim(() =>
      dispatch(plugin, spec.rebuildOperationName, {}, batchInvocation(null)),
    );
    await run(adapter, registry, "plugin_changes.finish_rebuild", { name, holder });
    rebuilt = true;
  };
  try {
    // First sight of this consumer (a first activation, or a re-activation
    // after its cursor was dropped), or a rebuild that did not finish.
    if (rebuildPending) await rebuild();
    const filter = pluginChangeFilter(plugin);
    for (let i = 0; i < maxBatches; i++) {
      const batch = await run<ChangeBatch>(adapter, registry, "plugin_changes.poll", {
        name,
        filter,
        limit: batchSize,
      });
      if (batch.needsRebuild) {
        await run(adapter, registry, "plugin_changes.begin_rebuild", { name });
        await rebuild();
        continue;
      }
      const byBranch = new Map<string | null, PluginChange[]>();
      for (const c of batch.changes) {
        const list = byBranch.get(c.chatBranchId) ?? [];
        list.push(toPluginChange(c));
        byBranch.set(c.chatBranchId, list);
      }
      for (const [chatBranchId, list] of byBranch) {
        await keepingClaim(() =>
          dispatch(
            plugin,
            spec.operationName,
            { chatBranchId, changes: list },
            batchInvocation(chatBranchId),
          ),
        );
        changes += list.length;
      }
      // The last batch commits and releases in one transaction.
      const last = !batch.more || i === maxBatches - 1;
      await run(adapter, registry, "plugin_changes.commit", {
        name,
        token: batch.token,
        holder,
        ...(last ? { release: holder } : {}),
      });
      if (last) {
        released = true;
        more = batch.more;
        break;
      }
      await run(adapter, registry, "plugin_changes.claim", claim);
    }
    return { slug: plugin.slug, changes, rebuilt, skipped: false, more };
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    // A plugin operation's failure is already recorded under the plugin by
    // the dispatcher (#1008); a failure of the host's own consumer step
    // (claim, poll, commit, a lost claim) is recorded here, so both reach
    // plugin_errors and the health surfaces. The batch stays uncommitted
    // and the wake-up loop retries it with a backoff.
    if (thrown instanceof ConsumerDispatchError) {
      console.error(`[plugin-host] change consumer of "${plugin.slug}" stopped: ${message}`);
    } else {
      await recordHostStepError(adapter, registry, plugin, message, thrown);
    }
    return { slug: plugin.slug, changes, rebuilt, skipped: false, error: message, more: false };
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
 * @param waiting - consumers to leave out of this drain (the wake-up loop's
 *   failure backoff); they get no report
 */
export async function drainChangeConsumers(
  infra: { readonly adapter: DatabaseAdapter; readonly registry: OperationRegistry },
  only?: string,
  limits: DrainLimits = {},
  waiting?: (plugin: LoadedPlugin) => boolean,
): Promise<DrainReport[]> {
  const reports: DrainReport[] = [];
  for (const plugin of loadedPlugins.all()) {
    if (!plugin.definition.changeConsumer || isPluginDisabled(plugin.slug)) continue;
    if (only !== undefined && plugin.slug !== only) continue;
    if (waiting?.(plugin)) continue;
    reports.push(await drainOne(infra.adapter, infra.registry, plugin, limits));
  }
  return reports;
}

/** A running consumer loop; `stop` unlistens. */
export interface ChangeConsumersHandle {
  stop(): Promise<void>;
  /** Run a drain now and wait for it (activation, tests). */
  drain(): Promise<void>;
}

/** A consumer whose last drain failed, waiting until `notBefore` (wake-up loop). */
interface ConsumerBackoff {
  /** The loaded plugin it belongs to: a reload (a new object) starts afresh. */
  readonly plugin: LoadedPlugin;
  readonly failures: number;
  readonly notBefore: number;
}

/**
 * Start the wake-up loop: every journal NOTIFY (and every reconnect of the
 * LISTEN connection) drains the consumers. Wake-ups during a drain run one
 * more drain after it, so none is lost and none runs twice at once here; a
 * consumer that ran out of its batch budget with changes left is drained
 * again right after the round, so a burst larger than the budget is
 * delivered without waiting for another write.
 *
 * #1390 — a consumer whose drain failed waits out its own backoff before it
 * runs again, whatever wakes the loop. Before, only a quiet site waited: on
 * searchVIU production (2026-11-03) every agent write's NOTIFY re-ran the
 * consent-manager's failing batch at once — a site-sized read that hit the
 * 60 s statement timeout each time, on a database already short of CPU.
 * This is the retry backoff of a failing batch, NOT throttling of healthy
 * work (#1253: healthy work is never held back programmatically): a
 * consumer without a failure, and every other consumer next to a failing
 * one, still drains on every wake-up. The failed batch stays uncommitted
 * (at least once is unchanged) and a timer retries it when its time comes,
 * also on a quiet site. The state is per instance and shown in plugin
 * health (plugin-runtime-stats.ts, written with the runtime heartbeat).
 */
export async function startChangeConsumers(
  infra: {
    readonly adapter: DatabaseAdapter;
    readonly registry: OperationRegistry;
  },
  limits: DrainLimits = {},
): Promise<ChangeConsumersHandle> {
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  const retryMinMs = limits.failureRetryMinMs ?? FAILURE_RETRY_MIN_MS;
  const retryMaxMs = limits.failureRetryMaxMs ?? FAILURE_RETRY_MAX_MS;
  // One pending retry at a time, at the earliest of: the lapse of a claim
  // another instance held when this one skipped its consumer, and the end
  // of a failed consumer's backoff.
  let retry: { at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  const backoffs = new Map<string, ConsumerBackoff>();
  // A drain that threw as a whole (not one consumer's failure, which its
  // report carries) retries everything with its own backoff.
  let loopFailureRetryMs = retryMinMs;
  function scheduleRetry(inMs: number): void {
    if (stopped) return;
    const at = Date.now() + Math.max(0, inMs) + TAKEOVER_SLACK_MS;
    if (retry && retry.at <= at) return;
    if (retry) clearTimeout(retry.timer);
    const timer = setTimeout(() => {
      retry = null;
      void wake();
    }, at - Date.now());
    timer.unref?.();
    retry = { at, timer };
  }
  function clearBackoff(slug: string): void {
    if (backoffs.delete(slug)) setConsumerBackoff(slug, null);
  }
  /** Drop the backoff of a plugin that is gone or was reloaded since it failed. */
  function forgetStale(): void {
    for (const [slug, b] of backoffs) {
      if (loadedPlugins.bySlug(slug) !== b.plugin) clearBackoff(slug);
    }
  }
  function isWaiting(plugin: LoadedPlugin, now: number): boolean {
    const b = backoffs.get(plugin.slug);
    return b !== undefined && b.plugin === plugin && b.notBefore > now;
  }
  function settle(report: DrainReport): void {
    if (report.error !== undefined) {
      const plugin = loadedPlugins.bySlug(report.slug);
      if (!plugin) return;
      const prev = backoffs.get(report.slug);
      const failures = (prev?.plugin === plugin ? prev.failures : 0) + 1;
      const delay = Math.min(retryMinMs * 2 ** Math.min(failures - 1, 30), retryMaxMs);
      const notBefore = Date.now() + delay;
      backoffs.set(report.slug, { plugin, failures, notBefore });
      setConsumerBackoff(report.slug, {
        consecutiveFailures: failures,
        nextRetryAt: new Date(notBefore).toISOString(),
        lastError: report.error.slice(0, 1000),
      });
      console.warn(
        `[plugin-host] change consumer of "${report.slug}" failed ${failures}x in a row; its batch is retried in ${delay} ms (other consumers keep running)`,
      );
    } else if (!report.skipped) {
      clearBackoff(report.slug);
    }
  }
  function scheduleBackoffRetry(): void {
    if (backoffs.size === 0) return;
    const earliest = Math.min(...[...backoffs.values()].map((b) => b.notBefore));
    scheduleRetry(earliest - Date.now());
  }
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
          forgetStale();
          const now = Date.now();
          const reports = await drainChangeConsumers(infra, undefined, limits, (plugin) =>
            isWaiting(plugin, now),
          );
          for (const r of reports) settle(r);
          if (reports.some((r) => r.more)) again = true;
          const waits = reports.flatMap((r) => (r.retryInMs !== undefined ? [r.retryInMs] : []));
          if (waits.length > 0) scheduleRetry(Math.min(...waits));
        } while (again);
        scheduleBackoffRetry();
        loopFailureRetryMs = retryMinMs;
      } catch (thrown) {
        console.error("[plugin-host] draining the change consumers failed", thrown);
        scheduleRetry(loopFailureRetryMs);
        loopFailureRetryMs = Math.min(loopFailureRetryMs * 2, retryMaxMs);
      } finally {
        running = null;
      }
    })();
    return running;
  }
  // The consumers' cursors are the truth: a reconnect drains from them, so
  // the gap's changes are caught up, never lost.
  const handle: ListenHandle = await infra.adapter.listen("admin", JOURNAL_CHANNEL, {
    onNotify: () => void wake(),
    onListen: () => void wake(),
    onLost: (cause) =>
      console.warn("[plugin-host] the change-journal LISTEN connection dropped", cause),
  });
  return {
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry.timer);
      retry = null;
      await handle.unlisten();
      await running;
      for (const slug of [...backoffs.keys()]) clearBackoff(slug);
    },
    drain: wake,
  };
}

// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R5, issue #1646) — the `plugin_batch` job's side.
 *
 * The job holds no database credential and no secret. It asks the admin
 * for its order, builds a context whose every handle is a report back to
 * the admin (`call`), runs the operation, and reports the result:
 *
 *   - an installed plugin (Tier 2) runs in the Deno sandbox, from the
 *     artifact the admin verified against its approval — the same
 *     validator, bundler and `--deny-*` flags as in the admin;
 *   - a shipped plugin (Tier 1) runs as it runs in the admin, from this
 *     image's own verified copy (signature and validator, the version the
 *     order names), or — in-process — the definition the host loaded.
 *
 * Either way the operation reaches only what the admin answers for it on
 * the plugin's grants; the job's network access gives a sandboxed plugin
 * nothing (Deno denies it), and a shipped plugin is reviewed code.
 *
 * A batch in pieces (#1776): the lead runs the plan operation, names its
 * pieces to the admin, then every task (the lead and the helpers the
 * capacity ledger adds) claims piece after piece and runs the operation on
 * each. A helper ends when no piece is left for it, or after its piece when
 * the ledger needs its CPU; the lead ends the run once every piece is done.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadedPlugins,
  runSandbox,
  SANDBOX_BATCH_CALL_LIMIT,
  verifyDiskPlugin,
} from "@caelo-cms/plugin-host";
import {
  batchPlanResult,
  type PluginContext,
  type PluginContextTier1,
  type PluginDefinition,
  type PluginManifest,
  pluginManifest,
} from "@caelo-cms/plugin-sdk";
import type { PieceClaim } from "../ops/job_pieces.js";
import { type JobReporter, SINGLE_TASK, workerOf } from "../reporting-jobs/job-reporter.js";
import type { BatchOrder } from "./job-kind.js";

/** Bytes one report's `call` arguments may take (an upsert is split below it). */
const CALL_CHUNK_BYTES = 768 * 1024;

type Call = (method: string, args: unknown[]) => Promise<unknown>;

const QUERY_METHODS = ["insert", "list", "update", "updateMany", "compareAndSwap", "delete"];
const FILE_METHODS = ["begin", "writeChunk", "commit", "stat", "readChunk", "remove"];

function handles(call: Call, prefix: string, names: readonly string[]) {
  return Object.freeze(
    Object.fromEntries(names.map((n) => [n, (...args: unknown[]) => call(`${prefix}.${n}`, args)])),
  );
}

/**
 * The batch context the job hands the operation: every handle reports to
 * the admin. Only the handles the admin said the plugin has are present.
 */
export function remoteBatchContext(order: BatchOrder, call: Call): PluginContextTier1 {
  const collections = Object.fromEntries(
    order.handles.collections.map((name) => [
      name,
      Object.freeze({
        upsert: async (docs: readonly unknown[]) => {
          let chunk: unknown[] = [];
          let bytes = 0;
          for (const doc of docs) {
            const size = Buffer.byteLength(JSON.stringify(doc)) + 1;
            if (chunk.length > 0 && (bytes + size > CALL_CHUNK_BYTES || chunk.length === 500)) {
              await call("collections.upsert", [name, chunk]);
              chunk = [];
              bytes = 0;
            }
            chunk.push(doc);
            bytes += size;
          }
          if (chunk.length > 0) await call("collections.upsert", [name, chunk]);
        },
        delete: async (ids: readonly string[]) => {
          for (let i = 0; i < ids.length; i += 1000)
            await call("collections.delete", [name, ids.slice(i, i + 1000)]);
        },
        replace: async (field: string, values: readonly string[], docs: readonly unknown[]) => {
          await call("collections.replace", [name, field, values, docs.slice(0, 200)]);
          for (let i = 200; i < docs.length; i += 200)
            await call("collections.upsert", [name, docs.slice(i, i + 200)]);
        },
        get: (id: string) => call("collections.get", [name, id]),
        getMany: async (ids: readonly string[]) => {
          const docs = new Map<string, unknown>();
          let pending = false;
          for (let i = 0; i < ids.length; i += 1000) {
            const r = (await call("collections.getMany", [name, ids.slice(i, i + 1000)])) as {
              docs: { id: string }[];
              pending: boolean;
            };
            for (const d of r.docs) docs.set(d.id, d);
            pending ||= r.pending;
          }
          return { docs, pending };
        },
        query: (operation: string, params: unknown, opts: unknown) =>
          call("collections.query", [name, operation, params, opts ?? {}]),
        setProfile: (profile: unknown) => call("collections.setProfile", [name, profile]),
      }),
    ]),
  );
  const ctx = {
    query: handles(call, "query", QUERY_METHODS),
    ...(order.handles.hasAdminQuery
      ? {
          adminQuery: Object.freeze({
            ...handles(call, "adminQuery", QUERY_METHODS),
            // #1659 — private storage only; options left out stay out of
            // the report (JSON would send them as null, which is refused).
            upsert: (table: string, key: unknown, values: unknown, options?: unknown) =>
              call(
                "adminQuery.upsert",
                options === undefined ? [table, key, values] : [table, key, values, options],
              ),
          }),
        }
      : {}),
    ...(order.handles.hasPrivateFiles
      ? { privateFiles: handles(call, "privateFiles", FILE_METHODS) }
      : {}),
    ...(order.handles.hasConfig
      ? {
          config: Object.freeze({
            get: () => call("config.get", []),
            entity: (kind: string, id: string) => call("config.entity", [kind, id]),
            entities: async (kind: string, ids: readonly string[]) =>
              new Map((await call("config.entities", [kind, ids])) as [string, unknown][]),
            configured: (kind: string) => call("config.configured", [kind]),
          }),
        }
      : {}),
    ...(order.handles.collections.length > 0 ? { collections: Object.freeze(collections) } : {}),
    api: handles(call, "api", ["list", "get"]),
    captcha: { requireProof: async () => false },
    theme: Object.freeze({ tokens: {} }),
    visitor: Object.freeze({ id: null, publicUserId: null, ipHash: "", sessionToken: null }),
    invocation: Object.freeze({ ...order.invocation }),
  };
  return Object.freeze(ctx) as unknown as PluginContextTier1;
}

/** Where the image keeps the shipped plugins. */
function pluginsRoot(): string {
  return process.env.CAELO_PLUGINS_ROOT ?? resolve(import.meta.dir, "..", "..", "..", "plugins");
}

/** The shipped plugin's definition: the host's (in-process), or this image's verified copy. */
async function shippedDefinition(order: BatchOrder): Promise<PluginDefinition<PluginContext>> {
  const loaded = loadedPlugins.bySlug(order.slug);
  if (loaded && loaded.version === order.version && loaded.tier === 1)
    return loaded.definition as PluginDefinition<PluginContext>;
  const pluginDir = join(pluginsRoot(), order.slug);
  const rawManifest = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8")) as unknown;
  const verified = await verifyDiskPlugin({ slug: order.slug, pluginDir, rawManifest });
  if (verified.definition.version !== order.version) {
    throw new Error(
      `this job's image carries plugin "${order.slug}" ${verified.definition.version}, the run is for ${order.version}: the job and the admin run different releases`,
    );
  }
  return verified.definition as PluginDefinition<PluginContext>;
}

async function withDeadline<T>(seconds: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the batch ran longer than its maxRunSeconds (${seconds} s)`)),
          seconds * 1000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs the ordered operation on `ctx`; resolves with its result. */
export async function runOrderedBatch(
  order: BatchOrder,
  ctx: PluginContextTier1,
): Promise<unknown> {
  if (order.tier === 2) {
    if (!order.artifact) throw new Error("an installed plugin's run carries its artifact");
    const manifest = pluginManifest.parse(order.artifact.manifest) as PluginManifest;
    return runSandbox({
      source: order.artifact.source,
      manifest,
      operation: order.operation,
      args: order.args,
      context: ctx as PluginContext,
      // The admin authorises every call it answers; the job has nothing to add.
      authorize: async () => {},
      // #1729 — the background pool: on a self-hosted install the job runs
      // inside the admin, and a batch must not take the slots of a chat.
      kind: "batch",
      timeoutMs: order.maxRunSeconds * 1000,
      callLimit: SANDBOX_BATCH_CALL_LIMIT,
    });
  }
  const definition = await shippedDefinition(order);
  const handler = definition.operations[order.operation];
  if (!handler) throw new Error(`plugin "${order.slug}" has no operation "${order.operation}"`);
  return withDeadline(
    order.maxRunSeconds,
    Promise.resolve(handler(ctx as PluginContext, order.args)),
  );
}

/** How long a task holds a claimed piece beyond the piece's own limit. */
const PIECE_CLAIM_MARGIN_SECONDS = 300;

/** Between two claims while every open piece is taken. */
const PIECE_POLL_MS = 10_000;

/**
 * The pieces of a batch in pieces, as this task's part: the lead plans and
 * names them, then every task runs piece after piece.
 *
 * @returns the pieces the plan named (the lead), or null (a helper, or the
 *   ledger stopped it).
 */
async function runPieces(
  reporter: JobReporter,
  order: BatchOrder,
  plan: string,
  ctx: PluginContextTier1,
): Promise<number | null> {
  const slot = reporter.slot ?? SINGLE_TASK;
  const helper = slot.helper !== null;
  let count = 0;
  if (!helper) {
    const planned = batchPlanResult.parse(
      await runOrderedBatch({ ...order, operation: plan }, ctx),
    );
    count = planned.pieces.length;
    if (count === 0) return 0;
    await reporter.call("pieces", { keys: planned.pieces });
  }
  const worker = workerOf(slot);
  for (;;) {
    const c = await reporter.call<PieceClaim>("claim", {
      worker,
      claimSeconds: order.maxRunSeconds + PIECE_CLAIM_MARGIN_SECONDS,
    });
    if ("stop" in c) return null;
    if ("none" in c) break;
    if ("wait" in c) {
      // Others still run theirs: a helper is done, the lead waits and takes
      // over a piece whose claim runs out.
      if (helper) break;
      await new Promise((r) => setTimeout(r, PIECE_POLL_MS));
      continue;
    }
    await runOrderedBatch({ ...order, args: { ...order.args, piece: c.key } }, ctx);
    await reporter.call("piece-done", { piece: c.piece });
  }
  if (helper) {
    await reporter.call("leave", {});
    return null;
  }
  return count;
}

/** The job's main: one run of one batch operation (or this task's pieces of it). */
export async function runPluginBatchJob(reporter: JobReporter): Promise<void> {
  const helper = (reporter.slot ?? SINGLE_TASK).helper !== null;
  const order = await reporter.call<BatchOrder>("order", {});
  const call: Call = async (method, args) => {
    const r = await reporter.call<{ ok: boolean; value?: unknown; message?: string }>("call", {
      method,
      args,
    });
    if (!r.ok) throw new Error(r.message ?? `${method} failed`);
    return r.value;
  };
  let value: unknown;
  try {
    const ctx = remoteBatchContext(order, call);
    if (order.pieces) {
      const count = await runPieces(reporter, order, order.pieces.plan, ctx);
      if (count === null) return;
      value = { pieces: count };
    } else {
      if (helper) throw new Error("a batch without pieces runs no helper");
      value = await runOrderedBatch(order, ctx);
    }
  } catch (e) {
    // The admin ended the attempt (the run was stopped): nothing to report.
    if (reporter.stopped) return;
    await reporter.call("failed", {
      error: (e instanceof Error ? e.message : String(e)).slice(0, 4000) || "the batch failed",
    });
    return;
  }
  await reporter.call("done", { value: value ?? null });
}

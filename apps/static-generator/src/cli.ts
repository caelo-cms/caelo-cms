#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * P6.2 #5 — runnable Bun CLI entry point. The deploy ops in
 * @caelo-cms/admin-core spawn this binary as a subprocess instead of
 * importing `generateSite` in-process. Two reasons:
 *
 *  - **Process isolation.** A generator OOM / panic doesn't take down
 *    the admin server. Exit code drives the deploy_runs row state.
 *  - **§3.1 alignment.** AI cannot reach the generator binary —
 *    moving the entry point out of the in-process import graph makes
 *    that constraint structural, not just a registry omission.
 *
 * Protocol (JSON lines, Maps encoded by `encodeBuildPayload`):
 *
 *   stdin, first line — the config:
 *     { adminDatabaseUrl, publicDatabaseUrl, target, runId, repoRoot,
 *       changedPageIds? }
 *   stdout — progress and the outcome:
 *     {kind:"progress", pagesDone, pagesTotal}
 *     {kind:"done", pageCount, fileCount, durationMs, buildDir}
 *     {kind:"error", message}
 *   stdout → stdin — #605 plugin calls answered by the admin:
 *     {kind:"plugin-call", id, method, args}
 *     ← {kind:"plugin-result", id, ok:true, value} | {…, ok:false, message}
 *
 * The plugin host runs in the admin, not here: every plugin answer the
 * build needs (data lists, head contributions, public URLs, content
 * variants, withheld modules, staticRender, client assets) is a call back
 * to the admin's plugin host, so the published site gets exactly what
 * the editor preview shows (see plugin-host/build-services.ts).
 *
 * Exit: 0 on done, 1 on error.
 */

import { createInterface } from "node:readline";
import {
  type BuildPluginMethod,
  decodeBuildPayload,
  encodeBuildPayload,
  remoteBuildPluginServices,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { type DeployTarget, generateSite } from "./generate.js";

interface CliInput {
  adminDatabaseUrl: string;
  publicDatabaseUrl: string;
  target: DeployTarget;
  runId: string;
  repoRoot: string;
  /** P13 ideas-pass — incremental rebuild whitelist (page ids).
   *  Empty/missing = full-site rebuild. */
  changedPageIds?: string[];
}

interface PluginResult {
  kind: "plugin-result";
  id: number;
  ok: boolean;
  value?: unknown;
  message?: string;
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

function emit(line: Record<string, unknown>): void {
  process.stdout.write(`${encodeBuildPayload(line)}\n`);
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let config: CliInput | null = null;
  let resolveConfig: (c: CliInput) => void = () => undefined;
  const configReady = new Promise<CliInput>((r) => {
    resolveConfig = r;
  });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    if (config === null) {
      config = JSON.parse(line) as CliInput;
      resolveConfig(config);
      return;
    }
    const msg = decodeBuildPayload(line) as PluginResult;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.value);
    else waiter.reject(new Error(msg.message ?? "plugin call failed"));
  });
  // Once the admin's side closes, no answer can come: fail the calls in
  // flight AND every later one instead of waiting forever.
  let channelClosed = false;
  lines.on("close", () => {
    channelClosed = true;
    for (const w of pending.values()) {
      w.reject(new Error("the admin closed the plugin channel before answering"));
    }
    pending.clear();
  });

  const input = await configReady;
  let nextId = 0;
  const plugins = remoteBuildPluginServices(
    (method: BuildPluginMethod, args: unknown[]) =>
      new Promise((resolve, reject) => {
        if (channelClosed) {
          reject(new Error(`plugin call ${method}: the admin closed the plugin channel`));
          return;
        }
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        emit({ kind: "plugin-call", id, method, args });
      }),
  );

  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: input.adminDatabaseUrl,
    publicDatabaseUrl: input.publicDatabaseUrl,
  });
  try {
    const result = await adapter.withAdminTransaction(
      { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: `gen-${input.runId}` },
      (tx) =>
        generateSite({
          tx,
          adapter,
          plugins,
          target: input.target,
          runId: input.runId,
          repoRoot: input.repoRoot,
          changedPageIds: input.changedPageIds,
          onProgress: (p) => emit({ kind: "progress", ...p }),
        }),
    );
    emit({ kind: "done", ...result });
  } finally {
    lines.close();
    await adapter.close();
  }
}

main()
  // The admin keeps stdin open for plugin answers; leave explicitly.
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    emit({ kind: "error", message });
    process.exit(1);
  });

// SPDX-License-Identifier: MPL-2.0

/**
 * The static generator as a subprocess of the admin (P6.2): spawned by the
 * deploy ops only, fed its config on stdin, streaming JSON-line events on
 * stdout — progress, the plugin calls it asks the admin's plugin host
 * (#605), and its final done / error event.
 *
 * The generator reads cms_admin over its own connections. The admin side
 * holds none while it waits (#1211): progress lands on the committed run
 * row through short `deploy.update_progress` ops.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  decodeBuildPayload,
  encodeBuildPayload,
  serveBuildPluginCall,
} from "@caelo-cms/plugin-host";
import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import { databaseUrlFromEnv, type ExecutionContext, phaseTimingSchema } from "@caelo-cms/shared";
import type { DeployTarget } from "@caelo-cms/static-generator";
import { z } from "zod";
import { SYSTEM_ACTOR_ID } from "../audit.js";
import { ProgressThrottle } from "./progress-throttle.js";
import { unpublishedLinkTargetSchema } from "./unpublished-links.js";

/** Minimum gap between two progress writes of one build (#1003). */
const PROGRESS_INTERVAL_MS = 1000;

/**
 * The system actor for a run's internal steps (deploy.begin_run,
 * deploy.update_progress, …), keeping the trigger's request id for log
 * correlation. Those ops are system callbacks: an AI-started Stage must
 * reach them too.
 */
export function systemContextOf(ctx: ExecutionContext): ExecutionContext {
  return { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: ctx.requestId };
}

/**
 * Resolve the path to the static-generator CLI. We look in three places
 * in order: an explicit env override, the workspace-relative path
 * `apps/static-generator/src/cli.ts` from the cwd, and a path relative to
 * this package. The cwd path is what the admin process uses (it runs from
 * apps/admin/, so we walk up); the package-relative path is the fallback
 * for tests that pass a tmpdir as `repoRoot`.
 */
export function resolveGeneratorCli(): string {
  const override = process.env.CAELO_GENERATOR_CLI;
  if (override) return override;
  // Walk up from cwd until we find apps/static-generator/src/cli.ts.
  // This survives `cd` into a subdir (the test runner's cwd) without
  // requiring the test to plumb a workspace path in.
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "apps/static-generator/src/cli.ts");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(import.meta.dirname, "../../../../apps/static-generator/src/cli.ts");
}

interface SubprocessProgress {
  kind: "progress";
  pagesDone: number;
  pagesTotal: number;
}

/**
 * The generator's final event. Parsed (not cast) — it crosses a process
 * boundary, and its link report feeds the Stage warning (#724).
 */
const subprocessDoneSchema = z.object({
  kind: z.literal("done"),
  pageCount: z.number().int(),
  fileCount: z.number().int(),
  durationMs: z.number(),
  phases: z.array(phaseTimingSchema),
  buildDir: z.string(),
  unpublishedLinkTargets: z.array(unpublishedLinkTargetSchema),
});

/** What a finished generator run reports. */
export type GeneratorDone = z.infer<typeof subprocessDoneSchema>;

interface SubprocessError {
  kind: "error";
  message: string;
}
/** #605 — the generator asks the admin's plugin host (build-services.ts). */
interface SubprocessPluginCall {
  kind: "plugin-call";
  id: number;
  method: unknown;
  args: unknown;
}
/**
 * #1211 — the generator started mirroring the build into `current/`: it
 * ignores SIGTERM from now on (static-generator serving-guard.ts), and a
 * `done` after it means the build is served.
 */
interface SubprocessServing {
  kind: "serving";
}
type SubprocessEvent =
  | SubprocessProgress
  | SubprocessServing
  | GeneratorDone
  | SubprocessError
  | SubprocessPluginCall;

/** Everything one generator run is told on stdin. */
export interface GeneratorRunArgs {
  readonly cliPath: string;
  readonly runId: string;
  readonly target: DeployTarget;
  readonly repoRoot: string;
  /** P13 ideas-pass — incremental deploy: only these pages are re-baked. */
  readonly changedPageIds?: ReadonlyArray<string>;
  /** Epic #1107 — changed shared lists / list types: the generator adds
   *  every page whose render dependencies they reach. */
  readonly changedListIds?: ReadonlyArray<string>;
  readonly changedListTypeIds?: ReadonlyArray<string>;
  /** #650 — render this origin instead of the stored site URL. */
  readonly siteBaseUrlOverride?: string;
  /** Epic #1107 — first-publication time of never-live pages (see generateSite). */
  readonly publishAt: string;
  /**
   * false: leave `<outDir>/current/` alone — #650 Publish live's rebuild,
   * and #1003 every build on a publisher that does not serve `current/`.
   */
  readonly syncCurrent?: boolean;
  /**
   * #1211 — how many older builds to keep under `<outDir>/builds/`. 0: none
   * are pruned by the generator — on a cloud publisher the admin deletes
   * each build once it is uploaded, so nothing accumulates in `/tmp`
   * (memory on Cloud Run). Omitted: the generator's default retention.
   */
  readonly retainBuilds?: number;
  /**
   * #1211 — kills the generator (SIGTERM) when it aborts, until the
   * generator reports that it mirrors the build into `current/`: from then
   * on the build is being published and runs to its end.
   */
  readonly signal?: AbortSignal;
}

/** The outcome of {@link runGenerator}. */
export type GeneratorOutcome =
  | { readonly ok: true; readonly result: GeneratorDone }
  | { readonly ok: false; readonly message: string; readonly stderr: string };

/**
 * Spawn the generator CLI and stream its JSON-line stdout. Progress lands
 * on the committed run row (throttled, as the system actor); returns the
 * final done / error event. Aborting `args.signal` kills the subprocess and
 * resolves with a failure naming the abort reason.
 */
export async function runGenerator(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  args: GeneratorRunArgs,
): Promise<GeneratorOutcome> {
  // The generator gets the composed URLs on stdin, never on argv or env.
  const adminUrl = databaseUrlFromEnv(["ADMIN_DATABASE_URL"]);
  const publicUrl = databaseUrlFromEnv(["PUBLIC_ADMIN_DATABASE_URL", "PUBLIC_DATABASE_URL"]);
  if (!adminUrl || !publicUrl) {
    return { ok: false, message: "ADMIN_DATABASE_URL / PUBLIC_DATABASE_URL not set", stderr: "" };
  }
  if (args.signal?.aborted) {
    return { ok: false, message: abortMessage(args.signal), stderr: "" };
  }
  // #1003 — progress lands on the run row deploy.begin_run committed, at
  // most once per interval (it was one transaction per page), as the system
  // actor: update_progress is an internal callback whoever started the run.
  const progress = new ProgressThrottle<{ pagesDone: number; pagesTotal: number }>(
    (p) =>
      execute(registry, adapter, systemContextOf(ctx), "deploy.update_progress", {
        runId: args.runId,
        ...p,
      }),
    PROGRESS_INTERVAL_MS,
  );
  return await new Promise((respond) => {
    // The last progress is written before the caller finishes the run, so
    // no progress write can land after the run's final update.
    const finish = (r: GeneratorOutcome): void => {
      args.signal?.removeEventListener("abort", onAbort);
      void progress.flush().then(() => respond(r));
    };
    const child = spawn("bun", ["run", args.cliPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let aborted: string | null = null;
    function onAbort(): void {
      aborted = abortMessage(args.signal);
      child.kill("SIGTERM");
    }
    // Set once the generator reported it is writing `current/`: a stop
    // after that cannot undo the publication, so its `done` counts.
    let serving = false;
    args.signal?.addEventListener("abort", onAbort, { once: true });
    const stderrChunks: Buffer[] = [];
    let stdoutBuf = "";
    let finalEvent: GeneratorDone | SubprocessError | null = null;

    // The config is the first line; stdin then stays open for the answers
    // to the generator's plugin calls (#605) until the child exits.
    child.stdin.write(
      `${JSON.stringify({
        adminDatabaseUrl: adminUrl,
        publicDatabaseUrl: publicUrl,
        target: args.target,
        runId: args.runId,
        repoRoot: args.repoRoot,
        publishAt: args.publishAt,
        ...(args.changedPageIds && args.changedPageIds.length > 0
          ? { changedPageIds: [...args.changedPageIds] }
          : {}),
        ...(args.changedListIds && args.changedListIds.length > 0
          ? { changedListIds: [...args.changedListIds] }
          : {}),
        ...(args.changedListTypeIds && args.changedListTypeIds.length > 0
          ? { changedListTypeIds: [...args.changedListTypeIds] }
          : {}),
        ...(args.siteBaseUrlOverride ? { siteBaseUrlOverride: args.siteBaseUrlOverride } : {}),
        ...(args.syncCurrent === false ? { syncCurrent: false } : {}),
        ...(args.retainBuilds !== undefined ? { retainBuilds: args.retainBuilds } : {}),
      })}\n`,
    );
    // Answer one plugin call with THIS process's plugin host — the same
    // resolvers the editor preview uses. A failure is handed back to the
    // generator, which fails the build with it.
    const answerPluginCall = async (call: SubprocessPluginCall): Promise<void> => {
      let reply: Record<string, unknown>;
      try {
        const value = await serveBuildPluginCall(call.method, call.args);
        reply = { kind: "plugin-result", id: call.id, ok: true, value };
      } catch (e) {
        reply = {
          kind: "plugin-result",
          id: call.id,
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        };
      }
      if (!child.stdin.destroyed) child.stdin.write(`${encodeBuildPayload(reply)}\n`);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let nl = stdoutBuf.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        nl = stdoutBuf.indexOf("\n");
        if (line.length === 0) continue;
        let ev: SubprocessEvent;
        try {
          ev = decodeBuildPayload(line) as SubprocessEvent;
        } catch {
          continue;
        }
        if (ev.kind === "plugin-call") {
          void answerPluginCall(ev);
        } else if (ev.kind === "serving") {
          serving = true;
        } else if (ev.kind === "progress") {
          progress.offer({ pagesDone: ev.pagesDone, pagesTotal: ev.pagesTotal });
        } else if (ev.kind === "done") {
          const done = subprocessDoneSchema.safeParse(ev);
          finalEvent = done.success
            ? done.data
            : {
                kind: "error",
                message: `generator reported a malformed done event: ${done.error.message}`,
              };
        } else if (ev.kind === "error") {
          finalEvent = ev;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (e) => {
      finish({ ok: false, message: e.message, stderr: Buffer.concat(stderrChunks).toString() });
    });
    child.on("close", (code) => {
      if (!child.stdin.destroyed) child.stdin.end();
      const stderr = Buffer.concat(stderrChunks).toString();
      if (aborted !== null && !(serving && finalEvent?.kind === "done")) {
        finish({ ok: false, message: aborted, stderr });
      } else if (finalEvent && finalEvent.kind === "done") {
        finish({ ok: true, result: finalEvent });
      } else if (finalEvent && finalEvent.kind === "error") {
        finish({ ok: false, message: finalEvent.message, stderr });
      } else {
        finish({
          ok: false,
          message: `generator exited ${code} without a done event`,
          stderr,
        });
      }
    });
  });
}

/** The operator-facing text of an aborted run. */
export function abortMessage(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  const why = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  return `stopped before it finished${why ? ` (${why})` : ""}; nothing it built was published`;
}

// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — a build nobody waits for in a request runs inside the
 * request its carrier job holds open. Against a real Postgres with a stub
 * generator that builds at once or hangs on demand:
 *
 *   - a carried build runs inside its carrier's `run` report, and the
 *     request that asked for it reads the answer the op gives;
 *   - when the carrier's request ends first, the build stops, recorded as
 *     failed with that reason, and nothing it built is published;
 *   - a carrier that dies without a word is given up by the tick's
 *     backstop: the order and its run say where it ran and what to do next;
 *   - an order whose carrier never started is given up, never started late;
 *   - a build longer than its request limit stops loudly with that reason;
 *   - the operator's Stop reaches a carried build while its caller waits;
 *   - an agent's deploy_staging is carried: it answers "still running"
 *     past its wait, and the build goes on;
 *   - AWS / Azure refuse at once with their pending issue;
 *   - "where does my Stage stand" sees a Stage order before its run exists.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import {
  composeSiteHeaders,
  DEFAULT_SITE_SECURITY_POLICY,
  EMPTY_CSP_FACTS,
} from "@caelo-cms/shared";
import { SQL } from "bun";
import { describeError } from "../ai/tools/_describe-error.js";
import { deployStagingTool } from "../ai/tools/deploy-staging.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { runReportingJobBackstop } from "../reporting-jobs/backstop.js";
import { admitJobReport } from "../reporting-jobs/dispatch.js";
import { JOB_MAINS } from "../reporting-jobs/job-mains.js";
import { createJobReporter, type ReportTransport } from "../reporting-jobs/job-reporter.js";
import type { JobLauncher } from "../reporting-jobs/launcher.js";
import { runJobAttempt } from "../reporting-jobs/run-job.js";
import { carryBuild, executeBuild } from "./carry.js";

const SITE_HEADERS = composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, EMPTY_CSP_FACTS);

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000001574",
  actorKind: "human",
  requestId: "build-carrier-test",
};
const SYSTEM: ExecutionContext = { ...HUMAN, actorKind: "system" };

/** Like apps/static-generator's cli.ts: a one-file build, or a hang until killed. */
const STUB_GENERATOR = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
for await (const line of console) {
  const cfg = JSON.parse(line);
  const buildDir = join(resolve(cfg.repoRoot, cfg.target.outDir), "builds", cfg.runId);
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, "index.html"), "<p>stub</p>");
  console.log(JSON.stringify({ kind: "progress", pagesDone: 0, pagesTotal: 1 }));
  if (process.env.CAELO_TEST_STUB_GENERATOR === "hang") {
    await Bun.sleep(Number(process.env.CAELO_TEST_STUB_HANG_MS ?? "600000"));
    console.log(JSON.stringify({ kind: "error", message: "stub generator gave up" }));
    process.exit(1);
  }
  console.log(JSON.stringify({ kind: "done", pageCount: 1, fileCount: 1, durationMs: 1,
    phases: [], buildDir, peakRssMb: 1, unpublishedLinkTargets: [], crossVariantLinks: [],
    truncatedLists: [], securityHeaders: ${JSON.stringify(SITE_HEADERS)} }));
  process.exit(0);
}
`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(values)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const deps = () => ({ adapter, registry });

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx);
    });
  } finally {
    await sql.end();
  }
}

async function runRow(id: string) {
  const rows = (await withSql(
    (tx) => tx`SELECT status, error_message, lease_expires_at::text AS lease
                 FROM deploy_runs WHERE id = ${id}::uuid`,
  )) as { status: string; error_message: string | null; lease: string | null }[];
  return rows[0];
}

async function orderRow(id: string) {
  const rows = (await withSql(
    (tx) => tx`SELECT state, outcome, stop_requested_at IS NOT NULL AS stop_requested
                 FROM build_orders WHERE id = ${id}::uuid`,
  )) as {
    state: string;
    outcome: { ok: boolean; value?: unknown; error?: { message?: string }; givenUp?: boolean };
    stop_requested: boolean;
  }[];
  return rows[0];
}

async function jobRow(id: string) {
  const rows = (await withSql(
    (tx) => tx`SELECT state, attempt, execution, last_error FROM reporting_jobs
                 WHERE kind = 'build' AND subject_id = ${id}::uuid`,
  )) as { state: string; attempt: number; execution: string | null; last_error: string | null }[];
  return rows[0];
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 800; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * A carrier in this process whose `run` report is carried by a request the
 * test can end (`gone`), as a carrier job's container dying would.
 */
function endableCarrier(gone: AbortSignal): JobLauncher {
  return {
    label: "the test carrier",
    async launch(order) {
      const transport: ReportTransport = {
        label: "test",
        async send(envelope) {
          const admission = await admitJobReport(deps(), {
            kind: order.kind,
            token: order.token,
            bodyText: JSON.stringify(envelope),
          });
          if ("refused" in admission) return admission.refused;
          return admission.admitted.run(envelope.action === "run" ? gone : undefined);
        },
      };
      void runJobAttempt(createJobReporter(order, transport), JOB_MAINS.build, 60_000).catch(
        () => undefined,
      );
      return "test-carrier-1";
    },
  };
}

/** A carrier that is started and then never reports (its container died at once). */
const deadCarrier: JobLauncher = {
  label: "the test",
  async launch() {
    return "test-execution-dead";
  },
};

async function ensureOperator(): Promise<void> {
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name)
             VALUES (${HUMAN.actorId}::uuid, 'human', 'build-carrier operator')
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash)
             VALUES (${HUMAN.actorId}::uuid, 'build-carrier@test.local', 'test-only')
             ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id)
             SELECT ${HUMAN.actorId}::uuid, id FROM roles WHERE name = 'owner'
             ON CONFLICT DO NOTHING`;
  });
}

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "caelo-build-carrier-"));
  const stub = join(testRoot, "stub-generator.ts");
  await writeFile(stub, STUB_GENERATOR);
  setEnv({
    CAELO_GENERATOR_CLI: stub,
    CAELO_PROVIDER: undefined,
    CAELO_SKIP_STAGING_SERVE_CHECK: "1",
    CAELO_TEST_STUB_GENERATOR: undefined,
  });
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await ensureOperator();
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await withSql(async (tx) => {
    await tx`DELETE FROM reporting_jobs WHERE kind = 'build'`;
    await tx`DELETE FROM build_orders`;
    await tx`DELETE FROM deploy_runs`;
  });
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("a build inside the request its carrier holds open (#1574)", () => {
  it("runs inside its carrier's report; the request that asked reads the answer the op gives", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: undefined });
    const r = await executeBuild(deps(), HUMAN, "deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    if (!r.ok) throw new Error(describeError(r.error));
    const { runId } = r.value as { runId: string; pageCount: number };
    expect((r.value as { pageCount: number }).pageCount).toBe(1);
    // The order's id is the run's id; the build is recorded as it always is.
    expect((await runRow(runId))?.status).toBe("succeeded");
    const order = await orderRow(runId);
    expect(order?.state).toBe("done");
    expect(order?.outcome.ok).toBe(true);
    // One attempt of the carrier, in this process (no launcher registered).
    const job = await jobRow(runId);
    expect(job?.state).toBe("done");
    expect(job?.attempt).toBe(1);
    expect(job?.execution).toStartWith("in-process:");
  });

  it("stops the build when the carrier's request ends first: failed with that reason, nothing published", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: "hang", CAELO_TEST_STUB_HANG_MS: "20000" });
    const gone = new AbortController();
    const id = crypto.randomUUID();
    const pending = carryBuild(
      deps(),
      HUMAN,
      { kind: "deploy.trigger", input: { targetName: "staging", repoRoot: testRoot } },
      { id, launcher: endableCarrier(gone.signal) },
    );
    await until(async () => (await runRow(id))?.status === "running", "the carried build");
    gone.abort(new Error("the carrier's container went away"));
    const carried = await pending;
    expect(carried.state).toBe("done");
    if (carried.state !== "done") return;
    expect(carried.outcome.ok).toBe(false);
    const message = JSON.stringify(carried.outcome);
    expect(message).toContain("its build carrier job stopped");
    expect(message).toContain("nothing it built was published");
    const run = await runRow(id);
    expect(run?.status).toBe("failed");
    expect(run?.error_message).toContain("its build carrier job stopped");
    expect(run?.lease).toBeNull();
  });

  it("gives up a carrier that dies without a word: the order and its run say where it ran and what next", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: undefined });
    const id = crypto.randomUUID();
    const carried = await carryBuild(
      deps(),
      HUMAN,
      { kind: "deploy.trigger", input: { targetName: "staging", repoRoot: testRoot } },
      { id, launcher: deadCarrier, waitMs: 200 },
    );
    expect(carried).toEqual({ state: "running", id });
    // As if the admin had started the build and its request froze when the
    // carrier died: a running run whose lease lapsed.
    await withSql(async (tx) => {
      await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, lease_expires_at)
               SELECT ${id}::uuid, t.id, ${HUMAN.actorId}::uuid, 'running',
                      now() - interval '1 second'
                 FROM deploy_targets t WHERE t.name = 'staging'`;
      // The carrier never reported: its first lease ran out.
      await tx`UPDATE reporting_jobs SET lease_until = now() - interval '1 second'
               WHERE kind = 'build' AND subject_id = ${id}::uuid`;
    });
    const summary = await runReportingJobBackstop(deps(), { launcher: deadCarrier });
    expect(summary).toContain("build: 1 given-up");
    const order = await orderRow(id);
    expect(order?.state).toBe("done");
    expect(order?.outcome.givenUp).toBe(true);
    expect(order?.outcome.error?.message).toContain("test-execution-dead");
    expect(order?.outcome.error?.message).toContain("start the build again");
    const run = await runRow(id);
    expect(run?.status).toBe("failed");
    expect(run?.error_message).toContain("test-execution-dead");
    expect((await jobRow(id))?.state).toBe("done");
  });

  it("gives up an order whose carrier never started, and never starts it late", async () => {
    const id = crypto.randomUUID();
    const created = await execute(registry, adapter, SYSTEM, "build_orders.create", {
      id,
      kind: "deploy.promote",
      input: { fromTarget: "staging", toTarget: "production" },
      actor: { actorId: HUMAN.actorId, actorKind: "human", requestId: "lost-start" },
      maxRunSeconds: null,
    });
    if (!created.ok) throw new Error(describeError(created.error));
    await withSql(
      (tx) =>
        tx`UPDATE build_orders SET created_at = now() - interval '5 minutes' WHERE id = ${id}::uuid`,
    );
    const launched: string[] = [];
    const watching: JobLauncher = {
      label: "the test",
      async launch(order) {
        launched.push(order.subjectId);
        return "test-late";
      },
    };
    expect(await runReportingJobBackstop(deps(), { launcher: watching })).toContain(
      "build: 1 given-up",
    );
    expect(launched).toEqual([]);
    const order = await orderRow(id);
    expect(order?.state).toBe("done");
    expect(order?.outcome.error?.message).toContain("never started");
    expect(order?.outcome.error?.message).toContain("Publish live again");
  });

  it("stops a build that would outlast its request limit, loudly, with that reason", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: "hang", CAELO_TEST_STUB_HANG_MS: "20000" });
    const r = await executeBuild(
      deps(),
      HUMAN,
      "deploy.trigger",
      { targetName: "staging", repoRoot: testRoot },
      { maxRunSeconds: 1 },
    );
    expect(r.ok).toBe(false);
    const message = r.ok ? "" : describeError(r.error);
    expect(message).toContain("the longest a build may run here");
    expect(message).toContain("Cloud Run's request limit");
    expect(message).toContain("nothing it built was published");
  });

  it("passes the operator's Stop on to a carried build while its caller waits", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: "hang", CAELO_TEST_STUB_HANG_MS: "20000" });
    const stop = new AbortController();
    const id = crypto.randomUUID();
    const pending = carryBuild(
      deps(),
      HUMAN,
      { kind: "deploy.trigger", input: { targetName: "staging", repoRoot: testRoot } },
      { id, waitMs: 20_000, signal: stop.signal },
    );
    await until(async () => (await runRow(id))?.status === "running", "the carried build");
    stop.abort(new Error("Stop"));
    const carried = await pending;
    expect(carried.state).toBe("done");
    expect(JSON.stringify(carried)).toContain("the operator stopped it");
    expect((await orderRow(id))?.stop_requested).toBe(true);
    expect((await runRow(id))?.status).toBe("failed");
  });

  it("carries an agent's deploy_staging: a quick build answers as before, a long one answers still running and goes on", async () => {
    setEnv({ CAELO_OUTPUT_ROOT: testRoot, CAELO_TEST_STUB_GENERATOR: undefined });
    try {
      // No operator browser on the call: an agent's.
      const toolCtx = { registry, adapter } as ToolContext;
      const quick = await deployStagingTool.handler(HUMAN, {}, toolCtx);
      expect(quick.ok).toBe(true);
      expect(quick.content).toContain('Staging "staging" rebuilt');
      setEnv({
        CAELO_TEST_STUB_GENERATOR: "hang",
        CAELO_TEST_STUB_HANG_MS: "1500",
        CAELO_STAGE_TOOL_WAIT_MS: "300",
      });
      const long = await deployStagingTool.handler(HUMAN, {}, toolCtx);
      expect(long.ok).toBe(true);
      expect(long.content).toContain("still running");
      const { runId } = long.value as { runId: string };
      // The build goes on in its carrier after the call answered, and ends.
      await until(async () => (await orderRow(runId))?.state === "done", "the carried build's end");
      expect((await runRow(runId))?.status).toBe("failed");
      expect((await runRow(runId))?.error_message).toContain("stub generator gave up");
    } finally {
      setEnv({ CAELO_OUTPUT_ROOT: undefined, CAELO_STAGE_TOOL_WAIT_MS: undefined });
    }
  });

  it("refuses at once on AWS and Azure, naming the issue it waits for", async () => {
    setEnv({ CAELO_PROVIDER: "aws", CAELO_TEST_STUB_GENERATOR: undefined });
    try {
      const r = await executeBuild(deps(), HUMAN, "deploy.trigger", {
        targetName: "staging",
        repoRoot: testRoot,
      });
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : describeError(r.error)).toContain("#749");
    } finally {
      setEnv({ CAELO_PROVIDER: undefined });
    }
  });

  it("shows a Stage order before its run exists, and how it ended when it never got one", async () => {
    const id = crypto.randomUUID();
    const created = await execute(registry, adapter, SYSTEM, "build_orders.create", {
      id,
      kind: "stage",
      input: { chatSessionIds: [crypto.randomUUID()], stagedBy: "other_agent" },
      actor: { actorId: HUMAN.actorId, actorKind: "human", requestId: "queued-stage" },
      maxRunSeconds: null,
    });
    if (!created.ok) throw new Error(describeError(created.error));
    const queued = await execute(registry, adapter, HUMAN, "deploy.stage_status", {
      deployRunId: id,
    });
    if (!queued.ok) throw new Error(describeError(queued.error));
    expect((queued.value as { runs: unknown[] }).runs).toEqual([
      expect.objectContaining({ runId: id, status: "queued", phase: "queued", eta: null }),
    ]);
    const given = await execute(registry, adapter, SYSTEM, "build_orders.give_up", {
      id,
      message: "its job was never started.",
    });
    if (!given.ok) throw new Error(describeError(given.error));
    const ended = await execute(registry, adapter, HUMAN, "deploy.stage_status", {
      deployRunId: id,
    });
    if (!ended.ok) throw new Error(describeError(ended.error));
    expect((ended.value as { runs: unknown[] }).runs).toEqual([
      expect.objectContaining({
        runId: id,
        status: "failed",
        error: expect.stringContaining("Stage again"),
      }),
    ]);
  });
});

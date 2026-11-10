// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1574 — a build nobody waits for in a request runs inside the
 * request its carrier job holds open. Against a real Postgres with a stub
 * generator that builds at once or hangs on demand:
 *
 *   - what the build would refuse at once is refused before any order is
 *     written or carrier started;
 *   - a carried build runs inside its carrier's `run` report, and the
 *     request that asked for it reads the answer the op gives — also when
 *     the first try to record that answer fails;
 *   - when the carrier's request ends first, the build stops, recorded as
 *     failed with that reason, and nothing it built is published;
 *   - an order given up while its build still runs asks that build to stop
 *     and ends with the build's own outcome; one whose run went through is
 *     read back as "went through, do not run again"; a run never starts for
 *     an order given up before it, and a give-up waits for a run that is
 *     starting;
 *   - a carrier that dies without a word is given up by the tick's
 *     backstop: the order and its run (the order's id) say where it ran and
 *     what to do next;
 *   - an order whose carrier never started is given up, never started late;
 *   - a build longer than its request limit stops loudly with that reason;
 *   - the operator's Stop reaches a carried build while its caller waits; a
 *     caller's request that merely ends does not stop it;
 *   - an agent's wait counts from its call, its carrier's start included:
 *     a stalled start answers "still running", and the order still settles
 *     (a late carrier runs it, a failed start gives it up); deploy_staging
 *     answers "still running" past the wait, and the build goes on;
 *   - without a carrier a person's button builds in its own request and
 *     says so, and an agent is refused with the step to re-run;
 *   - "where does my Stage stand" sees a Stage order before its run exists,
 *     and never a production build's.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, defineOperation, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import {
  composeSiteHeaders,
  DEFAULT_SITE_SECURITY_POLICY,
  EMPTY_CSP_FACTS,
  ok,
} from "@caelo-cms/shared";
import { SQL } from "bun";
import { z } from "zod";
import { OperatorStoppedError } from "../ai/chat-runner/agent-runs.js";
import { describeError } from "../ai/tools/_describe-error.js";
import { deployStagingTool } from "../ai/tools/deploy-staging.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { setDeployBridge } from "../ops/deploy.js";
import { beginRunInTx } from "../ops/deploy-run-lifecycle.js";
import { registerAdminOps } from "../register.js";
import { runReportingJobBackstop, sweepFinishedReportingJobs } from "../reporting-jobs/backstop.js";
import { admitJobReport } from "../reporting-jobs/dispatch.js";
import { inProcessJobLauncher } from "../reporting-jobs/in-process.js";
import { JOB_MAINS } from "../reporting-jobs/job-mains.js";
import { createJobReporter, type ReportTransport } from "../reporting-jobs/job-reporter.js";
import type { AdminJobDeps } from "../reporting-jobs/kind.js";
import type { JobLauncher } from "../reporting-jobs/launcher.js";
import { runJobAttempt } from "../reporting-jobs/run-job.js";
import { carryBuild, executeBuild, operatorStopOf } from "./carry.js";
import { stageOrderInputSchema } from "./order.js";
import { executeBuildOrder } from "./run-order.js";

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
const AI: ExecutionContext = { ...HUMAN, actorKind: "ai" };

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

const deps = (): AdminJobDeps => ({ adapter, registry });
const staging = () => ({ targetName: "staging", repoRoot: testRoot });

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

function createOrder(id: string, kind: string, input: Record<string, unknown>) {
  return execute(registry, adapter, SYSTEM, "build_orders.create", {
    id,
    kind,
    input,
    actor: { actorId: HUMAN.actorId, actorKind: "human", requestId: "build-carrier-test" },
    maxRunSeconds: null,
  });
}

/**
 * A carrier in this process whose `run` report is carried by a request the
 * test can end (`gone`), as a carrier job's container dying would.
 */
function endableCarrier(gone: AbortSignal, carrierDeps: AdminJobDeps = deps()): JobLauncher {
  return {
    label: "the test carrier",
    async launch(order) {
      const transport: ReportTransport = {
        label: "test",
        async send(envelope) {
          const admission = await admitJobReport(carrierDeps, {
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

/** A launcher that records what it was asked to start, and starts nothing. */
function watchingLauncher(): { launcher: JobLauncher; launched: string[] } {
  const launched: string[] = [];
  return {
    launched,
    launcher: {
      label: "the test",
      async launch(order) {
        launched.push(order.subjectId);
        return "test-watched";
      },
    },
  };
}

/**
 * This file's ops with `build_orders.finish` failing its first `failures`
 * calls, as a dropped database connection would.
 */
function withFlakyFinish(failures: number): { deps: AdminJobDeps; calls: () => number } {
  let calls = 0;
  const flaky = new Proxy(registry, {
    get(target, prop) {
      if (prop === "lookup") {
        return (name: string) => {
          const found = target.lookup(name);
          if (name !== "build_orders.finish" || !found.ok) return found;
          calls += 1;
          if (calls > failures) return found;
          return ok({
            ...found.value,
            handler: async () => {
              throw new Error("connection reset (test)");
            },
          });
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { deps: { adapter, registry: flaky }, calls: () => calls };
}

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
  it("refuses at once what the build would refuse: no order is written, no carrier started", async () => {
    await withSql(
      (tx) => tx`INSERT INTO deploy_targets (name, env, out_dir)
                 VALUES ('staging-empty', 'staging', ${join(testRoot, "staging-empty")})`,
    );
    try {
      const cases: {
        ctx: ExecutionContext;
        order: Parameters<typeof carryBuild>[2];
        says: string;
      }[] = [
        {
          // Nothing staged: Publish live has no build to copy.
          ctx: HUMAN,
          order: {
            kind: "deploy.promote",
            input: { fromTarget: "staging-empty", toTarget: "production" },
          },
          says: "no succeeded build to promote from 'staging-empty' — run Stage first",
        },
        {
          ctx: HUMAN,
          order: { kind: "deploy.trigger", input: { targetName: "nope" } },
          says: "target not found: nope",
        },
        {
          ctx: AI,
          order: { kind: "deploy.trigger", input: { targetName: "production" } },
          says: "production is built only by a human Publish live",
        },
        {
          ctx: HUMAN,
          order: {
            kind: "stage",
            input: { chatSessionIds: [crypto.randomUUID()], stagedBy: "operator" },
          },
          says: "is not one of your open chats",
        },
        {
          ctx: HUMAN,
          order: { kind: "deploy.execute_proposal", input: { proposalId: crypto.randomUUID() } },
          says: "this proposal is no longer pending",
        },
      ];
      for (const c of cases) {
        const id = crypto.randomUUID();
        const watched = watchingLauncher();
        const carried = await carryBuild(deps(), c.ctx, c.order, {
          id,
          launcher: watched.launcher,
          waitMs: 1_000,
        });
        expect(carried.state).toBe("done");
        if (carried.state !== "done") continue;
        expect(carried.outcome.ok).toBe(false);
        expect(JSON.stringify(carried.outcome)).toContain(c.says);
        expect(await orderRow(id)).toBeUndefined();
        expect(watched.launched).toEqual([]);
      }
    } finally {
      await withSql((tx) => tx`DELETE FROM deploy_targets WHERE name = 'staging-empty'`);
    }
  });

  it("runs inside its carrier's report; the request that asked reads the answer the op gives", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: undefined });
    const r = await executeBuild(deps(), HUMAN, "deploy.trigger", staging());
    if (!r.ok) throw new Error(describeError(r.error));
    expect(r.warning).toBeUndefined();
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

  it("records the build's outcome when the first try to record it fails", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: undefined });
    const flaky = withFlakyFinish(1);
    const id = crypto.randomUUID();
    const carried = await carryBuild(
      deps(),
      HUMAN,
      { kind: "deploy.trigger", input: staging() },
      { id, launcher: endableCarrier(new AbortController().signal, flaky.deps) },
    );
    expect(carried.state).toBe("done");
    if (carried.state !== "done") return;
    // The build's own answer, not a given-up one, after a second try.
    expect(carried.outcome.ok).toBe(true);
    expect(flaky.calls()).toBe(2);
    expect((await runRow(id))?.status).toBe("succeeded");
    expect((await orderRow(id))?.outcome.givenUp).toBeUndefined();
    expect((await jobRow(id))?.state).toBe("done");
  });

  it("stops the build when the carrier's request ends first: failed with that reason, nothing published", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: "hang", CAELO_TEST_STUB_HANG_MS: "20000" });
    const gone = new AbortController();
    const id = crypto.randomUUID();
    const pending = carryBuild(
      deps(),
      HUMAN,
      { kind: "deploy.trigger", input: staging() },
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

  it("asks a build still running to stop when its order is given up, and its caller hears the build's own end", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: "hang", CAELO_TEST_STUB_HANG_MS: "20000" });
    const id = crypto.randomUUID();
    const pending = carryBuild(
      deps(),
      HUMAN,
      { kind: "deploy.trigger", input: staging() },
      { id, launcher: endableCarrier(new AbortController().signal) },
    );
    await until(async () => (await runRow(id))?.status === "running", "the carried build");
    // The backstop gives the order up (its carrier stopped reporting) while
    // the build still runs in some admin request.
    const given = await execute(registry, adapter, SYSTEM, "build_orders.give_up", {
      id,
      message: "its job stopped reporting.",
    });
    if (!given.ok) throw new Error(describeError(given.error));
    // The order stays open: the build may still go through, so no failure
    // is told before it ends.
    expect(given.value).toEqual({ result: "stopping" });
    expect((await orderRow(id))?.state).toBe("running");
    const carried = await pending;
    expect(carried.state).toBe("done");
    if (carried.state !== "done") return;
    expect(carried.outcome.ok).toBe(false);
    expect(JSON.stringify(carried.outcome)).toContain("the build was given up");
    const run = await runRow(id);
    expect(run?.status).toBe("failed");
    expect(run?.error_message).toContain("the build was given up");
    expect(run?.error_message).not.toContain("the operator");
    expect(run?.lease).toBeNull();
    // Ended by its build, with the build's outcome.
    expect((await orderRow(id))?.outcome.givenUp).toBeUndefined();
  });

  it("reads back a run that went through when its carrier died before saying so: do not run it again", async () => {
    const id = crypto.randomUUID();
    const asked = executeBuild(deps(), HUMAN, "deploy.trigger", staging(), {
      id,
      launcher: deadCarrier,
    });
    await until(async () => (await jobRow(id))?.execution != null, "the carrier's start");
    // As if the carrier had taken the order and the build went through,
    // and the carrier died before the outcome was recorded.
    await withSql(async (tx) => {
      await tx`UPDATE build_orders SET state = 'running', started_at = now()
               WHERE id = ${id}::uuid`;
      await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, finished_at,
                                        page_count, file_count)
               SELECT ${id}::uuid, t.id, ${HUMAN.actorId}::uuid, 'succeeded', now(), 3, 4
                 FROM deploy_targets t WHERE t.name = 'staging'`;
      await tx`UPDATE reporting_jobs SET lease_until = now() - interval '1 second'
               WHERE kind = 'build' AND subject_id = ${id}::uuid`;
    });
    expect(await runReportingJobBackstop(deps(), { launcher: deadCarrier })).toContain(
      "build: 1 given-up",
    );
    const r = await asked;
    expect(r.ok).toBe(false);
    const message = r.ok ? "" : describeError(r.error);
    expect(message).toContain(`The build went through (run ${id})`);
    expect(message).toContain("Do not run it again");
    const order = await orderRow(id);
    expect(order?.outcome.ok).toBe(true);
    expect(order?.outcome.value).toMatchObject({ runId: id, pageCount: 3, recovered: true });
    expect((await runRow(id))?.status).toBe("succeeded");
  });

  it("never starts the run of an order given up before its run began", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: undefined });
    const id = crypto.randomUUID();
    const created = await createOrder(id, "deploy.trigger", { targetName: "staging" });
    if (!created.ok) throw new Error(describeError(created.error));
    const given = await execute(registry, adapter, SYSTEM, "build_orders.give_up", {
      id,
      message: "its job was never started.",
    });
    if (!given.ok) throw new Error(describeError(given.error));
    expect(given.value).toEqual({ result: "ended" });
    // A build that reaches its start anyway (its carrier took the order
    // just before the give-up) is refused for good.
    const late = await execute(registry, adapter, HUMAN, "deploy.trigger", {
      ...staging(),
      runId: id,
    });
    expect(late.ok).toBe(false);
    expect(late.ok ? "" : describeError(late.error)).toContain("given up before its run started");
    expect(await runRow(id)).toBeUndefined();
  });

  it("gives up a carrier that dies without a word: the order and its run say where it ran and what next", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: undefined });
    const id = crypto.randomUUID();
    const carried = await carryBuild(
      deps(),
      HUMAN,
      { kind: "deploy.trigger", input: staging() },
      { id, launcher: deadCarrier, waitMs: 200 },
    );
    expect(carried).toEqual({ state: "running", id });
    // The wait may end before the carrier's start does (it counts too).
    await until(async () => (await jobRow(id))?.execution != null, "the carrier's start");
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

  it("gives an approved proposal's build the order's id as its run's", async () => {
    const seen = new Map<string, string>();
    const recording = new OperationRegistry();
    for (const name of ["deploy.execute_proposal", "quality_audits.execute_proposal"]) {
      recording.register(
        defineOperation({
          name,
          readScope: "request",
          actorScope: ["human", "system"],
          database: "cms_admin",
          input: z.object({ proposalId: z.string().uuid(), runId: z.string().uuid() }).strict(),
          output: z.object({ runId: z.string() }),
          handler: async (_ctx, input) => {
            seen.set(name, input.runId);
            return ok({ runId: input.runId });
          },
        }),
      );
    }
    for (const kind of ["deploy.execute_proposal", "quality_audits.execute_proposal"] as const) {
      const orderId = crypto.randomUUID();
      const outcome = await executeBuildOrder(
        { adapter, registry: recording },
        HUMAN,
        orderId,
        { kind, input: { proposalId: crypto.randomUUID() } },
        new AbortController().signal,
      );
      expect(outcome).toEqual({ ok: true, value: { runId: orderId } });
      expect(seen.get(kind)).toBe(orderId);
    }
  });

  it("fails the run of an approved Publish live whose carrier died: the run its order names", async () => {
    const id = crypto.randomUUID();
    const created = await createOrder(id, "deploy.execute_proposal", {
      proposalId: crypto.randomUUID(),
    });
    if (!created.ok) throw new Error(describeError(created.error));
    await withSql(async (tx) => {
      await tx`UPDATE build_orders SET state = 'running', started_at = now()
               WHERE id = ${id}::uuid`;
      await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, lease_expires_at)
               SELECT ${id}::uuid, t.id, ${HUMAN.actorId}::uuid, 'running',
                      now() - interval '1 second'
                 FROM deploy_targets t WHERE t.name = 'production'`;
    });
    const given = await execute(registry, adapter, SYSTEM, "build_orders.give_up", {
      id,
      message: "its job stopped reporting.",
    });
    if (!given.ok) throw new Error(describeError(given.error));
    expect(given.value).toEqual({ result: "ended" });
    const run = await runRow(id);
    expect(run?.status).toBe("failed");
    expect(run?.error_message).toContain("its job stopped reporting.");
    expect(run?.error_message).toContain("Publish live again");
    const order = await orderRow(id);
    expect(order?.state).toBe("done");
    expect(order?.outcome.givenUp).toBe(true);
  });

  it("gives up an order whose carrier never started, and never starts it late", async () => {
    const id = crypto.randomUUID();
    const created = await createOrder(id, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
    });
    if (!created.ok) throw new Error(describeError(created.error));
    await withSql(
      (tx) =>
        tx`UPDATE build_orders SET created_at = now() - interval '5 minutes' WHERE id = ${id}::uuid`,
    );
    const watched = watchingLauncher();
    expect(await runReportingJobBackstop(deps(), { launcher: watched.launcher })).toContain(
      "build: 1 given-up",
    );
    expect(watched.launched).toEqual([]);
    const order = await orderRow(id);
    expect(order?.state).toBe("done");
    expect(order?.outcome.error?.message).toContain("never started");
    expect(order?.outcome.error?.message).toContain("Publish live again");
  });

  it("stops a build that would outlast its request limit, loudly, with that reason", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: "hang", CAELO_TEST_STUB_HANG_MS: "20000" });
    const r = await executeBuild(deps(), HUMAN, "deploy.trigger", staging(), {
      maxRunSeconds: 1,
    });
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
      { kind: "deploy.trigger", input: staging() },
      { id, waitMs: 20_000, stopSignal: operatorStopOf(stop.signal) },
    );
    await until(async () => (await runRow(id))?.status === "running", "the carried build");
    stop.abort(new OperatorStoppedError());
    const carried = await pending;
    expect(carried.state).toBe("done");
    expect(JSON.stringify(carried)).toContain("the operator stopped it");
    expect((await orderRow(id))?.stop_requested).toBe(true);
    expect((await runRow(id))?.status).toBe("failed");
  });

  it("leaves a carried build to its carrier when its caller's request merely ends", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: "hang", CAELO_TEST_STUB_HANG_MS: "1500" });
    const request = new AbortController();
    const id = crypto.randomUUID();
    const pending = carryBuild(
      deps(),
      HUMAN,
      { kind: "deploy.trigger", input: staging() },
      { id, waitMs: 20_000, stopSignal: operatorStopOf(request.signal) },
    );
    await until(async () => (await runRow(id))?.status === "running", "the carried build");
    // The MCP client gave up waiting: not the operator's Stop.
    request.abort(new Error("the client went away"));
    const carried = await pending;
    expect(carried.state).toBe("done");
    const said = JSON.stringify(carried);
    // The build ran to its own end (the stub's failure after its hang).
    expect(said).toContain("stub generator gave up");
    expect(said).not.toContain("operator");
    expect((await orderRow(id))?.stop_requested).toBe(false);
  });

  it("counts an agent's wait from its call, its carrier's start included; a late carrier still runs the build", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: undefined });
    const id = crypto.randomUUID();
    const inProcess = inProcessJobLauncher(deps(), "build");
    // A Cloud Run start that stalls for 3 s, then runs.
    const late: JobLauncher = {
      label: "the test",
      async launch(order) {
        await Bun.sleep(3_000);
        return inProcess.launch(order);
      },
    };
    const asked = Date.now();
    const carried = await carryBuild(
      deps(),
      HUMAN,
      { kind: "deploy.trigger", input: staging() },
      { id, launcher: late, waitMs: 1_000 },
    );
    const took = Date.now() - asked;
    expect(carried).toEqual({ state: "running", id });
    // Waiting for the start would answer after 3 s at the earliest.
    expect(took).toBeLessThan(2_500);
    // The start goes on without its caller, and its carrier runs the build.
    await until(async () => (await orderRow(id))?.state === "done", "the late carrier's build");
    expect((await orderRow(id))?.outcome.ok).toBe(true);
    expect((await runRow(id))?.status).toBe("succeeded");
  });

  it("ends the order when its stalled start fails after its caller stopped waiting", async () => {
    const id = crypto.randomUUID();
    let failLaunch!: (e: Error) => void;
    const stalled: JobLauncher = {
      label: "the test",
      launch: () =>
        new Promise<string>((_, reject) => {
          failLaunch = reject;
        }),
    };
    const asked = Date.now();
    const carried = await carryBuild(
      deps(),
      HUMAN,
      { kind: "deploy.trigger", input: staging() },
      { id, launcher: stalled, waitMs: 1_000 },
    );
    expect(carried).toEqual({ state: "running", id });
    expect(Date.now() - asked).toBeLessThan(2_500);
    expect((await orderRow(id))?.state).toBe("queued");
    failLaunch(new Error("Cloud Run answered 503"));
    await until(async () => (await orderRow(id))?.state === "done", "the given-up order");
    const order = await orderRow(id);
    expect(order?.outcome.givenUp).toBe(true);
    expect(order?.outcome.error?.message).toContain("Cloud Run answered 503");
    expect((await jobRow(id))?.state).toBe("done");
  });

  it("orders a run's start and its order's give-up: the give-up waits for the run, then asks it to stop", async () => {
    const id = crypto.randomUUID();
    const created = await createOrder(id, "deploy.trigger", { targetName: "staging" });
    if (!created.ok) throw new Error(describeError(created.error));
    const claimed = await execute(registry, adapter, SYSTEM, "build_orders.claim", { id });
    if (!claimed.ok) throw new Error(describeError(claimed.error));
    const targets = (await withSql(
      (tx) => tx`SELECT id::text AS id FROM deploy_targets WHERE name = 'staging'`,
    )) as { id: string }[];
    // A run's start (deploy.trigger's first step) that has written its row
    // and not committed it yet.
    let rowWritten!: () => void;
    const written = new Promise<void>((resolve) => {
      rowWritten = resolve;
    });
    let commit!: () => void;
    const committing = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const holding = new OperationRegistry();
    holding.register(
      defineOperation({
        name: "test.start_run_and_hold",
        readScope: "request",
        actorScope: ["human"],
        database: "cms_admin",
        input: z.object({}).strict(),
        output: z.object({}),
        handler: async (_ctx, _input, tx) => {
          await beginRunInTx(tx, {
            runId: id,
            targetId: targets[0]?.id ?? "",
            actorId: HUMAN.actorId,
            startedAt: new Date().toISOString(),
            renderFingerprint: null,
            caeloVersion: null,
            pluginProblems: null,
            buildKind: "site",
            baseRunId: null,
            leaseTtlMs: 120_000,
          });
          rowWritten();
          await committing;
          return ok({});
        },
      }),
    );
    const start = execute(holding, adapter, HUMAN, "test.start_run_and_hold", {});
    try {
      await written;
      const givingUp = execute(registry, adapter, SYSTEM, "build_orders.give_up", {
        id,
        message: "its job stopped reporting.",
      });
      // It waits for the start's transaction instead of judging the order
      // without the run.
      expect(
        await Promise.race([givingUp.then(() => "decided"), Bun.sleep(750).then(() => "waiting")]),
      ).toBe("waiting");
      commit();
      expect((await start).ok).toBe(true);
      const given = await givingUp;
      if (!given.ok) throw new Error(describeError(given.error));
      // It sees the committed run: the run may still go live, so the order
      // stays open and the run is asked to stop.
      expect(given.value).toEqual({ result: "stopping" });
      const order = await orderRow(id);
      expect(order?.state).toBe("running");
      expect(order?.stop_requested).toBe(true);
    } finally {
      commit();
      await start;
      await withSql(
        (tx) => tx`UPDATE deploy_runs
                      SET status = 'failed', finished_at = clock_timestamp(),
                          lease_expires_at = NULL, error_message = 'the test is over'
                    WHERE id = ${id}::uuid AND status = 'running'`,
      );
      await execute(registry, adapter, SYSTEM, "build_orders.give_up", { id, message: "test." });
    }
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

  it("sweeps finished orders after their retention with the job rows, and keeps the rest", async () => {
    const old = crypto.randomUUID();
    const recent = crypto.randomUUID();
    for (const id of [old, recent]) {
      const created = await createOrder(id, "deploy.trigger", { targetName: "staging" });
      if (!created.ok) throw new Error(describeError(created.error));
      await execute(registry, adapter, SYSTEM, "build_orders.give_up", { id, message: "test." });
    }
    await withSql(
      (tx) =>
        tx`UPDATE build_orders SET finished_at = now() - interval '8 days' WHERE id = ${old}::uuid`,
    );
    expect(await sweepFinishedReportingJobs(deps())).toBeGreaterThanOrEqual(1);
    expect(await orderRow(old)).toBeUndefined();
    expect((await orderRow(recent))?.state).toBe("done");
  });

  it("takes a Stage of more than 100 chats when it is ordered, and refuses a malformed one there", async () => {
    const id = crypto.randomUUID();
    const many = Array.from({ length: 120 }, () => crypto.randomUUID());
    const created = await createOrder(id, "stage", { chatSessionIds: many, stagedBy: "operator" });
    if (!created.ok) throw new Error(describeError(created.error));
    // The carrier reads it back with the same schema, so it runs too.
    expect(stageOrderInputSchema.safeParse({ chatSessionIds: many, stagedBy: "operator" })).toEqual(
      expect.objectContaining({ success: true }),
    );
    const malformed = await createOrder(crypto.randomUUID(), "stage", {
      chatSessionIds: [],
      stagedBy: "operator",
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.ok ? "" : describeError(malformed.error)).toContain(
      "a Stage names the chats to stage",
    );
    await execute(registry, adapter, SYSTEM, "build_orders.give_up", { id, message: "test." });
  });

  it("without a carrier, builds a person's button in its own request and says so", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: undefined });
    const id = crypto.randomUUID();
    const r = await executeBuild(deps(), HUMAN, "deploy.trigger", staging(), {
      id,
      unavailable: "the test install has no carrier",
    });
    if (!r.ok) throw new Error(describeError(r.error));
    expect(r.warning).toContain("This build ran inside your request");
    expect(r.warning).toContain("the test install has no carrier");
    expect((r.value as { runId: string }).runId).toBe(id);
    expect((await runRow(id))?.status).toBe("succeeded");
    // No order, no carrier.
    expect(await orderRow(id)).toBeUndefined();
    expect(await jobRow(id)).toBeUndefined();
  });

  it("without a carrier on Google Cloud, refuses an agent with the upgrade step that sets it up", async () => {
    setEnv({
      CAELO_PROVIDER: "gcp",
      CAELO_BUILD_CARRIER_JOB: undefined,
      CAELO_TEST_STUB_GENERATOR: undefined,
    });
    try {
      const id = crypto.randomUUID();
      const carried = await carryBuild(
        deps(),
        HUMAN,
        { kind: "deploy.trigger", input: staging() },
        { id, waitMs: 1_000 },
      );
      expect(carried.state).toBe("done");
      const said = JSON.stringify(carried);
      expect(said).toContain("Nothing was built");
      expect(said).toContain("CAELO_BUILD_CARRIER_JOB");
      expect(said).toContain("Ensuring the build carrier");
      expect(await orderRow(id)).toBeUndefined();
      expect(await runRow(id)).toBeUndefined();
    } finally {
      setEnv({ CAELO_PROVIDER: undefined });
    }
  });

  it("refuses an agent at once on AWS and Azure, naming the issue it waits for", async () => {
    setEnv({ CAELO_PROVIDER: "aws", CAELO_TEST_STUB_GENERATOR: undefined });
    try {
      const id = crypto.randomUUID();
      const carried = await carryBuild(
        deps(),
        HUMAN,
        { kind: "deploy.trigger", input: staging() },
        { id, waitMs: 1_000 },
      );
      expect(carried.state).toBe("done");
      const said = JSON.stringify(carried);
      expect(said).toContain("Nothing was built");
      expect(said).toContain("#749");
      expect(await orderRow(id)).toBeUndefined();
    } finally {
      setEnv({ CAELO_PROVIDER: undefined });
    }
  });

  it("shows a Stage order before its run exists, and how it ended when it never got one", async () => {
    const id = crypto.randomUUID();
    const created = await createOrder(id, "stage", {
      chatSessionIds: [crypto.randomUUID()],
      stagedBy: "other_agent",
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

  it("never reads a production build's order as a Stage", async () => {
    const production = crypto.randomUUID();
    const stagingBuild = crypto.randomUUID();
    for (const [id, targetName] of [
      [production, "production"],
      [stagingBuild, "staging"],
    ] as const) {
      const created = await createOrder(id, "deploy.trigger", { targetName });
      if (!created.ok) throw new Error(describeError(created.error));
    }
    const status = async (id: string) => {
      const r = await execute(registry, adapter, HUMAN, "deploy.stage_status", { deployRunId: id });
      if (!r.ok) throw new Error(describeError(r.error));
      return (r.value as { runs: unknown[] }).runs;
    };
    expect(await status(production)).toEqual([]);
    expect(await status(stagingBuild)).toEqual([
      expect.objectContaining({ runId: stagingBuild, status: "queued" }),
    ]);
    for (const id of [production, stagingBuild]) {
      await execute(registry, adapter, SYSTEM, "build_orders.give_up", { id, message: "test." });
    }
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * #1211 / #1204 — a Stage holds no transaction while it builds, and a
 * caller that goes away never leaves anything held.
 *
 * Production 2026-10-28: a Stage ran 852 s instead of 34 s while its one
 * transaction pinned a pooled connection; the MCP client gave up after
 * 300 s and every later stage_changes in that session answered
 * `chat_busy`. These tests drive deploy.trigger and the Power-MCP
 * stage_changes path against a real Postgres with a stub generator that
 * builds instantly or hangs on demand:
 *
 *   - aborting a Stage mid-build kills the generator, ends the run failed
 *     with its lease cleared, and the next Stage runs at once;
 *   - stage_changes over Power-MCP answers "still running" within its
 *     wait while the build goes on, the chat's turn lease is free right
 *     away, and get_quality_audit later reports how the build ended;
 *   - a stop while a self-hosted build is mirrored into current/ cannot
 *     interrupt that publication: the run is recorded as published;
 *   - an uploading (cloud) publisher keeps no build on disk.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { removeUploadedBuild, retainedBuildsFor } from "../deploy/build-cleanup.js";
import type { StaticPublisher } from "../deploy/static-publisher.js";
import { setDeployBridge } from "../ops/deploy.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000001211",
  actorKind: "human",
  requestId: "deploy-run-lease-test",
};
const SYSTEM: ExecutionContext = { ...HUMAN, actorKind: "system" };

/**
 * Stands in for apps/static-generator/src/cli.ts: reads the config line,
 * writes a one-file build, reports progress, then either finishes or —
 * with CAELO_TEST_STUB_GENERATOR=hang — waits until it is killed or its
 * hang time is up.
 */
const STUB_GENERATOR = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
for await (const line of console) {
  const cfg = JSON.parse(line);
  const buildDir = join(resolve(cfg.repoRoot, cfg.target.outDir), "builds", cfg.runId);
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(join(buildDir, "index.html"), "<p>stub</p>");
  console.log(JSON.stringify({ kind: "progress", pagesDone: 0, pagesTotal: 1 }));
  if (process.env.CAELO_TEST_STUB_GENERATOR === "serve-slow") {
    // Like cli.ts once it mirrors the build into current/: a stop is ignored.
    process.on("SIGTERM", () => undefined);
    console.log(JSON.stringify({ kind: "serving" }));
    writeFileSync(join(cfg.repoRoot, "serving-" + cfg.runId), "");
    await Bun.sleep(1000);
  }
  if (process.env.CAELO_TEST_STUB_GENERATOR === "hang") {
    await Bun.sleep(Number(process.env.CAELO_TEST_STUB_HANG_MS ?? "600000"));
    console.log(JSON.stringify({ kind: "error", message: "stub generator gave up" }));
    process.exit(1);
  }
  console.log(JSON.stringify({ kind: "done", pageCount: 1, fileCount: 1, durationMs: 1,
    phases: [], buildDir, unpublishedLinkTargets: [], truncatedLists: [] }));
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

type RunRow = {
  id: string;
  status: string;
  error_message: string | null;
  lease_expires_at: string | null;
};

async function runRow(runId: string): Promise<RunRow | undefined> {
  const rows = (await withSql(
    (
      tx,
    ) => tx`SELECT id::text AS id, status, error_message, lease_expires_at::text AS lease_expires_at
               FROM deploy_runs WHERE id = ${runId}::uuid`,
  )) as RunRow[];
  return rows[0];
}

async function runningRuns(): Promise<RunRow[]> {
  return (await withSql(
    (
      tx,
    ) => tx`SELECT id::text AS id, status, error_message, lease_expires_at::text AS lease_expires_at
               FROM deploy_runs WHERE status = 'running'`,
  )) as RunRow[];
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 800; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function ensureOperator(): Promise<void> {
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name)
             VALUES (${HUMAN.actorId}::uuid, 'human', 'deploy-run-lease operator')
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash)
             VALUES (${HUMAN.actorId}::uuid, 'deploy-run-lease@test.local', 'test-only')
             ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id)
             SELECT ${HUMAN.actorId}::uuid, id FROM roles WHERE name = 'owner'
             ON CONFLICT DO NOTHING`;
  });
}

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "caelo-deploy-lease-"));
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
  configureMcpBridge({ adapter, registry, resolveProvider: async () => null });
  await ensureOperator();
});

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await withSql(async (tx) => {
    await tx`DELETE FROM mcp_tokens WHERE actor_id = ${HUMAN.actorId}::uuid`;
    await tx`DELETE FROM deploy_runs`;
  });
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("#1204 a Stage whose caller goes away leaves nothing held", () => {
  it("an aborted Stage kills its build, ends failed with its lease cleared, and the next Stage runs at once", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: "hang" });
    const stop = new AbortController();
    const runId = crypto.randomUUID();
    const pending = execute(
      registry,
      adapter,
      HUMAN,
      "deploy.trigger",
      { targetName: "staging", repoRoot: testRoot, runId },
      { signal: stop.signal },
    );
    // Building: the run is committed as running, with its lease.
    await until(async () => (await runRow(runId))?.status === "running", "the running Stage");
    expect((await runRow(runId))?.lease_expires_at).not.toBeNull();
    // While it builds, nothing sits in a transaction (#1211). A short op
    // (the progress write) is briefly idle between its statements; a held
    // transaction stays idle for as long as the build runs.
    await Bun.sleep(400);
    const open = (await withSql(
      (tx) => tx`SELECT count(*)::int AS n, string_agg(query, ' | ') AS q FROM pg_stat_activity
                 WHERE datname = 'cms_admin' AND pid <> pg_backend_pid()
                   AND state LIKE 'idle in transaction%'
                   AND clock_timestamp() - state_change > interval '300 milliseconds'`,
    )) as { n: number; q: string | null }[];
    expect(open[0]).toEqual({ n: 0, q: null });

    stop.abort(new Error("the operator pressed Stop"));
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.ok ? null : r.error)).toContain("stopped before it finished");
    const row = await runRow(runId);
    expect(row?.status).toBe("failed");
    expect(row?.error_message).toContain("the operator pressed Stop");
    expect(row?.lease_expires_at).toBeNull();
    expect(await runningRuns()).toEqual([]);

    // The same Stage again, right away: nothing blocks it.
    setEnv({ CAELO_TEST_STUB_GENERATOR: undefined });
    const again = await execute(registry, adapter, HUMAN, "deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    expect(again.ok).toBe(true);
    const againId = (again.ok ? again.value : null) as { runId: string } | null;
    expect((await runRow(againId?.runId ?? ""))?.status).toBe("succeeded");
    expect((await runRow(againId?.runId ?? ""))?.lease_expires_at).toBeNull();
  });

  it("stage_changes over Power-MCP answers 'still running' in time, frees the chat, and the build's end is readable", async () => {
    setEnv({
      CAELO_TEST_STUB_GENERATOR: "hang",
      CAELO_TEST_STUB_HANG_MS: "3000",
      CAELO_STAGE_TOOL_WAIT_MS: "800",
    });
    try {
      const minted = await execute(registry, adapter, HUMAN, "mcp_tokens.create", {
        displayName: "deploy-run-lease admin",
        scope: "admin",
      });
      if (!minted.ok) throw new Error(`mint: ${JSON.stringify(minted.error)}`);
      const token = (minted.value as { plaintextToken: string }).plaintextToken;
      const opened = await execute(registry, adapter, SYSTEM, "mcp.open_session", {
        plaintextToken: token,
        title: "deploy-run-lease session",
      });
      if (!opened.ok) throw new Error(`open_session: ${JSON.stringify(opened.error)}`);
      const { chatSessionId } = opened.value as { chatSessionId: string };

      const startedAt = Date.now();
      const staged = await execute(registry, adapter, SYSTEM, "mcp.execute_tool", {
        plaintextToken: token,
        chatSessionId,
        toolName: "stage_changes",
        args: { scope: "this_chat" },
      });
      if (!staged.ok) throw new Error(`stage_changes: ${JSON.stringify(staged.error)}`);
      const v = staged.value as { ok: boolean; content: string };
      // Answered within the wait, long before the build ends.
      expect(Date.now() - startedAt).toBeLessThan(2_500);
      expect(v.ok).toBe(true);
      expect(v.content).toContain("still running");
      const runId = /build run ([0-9a-f-]{36})/.exec(v.content)?.[1];
      expect(runId).toBeDefined();

      // The chat is free at once: no turn lease, and a write would not be chat_busy.
      const leases = (await withSql(
        (tx) =>
          tx`SELECT holder_id FROM chat_turn_leases WHERE chat_session_id = ${chatSessionId}::uuid`,
      )) as { holder_id: string }[];
      expect(leases).toEqual([]);
      const claim = await execute(registry, adapter, HUMAN, "chat.acquire_turn_lease", {
        chatSessionId,
        holderId: "next-write",
        ttlMs: 60_000,
      });
      expect(claim.ok && (claim.value as { acquired: boolean }).acquired).toBe(true);
      await execute(registry, adapter, HUMAN, "chat.release_turn_lease", {
        chatSessionId,
        holderId: "next-write",
      });

      // The build keeps running on the server; then it ends (the stub gives up).
      expect((await runRow(runId!))?.status).toBe("running");
      await until(async () => (await runRow(runId!))?.status === "failed", "the build's end");
      expect((await runRow(runId!))?.lease_expires_at).toBeNull();

      // The AI learns how it ended from get_quality_audit.
      const read = await execute(registry, adapter, SYSTEM, "mcp.execute_tool", {
        plaintextToken: token,
        chatSessionId,
        toolName: "get_quality_audit",
        args: { deployRunId: runId },
      });
      if (!read.ok) throw new Error(`get_quality_audit: ${JSON.stringify(read.error)}`);
      const audit = read.value as { ok: boolean; content: string };
      expect(audit.ok).toBe(false);
      expect(audit.content).toContain("failed");
      expect(audit.content).toContain("stub generator gave up");
    } finally {
      setEnv({
        CAELO_TEST_STUB_GENERATOR: undefined,
        CAELO_TEST_STUB_HANG_MS: undefined,
        CAELO_STAGE_TOOL_WAIT_MS: undefined,
      });
    }
  });
});

describe("#1211 a stop cannot interrupt a self-hosted publication", () => {
  it("a Stop while the build is mirrored into current/ lets it finish, and the run is recorded", async () => {
    setEnv({ CAELO_TEST_STUB_GENERATOR: "serve-slow" });
    const stop = new AbortController();
    const runId = crypto.randomUUID();
    try {
      const pending = execute(
        registry,
        adapter,
        HUMAN,
        "deploy.trigger",
        { targetName: "staging", repoRoot: testRoot, runId },
        { signal: stop.signal },
      );
      await until(
        async () => existsSync(join(testRoot, `serving-${runId}`)),
        "the build being served",
      );
      stop.abort(new Error("the operator pressed Stop"));
      const r = await pending;
      expect(r.ok).toBe(true);
      const row = await runRow(runId);
      expect(row?.status).toBe("succeeded");
      expect(row?.lease_expires_at).toBeNull();
    } finally {
      setEnv({ CAELO_TEST_STUB_GENERATOR: undefined });
    }
  });
});

describe("#1211 builds on an uploading publisher do not stay on disk", () => {
  const publisher = (servesCurrentDir: boolean) => ({ servesCurrentDir }) as StaticPublisher;

  it("an uploading publisher prunes nothing in the generator and deletes the build", async () => {
    const dir = join(testRoot, "cloud", "builds", "b1");
    await Bun.write(join(dir, "index.html"), "x");
    expect(retainedBuildsFor(publisher(false))).toBe(0);
    await removeUploadedBuild(publisher(false), dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("self-hosted keeps its retention and its builds", async () => {
    const dir = join(testRoot, "self", "builds", "b1");
    await Bun.write(join(dir, "index.html"), "x");
    expect(retainedBuildsFor(publisher(true))).toBeUndefined();
    await removeUploadedBuild(publisher(true), dir);
    expect(existsSync(dir)).toBe(true);
  });
});

describe("#1211 a rolling update cannot end a Stage of this release", () => {
  /** The previous release's begin_run sweep: it knows no lease, only the advisory lock. */
  async function previousReleaseSweep(runId: string): Promise<void> {
    await withSql(
      (tx) => tx`
        UPDATE deploy_runs
        SET status = 'failed', finished_at = clock_timestamp(), error_message = 'orphaned'
        WHERE id = ${runId}::uuid AND status = 'running'
          AND pg_try_advisory_xact_lock(hashtext(${"caelo:deploy-run:"} || ${runId}::text))`,
    );
  }

  async function leasedRun(lease: string): Promise<string> {
    const runId = crypto.randomUUID();
    await withSql(
      (tx) => tx`
        INSERT INTO deploy_runs (id, target_id, actor_id, status, lease_expires_at)
        SELECT ${runId}::uuid, id, ${HUMAN.actorId}::uuid, 'running',
               clock_timestamp() + ${lease}::interval
        FROM deploy_targets WHERE name = 'staging'`,
    );
    return runId;
  }

  it("a run whose lease is live stays running through the previous release's sweep", async () => {
    const runId = await leasedRun("2 minutes");
    await previousReleaseSweep(runId);
    expect((await runRow(runId))?.status).toBe("running");
    // This release ends it as usual: the update clears the lease.
    const r = await execute(registry, adapter, SYSTEM, "deploy.fail_run", {
      runId,
      message: "stopped",
      phaseTimings: [],
    });
    expect(r.ok).toBe(true);
    expect(await runRow(runId)).toMatchObject({ status: "failed", lease_expires_at: null });
  });

  it("a run whose lease lapsed is swept by either release", async () => {
    const runId = await leasedRun("-1 second");
    await previousReleaseSweep(runId);
    expect((await runRow(runId))?.status).toBe("failed");
  });
});

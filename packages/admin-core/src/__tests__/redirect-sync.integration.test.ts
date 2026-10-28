// SPDX-License-Identifier: MPL-2.0

/**
 * #1157 — a saved redirect answers on the live site without a build.
 *
 * Real Postgres (§6) and the real self-hosted publisher against a temporary
 * output root: the save pushes the redirects table into the `current/`
 * directory Caddy serves (the `_redirects.caddy` snippet its reload loop
 * watches), computed against the files of that live build; a failed push is
 * loud, recorded and retried; Publish live / rollback re-sync their target.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { bulkCreateRedirectsTool } from "../ai/tools/bulk-create-redirects.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { syncRedirectsInTx } from "../deploy/redirect-sync.js";
import { loadStaticPublisher, type StaticPublisher } from "../deploy/static-publisher.js";
import type { RedirectSyncTargetStatus } from "../ops/redirect_sync.js";
import {
  _redirectSyncPollOnceForTests,
  startRedirectSyncWorker,
  stopRedirectSyncWorker,
} from "../redirect-sync-worker.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "redirect-sync-int",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let root: string;
const savedEnv = {
  outputRoot: process.env.CAELO_OUTPUT_ROOT,
  provider: process.env.CAELO_PROVIDER,
};
const targets: Record<"staging" | "production", { id: string; outDir: string }> = {
  staging: { id: "", outDir: "" },
  production: { id: "", outDir: "" },
};
let savedBaseUrl: string | null = null;
const PROD_BUILD = "11111111-1111-4111-8111-111111111111";

async function sys<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

const currentDir = (env: "staging" | "production") => join(root, targets[env].outDir, "current");

async function serve(env: "staging" | "production", files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(currentDir(env), rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body, "utf8");
  }
}

async function snippet(env: "staging" | "production"): Promise<string> {
  return readFile(join(currentDir(env), "_redirects.caddy"), "utf8");
}

async function status(): Promise<Record<string, RedirectSyncTargetStatus>> {
  const r = await execute(registry, adapter, SYSTEM, "redirects.sync_status", {});
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const list = (r.value as { targets: RedirectSyncTargetStatus[] }).targets;
  return Object.fromEntries(list.map((t) => [t.env, t]));
}

async function createRedirects(rows: { fromPath: string; toPath: string }[]) {
  return execute(registry, adapter, SYSTEM, "redirects.create_many", {
    redirects: rows,
    upsert: true,
  });
}

async function seedProductionRun(): Promise<string> {
  return sys(async (tx) => {
    const rows = (await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id)
      VALUES (${targets.production.id}::uuid, ${SYSTEM.actorId}::uuid, 'succeeded', now(), now(), ${PROD_BUILD})
      RETURNING id::text AS id
    `) as { id: string }[];
    return rows[0]!.id;
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "caelo-redirect-sync-"));
  process.env.CAELO_OUTPUT_ROOT = root;
  delete process.env.CAELO_PROVIDER;
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const rows = await sys(
    (tx) =>
      tx`SELECT id::text AS id, env, out_dir FROM deploy_targets WHERE env IN ('staging', 'production')` as unknown as Promise<
        { id: string; env: "staging" | "production"; out_dir: string }[]
      >,
  );
  for (const r of rows) targets[r.env] = { id: r.id, outDir: r.out_dir };
  // The rollback re-derives robots.txt with the site's base URL.
  savedBaseUrl =
    (
      await sys(
        (tx) =>
          tx`SELECT site_base_url FROM site_defaults WHERE id = 1` as unknown as Promise<
            { site_base_url: string | null }[]
          >,
      )
    )[0]?.site_base_url ?? null;
  await sys(
    (tx) => tx`UPDATE site_defaults SET site_base_url = 'https://www.example.test' WHERE id = 1`,
  );
  // A huge interval: the tests drive the retry poll themselves.
  startRedirectSyncWorker({ adapter, registry, intervalMs: 24 * 60 * 60 * 1000 });
});

beforeEach(async () => {
  await rm(join(root, "output"), { recursive: true, force: true });
  await sys(async (tx) => {
    await tx`DELETE FROM redirects`;
    await tx`DELETE FROM redirect_syncs`;
    await tx`DELETE FROM redirect_sync_state`;
    await tx`DELETE FROM deploy_runs`;
  });
  await serve("production", { "index.html": "home", "about/index.html": "about" });
  await seedProductionRun();
});

afterAll(async () => {
  stopRedirectSyncWorker();
  await sys((tx) => tx`UPDATE site_defaults SET site_base_url = ${savedBaseUrl} WHERE id = 1`);
  await adapter.close();
  await rm(root, { recursive: true, force: true });
  if (savedEnv.outputRoot === undefined) delete process.env.CAELO_OUTPUT_ROOT;
  else process.env.CAELO_OUTPUT_ROOT = savedEnv.outputRoot;
  if (savedEnv.provider !== undefined) process.env.CAELO_PROVIDER = savedEnv.provider;
});

describe("redirect sync on save (#1157)", () => {
  it("a saved redirect is live on the served build without a build, and recorded", async () => {
    const r = await createRedirects([{ fromPath: "/old", toPath: "/about" }]);
    expect(r.ok).toBe(true);
    expect(await snippet("production")).toContain("/old");
    expect(await readFile(join(currentDir("production"), "_redirects"), "utf8")).toContain(
      "/old /about 301",
    );
    const s = await status();
    expect(s.production?.inSync).toBe(true);
    expect(s.production?.last).toMatchObject({
      status: "applied",
      trigger: "save",
      redirectCount: 1,
    });
    // Nothing published on staging: nothing to put redirects in front of.
    expect(s.staging?.inSync).toBe(true);
    expect(s.staging?.last?.status).toBe("nothing-live");
    const audited = await sys(
      (tx) =>
        tx`SELECT count(*)::int AS n FROM audit_events WHERE operation = 'redirects.sync_provider' AND succeeded` as unknown as Promise<
          { n: number }[]
        >,
    );
    expect(audited[0]?.n).toBeGreaterThanOrEqual(2);
  });

  it("the live page wins: a row whose path the served build has is left out", async () => {
    await createRedirects([
      { fromPath: "/about", toPath: "/elsewhere" },
      { fromPath: "/gone-page", toPath: "/about" },
    ]);
    const caddy = await snippet("production");
    expect(caddy).toContain("/gone-page");
    expect(caddy).not.toMatch(/\/about\s+\/elsewhere/);
    const rows = await sys(
      (tx) =>
        tx`SELECT shadowed_count FROM redirect_syncs WHERE target_id = ${targets.production.id}::uuid ORDER BY finished_at DESC LIMIT 1` as unknown as Promise<
          { shadowed_count: number }[]
        >,
    );
    expect(rows[0]?.shadowed_count).toBe(1);
  });

  it("names redirects whose target page is not published yet, and the AI tool says so", async () => {
    const r = await bulkCreateRedirectsTool.handler(
      SYSTEM,
      {
        items: [{ fromPath: "/promo", toPath: "/draft-page", statusCode: 301 }],
        upsert: false,
      },
      { adapter, registry } as ToolContext,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("live now");
    expect(r.content).toContain("/promo -> /draft-page/");
    expect(r.content).toContain("404 until Publish live");
    const s = await status();
    expect(s.production?.last?.unservedTargets).toEqual([
      { fromPath: "/promo", location: "/draft-page/" },
    ]);
  });

  it("an unchanged table writes nothing", async () => {
    await createRedirects([{ fromPath: "/old", toPath: "/about" }]);
    await createRedirects([{ fromPath: "/old", toPath: "/about" }]);
    const s = await status();
    expect(s.production?.last?.status).toBe("unchanged");
  });

  it("a failed push is loud, keeps the redirect, is shown and retried until live", async () => {
    await rm(currentDir("production"), { recursive: true, force: true });
    // The write is saved and answers ok; the AI tool result says why it is not live.
    const r = await bulkCreateRedirectsTool.handler(
      SYSTEM,
      { items: [{ fromPath: "/old", toPath: "/about", statusCode: 301 }], upsert: false },
      { adapter, registry } as ToolContext,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("production (production): NOT live yet");
    expect(r.content).toContain("serves no files");
    expect(r.content).toContain("Retried automatically");

    const saved = await sys(
      (tx) => tx`SELECT count(*)::int AS n FROM redirects` as unknown as Promise<{ n: number }[]>,
    );
    expect(saved[0]?.n).toBe(1);
    const behind = await status();
    expect(behind.production?.inSync).toBe(false);
    expect(behind.production?.lastError).toContain("serves no files");
    expect(behind.production?.nextAttemptAt).not.toBeNull();
    const bell = await execute(registry, adapter, SYSTEM, "notifications.aggregate", {});
    expect(bell.ok && (bell.value as { failedRedirectSyncs: number }).failedRedirectSyncs).toBe(1);

    // Not due yet: the poll leaves it alone.
    await serve("production", { "index.html": "home", "about/index.html": "about" });
    await _redirectSyncPollOnceForTests({ adapter, registry });
    expect((await status()).production?.inSync).toBe(false);

    await sys(
      (tx) => tx`UPDATE redirect_sync_state SET next_attempt_at = now() - interval '1 second'`,
    );
    await _redirectSyncPollOnceForTests({ adapter, registry });
    const live = await status();
    expect(live.production?.inSync).toBe(true);
    expect(live.production?.last).toMatchObject({ status: "applied", trigger: "retry" });
    expect(await snippet("production")).toContain("/old");
  });

  it("without the post-commit runner the target stays behind until the worker syncs it", async () => {
    stopRedirectSyncWorker();
    try {
      const r = await createRedirects([{ fromPath: "/old", toPath: "/about" }]);
      expect(r.ok).toBe(true);
      expect(existsSync(join(currentDir("production"), "_redirects.caddy"))).toBe(false);
      const s = await status();
      expect(s.production?.inSync).toBe(false);
      expect(s.production?.lastError).toBeNull();
      await _redirectSyncPollOnceForTests({ adapter, registry });
      expect((await status()).production?.inSync).toBe(true);
      expect(await snippet("production")).toContain("/old");
    } finally {
      startRedirectSyncWorker({ adapter, registry, intervalMs: 24 * 60 * 60 * 1000 });
    }
  });

  it("a retry only touches targets whose backoff has elapsed", async () => {
    stopRedirectSyncWorker();
    try {
      await createRedirects([{ fromPath: "/old", toPath: "/about" }]);
      // Production backs off for an hour; staging (nothing published) is due.
      await sys(
        (tx) => tx`
          UPDATE redirect_sync_state SET next_attempt_at = CASE
            WHEN target_id = ${targets.production.id}::uuid THEN now() + interval '1 hour'
            ELSE now() - interval '1 second' END
        `,
      );
      await _redirectSyncPollOnceForTests({ adapter, registry });
      const s = await status();
      expect(s.staging?.inSync).toBe(true);
      expect(s.production?.inSync).toBe(false);
      expect(s.production?.last).toBeNull();
    } finally {
      startRedirectSyncWorker({ adapter, registry, intervalMs: 24 * 60 * 60 * 1000 });
    }
  });

  it("staging that serves a build gets its own snippet", async () => {
    await serve("staging", { "index.html": "home staging" });
    await sys(
      (tx) => tx`
        INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id)
        VALUES (${targets.staging.id}::uuid, ${SYSTEM.actorId}::uuid, 'succeeded', now(), now(), 'stage-1')
      `,
    );
    await createRedirects([{ fromPath: "/old", toPath: "/" }]);
    expect(await snippet("staging")).toContain("/old");
    expect((await status()).staging?.last?.status).toBe("applied");
  });

  it("a deleted redirect stops answering on save", async () => {
    await createRedirects([{ fromPath: "/old", toPath: "/about" }]);
    const del = await execute(registry, adapter, SYSTEM, "redirects.delete_many", {
      fromPaths: ["/old"],
    });
    expect(del.ok).toBe(true);
    expect(await snippet("production")).not.toContain("/old");
  });

  it("a rollback puts its build live and then the redirects as saved now", async () => {
    await createRedirects([{ fromPath: "/old", toPath: "/about" }]);
    const runId = (
      await sys(
        (tx) =>
          tx`SELECT id::text AS id FROM deploy_runs WHERE target_id = ${targets.production.id}::uuid` as unknown as Promise<
            { id: string }[]
          >,
      )
    )[0]!.id;
    // The archived build carries the redirects of its own time: none.
    const archive = join(root, targets.production.outDir, "builds", PROD_BUILD);
    await mkdir(join(archive, "about"), { recursive: true });
    await writeFile(join(archive, "index.html"), "home v1");
    await writeFile(join(archive, "about/index.html"), "about v1");
    await writeFile(join(archive, "_redirects.caddy"), "# none\n");
    const r = await execute(registry, adapter, SYSTEM, "deploy.rollback", {
      targetName: "production",
      runId,
      repoRoot: root,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(await readFile(join(currentDir("production"), "index.html"), "utf8")).toBe("home v1");
    expect(await snippet("production")).toContain("/old");
    expect((await status()).production?.last).toMatchObject({ trigger: "rollback" });
  });

  it("a build re-sync puts the table as saved now on the new build, even when the target reads in sync", async () => {
    // A redirect saved while a build ran was pushed to the build served
    // before it; the new build carries the table from its start. Simulated:
    // the row is in the table, the target reads in sync, the served files
    // lack it.
    await sys(
      (tx) => tx`
        INSERT INTO redirects (from_path, to_path, status_code, created_by)
        VALUES ('/saved-during-build', '/about', 301, ${SYSTEM.actorId}::uuid)
      `,
    );
    expect((await status()).production?.inSync).toBe(true);
    const outcomes = await adapter.withAdminTransaction(SYSTEM, (tx) =>
      syncRedirectsInTx(tx, SYSTEM, { trigger: "build", targetIds: [targets.production.id] }),
    );
    expect(outcomes.map((o) => o.status)).toEqual(["applied"]);
    expect(await snippet("production")).toContain("/saved-during-build");
    expect((await status()).production?.last).toMatchObject({
      trigger: "build",
      status: "applied",
    });
  });

  it("#1211 a sync while a Stage publishes staging leaves staging's state row unlocked", async () => {
    // A Stage holds the staging-publication lease (it publishes without a
    // transaction); its finish step will write staging's sync state.
    const stageRun = crypto.randomUUID();
    await sys(async (tx) => {
      await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, lease_expires_at)
               VALUES (${stageRun}::uuid, ${targets.staging.id}::uuid, ${SYSTEM.actorId}::uuid,
                       'running', now() + interval '10 minutes')`;
      await tx`INSERT INTO deploy_leases (name, holder_run_id, acquired_at, expires_at)
               VALUES ('staging-publication', ${stageRun}::uuid, now(), now() + interval '10 minutes')
               ON CONFLICT (name) DO UPDATE SET holder_run_id = EXCLUDED.holder_run_id,
                 acquired_at = EXCLUDED.acquired_at, expires_at = EXCLUDED.expires_at`;
      await tx`INSERT INTO redirect_sync_state (target_id) VALUES (${targets.staging.id}::uuid)
               ON CONFLICT (target_id) DO NOTHING`;
    });
    const real = await loadStaticPublisher(undefined);
    let stagingRowFree: boolean | null = null;
    const publisher: StaticPublisher = {
      ...real,
      syncRedirects: async (args) => {
        // While the production push runs, the Stage could write its row.
        const probe = new SQL(ADMIN_URL!);
        try {
          stagingRowFree = await probe.begin(async (tx) => {
            await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
            try {
              await tx`SELECT 1 FROM redirect_sync_state
                       WHERE target_id = ${targets.staging.id}::uuid FOR UPDATE NOWAIT`;
              return true;
            } catch {
              return false;
            }
          });
        } finally {
          await probe.end();
        }
        return real.syncRedirects!(args);
      },
    };
    try {
      const outcomes = await adapter.withAdminTransaction(SYSTEM, (tx) =>
        syncRedirectsInTx(tx, SYSTEM, { trigger: "retry", publisher }),
      );
      expect(outcomes.map((o) => o.env)).toEqual(["production"]);
      expect(stagingRowFree).toBe(true);
    } finally {
      await sys(async (tx) => {
        await tx`UPDATE deploy_leases SET holder_run_id = NULL, acquired_at = NULL, expires_at = NULL
                 WHERE name = 'staging-publication'`;
        await tx`DELETE FROM deploy_runs WHERE id = ${stageRun}::uuid`;
      });
    }
  });

  it("a moved Firebase build moves only the run that recorded the copied version", async () => {
    await sys(
      (tx) => tx`
        UPDATE deploy_runs SET publish_summary = '{"provider":"gcp-firebase","location":"sites/s/versions/live-1"}'::jsonb
        WHERE target_id = ${targets.production.id}::uuid
      `,
    );
    // A newer-started run whose recorded version is a different one.
    await sys(
      (tx) => tx`
        INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id, publish_summary)
        VALUES (${targets.production.id}::uuid, ${SYSTEM.actorId}::uuid, 'succeeded',
                now() + interval '1 minute', now() - interval '1 hour', 'older-release',
                '{"provider":"gcp-firebase","location":"sites/s/versions/old-9"}'::jsonb)
      `,
    );
    const fake: StaticPublisher = {
      servesCurrentDir: false,
      publishStaging: () => Promise.reject(new Error("unused")),
      promoteToProduction: () => Promise.reject(new Error("unused")),
      rollback: () => Promise.reject(new Error("unused")),
      syncRedirects: async () => ({
        outcome: "applied",
        redirectCount: 0,
        goneCount: 0,
        shadowedCount: 0,
        unservedTargets: [],
        location: "sites/s/versions/live-2",
        movedServedBuild: { from: "sites/s/versions/live-1", to: "sites/s/versions/live-2" },
      }),
    };
    await adapter.withAdminTransaction(SYSTEM, (tx) =>
      syncRedirectsInTx(tx, SYSTEM, {
        trigger: "manual",
        targetIds: [targets.production.id],
        publisher: fake,
      }),
    );
    const locations = await sys(
      (tx) =>
        tx`SELECT build_id, publish_summary->>'location' AS location FROM deploy_runs
           WHERE target_id = ${targets.production.id}::uuid ORDER BY build_id` as unknown as Promise<
          { build_id: string; location: string }[]
        >,
    );
    expect(locations).toEqual([
      { build_id: PROD_BUILD, location: "sites/s/versions/live-2" },
      { build_id: "older-release", location: "sites/s/versions/old-9" },
    ]);
  });

  it("a publish whose re-sync fails leaves the target behind, so it is retried", async () => {
    await createRedirects([{ fromPath: "/old", toPath: "/about" }]);
    expect((await status()).production?.inSync).toBe(true);
    const runId = (
      await sys(
        (tx) =>
          tx`SELECT id::text AS id FROM deploy_runs WHERE target_id = ${targets.production.id}::uuid` as unknown as Promise<
            { id: string }[]
          >,
      )
    )[0]!.id;
    const archive = join(root, targets.production.outDir, "builds", PROD_BUILD);
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, "index.html"), "home v1");
    // A loop no host can serve, stored behind the ops' back: the re-sync
    // after the rollback fails.
    await sys(
      (tx) => tx`
        INSERT INTO redirects (from_path, to_path, status_code, created_by)
        VALUES ('/a', '/b', 301, ${SYSTEM.actorId}::uuid), ('/b', '/a', 301, ${SYSTEM.actorId}::uuid)
      `,
    );
    // Many failures in a row must not overflow the backoff.
    await sys((tx) => tx`UPDATE redirect_sync_state SET failed_attempts = 40`);
    const r = await execute(registry, adapter, SYSTEM, "deploy.rollback", {
      targetName: "production",
      runId,
      repoRoot: root,
    });
    expect(r.ok).toBe(true);
    const s = await status();
    expect(s.production?.inSync).toBe(false);
    expect(s.production?.lastError).toContain("form a loop");
    expect(s.production?.nextAttemptAt).not.toBeNull();
  });
});

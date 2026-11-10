// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — redirects are draft state: a save is a pending change (Staged by
 * default, Draft on request), served by staging and never by the live site
 * until Publish live or Go live now.
 *
 * Real Postgres (§6) and the real self-hosted publisher against a temporary
 * output root (Go live now reads the live build in `current/` and pushes the
 * snippet Caddy serves). Publish live, rollback and the scheduler tick are
 * in redirects-publish-live.integration.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { FilteredTool } from "../ai/chat-runner/tool-catalogue.js";
import { attachGatedExecute } from "../ai/tools/gated-tools.js";
import { proposeExternalRedirectTool } from "../ai/tools/propose-external-redirect.js";
import { applyPathMoveEffects } from "../ops/content/path-moves.js";
import { drainProjectionOnce, stagingPublicAdapter } from "../public-projection.js";
import { liveRedirectsFingerprint, loadLiveRedirectRows } from "../redirects/model.js";
import { releaseRedirectChanges } from "../redirects/release.js";
import { retargetPendingRedirects } from "../redirects/write.js";
import { registerAdminOps } from "../register.js";
import {
  liveRedirects,
  pendingRedirects,
  seedLiveRedirects,
  wipeRedirects,
} from "./fixtures/redirects.js";
import { ensureRoleUser } from "./fixtures/role-user.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const STAGING_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL || !STAGING_URL) throw new Error("DB URLs required");

const P = "/t1550";
const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const OWNER_ID = "15500000-0000-4000-8000-000000000001";
const REVIEWER_ID = "15500000-0000-4000-8000-000000000002";
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "t1550" };
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t1550-o" };
const REVIEWER: ExecutionContext = {
  actorId: REVIEWER_ID,
  actorKind: "human",
  requestId: "t1550-r",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "t1550-ai",
};

let adapter: DatabaseAdapter;
let staging: DatabaseAdapter;
let registry: OperationRegistry;
let root: string;
let productionOutDir = "";
let productionTargetId = "";
const savedProvider = process.env.CAELO_PROVIDER;

async function asSystem<T>(url: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(url);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function refusal(ctx: ExecutionContext, name: string, input: unknown): Promise<string> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (r.ok) throw new Error(`${name} should have been refused: ${JSON.stringify(r.value)}`);
  return JSON.stringify(r.error);
}

/** Serve `files` as the live build (what Go live now checks against). */
async function serveLive(files: Record<string, string>): Promise<void> {
  const current = join(root, productionOutDir, "current");
  await rm(current, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    const path = join(current, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, body, "utf8");
  }
}

const caddySnippet = () =>
  readFile(join(root, productionOutDir, "current", "_redirects.caddy"), "utf8");

/** Rows the projection published under `P`, per public database. */
async function published(url: string): Promise<{ live: string[]; staged: string[] }> {
  return asSystem(url, async (tx) => ({
    live: (
      (await tx`SELECT from_path FROM published_redirects WHERE from_path LIKE ${`${P}%`}
                ORDER BY from_path`) as { from_path: string }[]
    ).map((r) => r.from_path),
    staged: (
      (await tx`SELECT from_path || ' -> ' || COALESCE(to_path, '(remove)') AS r
                FROM published_redirect_changes WHERE from_path LIKE ${`${P}%`}
                ORDER BY address`) as { r: string }[]
    ).map((r) => r.r),
  }));
}

async function syncChangeRows(): Promise<number> {
  return asSystem(ADMIN_URL as string, async (tx) => {
    const rows = (await tx`SELECT count(*)::int AS n FROM redirect_changes`) as { n: number }[];
    return rows[0]?.n ?? 0;
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "caelo-1550-draft-"));
  delete process.env.CAELO_PROVIDER;
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  staging = stagingPublicAdapter(STAGING_URL);
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await ensureRoleUser(ADMIN_URL as string, OWNER_ID, "owner");
  await ensureRoleUser(ADMIN_URL as string, REVIEWER_ID, "reviewer");
  const target = await asSystem(ADMIN_URL as string, async (tx) => {
    const rows = (await tx`
      SELECT id::text AS id, out_dir FROM deploy_targets WHERE env = 'production' LIMIT 1`) as {
      id: string;
      out_dir: string;
    }[];
    return rows[0];
  });
  if (!target) throw new Error("no production target seeded");
  productionTargetId = target.id;
  productionOutDir = target.out_dir;
});

beforeEach(async () => {
  await wipeRedirects(ADMIN_URL as string, P);
  await asSystem(ADMIN_URL as string, async (tx) => {
    await tx`DELETE FROM redirect_pending_actions WHERE preview->>'summary' LIKE ${`%${P}%`}`;
    await tx`DELETE FROM redirect_changes`;
    await tx`DELETE FROM deploy_runs WHERE target_id = ${productionTargetId}::uuid`;
    await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id)
      VALUES (${productionTargetId}::uuid, ${SYSTEM_ID}::uuid, 'succeeded', now(), now(),
              '15501550-0000-4000-8000-000000000000')`;
  });
  await serveLive({ "index.html": "home", "t1550-live/index.html": "a live page" });
});

afterAll(async () => {
  await wipeRedirects(ADMIN_URL as string, P);
  await asSystem(ADMIN_URL as string, async (tx) => {
    await tx`DELETE FROM deploy_runs WHERE target_id = ${productionTargetId}::uuid`;
  });
  await drainProjectionOnce(adapter, staging);
  await staging.close();
  await adapter.close();
  await rm(root, { recursive: true, force: true });
  if (savedProvider !== undefined) process.env.CAELO_PROVIDER = savedProvider;
});

describe("a save is a pending change, never live (#1550)", () => {
  it("saves Staged by default and as a Draft with later; the live rules and the sync stay as they are", async () => {
    await seedLiveRedirects(ADMIN_URL as string, SYSTEM_ID, [
      { fromPath: `${P}-kept`, toPath: "/", statusCode: 301 },
    ]);
    await asSystem(ADMIN_URL as string, (tx) => tx`DELETE FROM redirect_changes`);
    const staged = await op<{ changes: { fromPath: string; outcome: string; state: string }[] }>(
      OWNER,
      "redirects.create_many",
      { redirects: [{ fromPath: `${P}-a`, toPath: "/t1550-live" }] },
    );
    expect(staged.changes).toEqual([
      expect.objectContaining({
        fromPath: `${P}-a`,
        outcome: "pending",
        state: "staged",
        revision: 1,
        replaced: null,
      }),
    ]);
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-b`, toPath: "/t1550-live" }],
      goLive: "later",
    });
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([
      { fromPath: `${P}-kept`, toPath: "/", statusCode: 301 },
    ]);
    expect(
      (await pendingRedirects(ADMIN_URL as string, P)).map((c) => [c.fromPath, c.state]),
    ).toEqual([
      [`${P}-a`, "staged"],
      [`${P}-b`, "draft"],
    ]);
    // Nothing for the provider sync to push: the live table did not change.
    expect(await syncChangeRows()).toBe(0);
  });

  it("staging gets the Staged changes through the projection; the live database and Drafts none", async () => {
    await seedLiveRedirects(ADMIN_URL as string, SYSTEM_ID, [
      { fromPath: `${P}-live`, toPath: "/", statusCode: 301 },
    ]);
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-s`, toPath: "/t1550-live" }],
    });
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-d`, toPath: "/t1550-live" }],
      goLive: "later",
    });
    await op(OWNER, "redirects.delete_many", { fromPaths: [`${P}-live`] });
    await drainProjectionOnce(adapter, staging);
    expect(await published(STAGING_URL as string)).toEqual({
      live: [`${P}-live`],
      staged: [`${P}-live -> (remove)`, `${P}-s -> /t1550-live`],
    });
    expect(await published(PUBLIC_URL as string)).toEqual({ live: [], staged: [] });
  });

  it("include, keep as draft and discard move a pending change; an automatic one cannot become a Draft", async () => {
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-x`, toPath: "/t1550-live" }],
      goLive: "later",
    });
    await op(OWNER, "redirects.set_changes_state", { fromPaths: [`${P}-x/`], action: "include" });
    expect((await pendingRedirects(ADMIN_URL as string, P))[0]?.state).toBe("staged");
    await op(OWNER, "redirects.set_changes_state", {
      fromPaths: [`${P}-x`],
      action: "keep_as_draft",
    });
    expect((await pendingRedirects(ADMIN_URL as string, P))[0]?.state).toBe("draft");
    await op(OWNER, "redirects.set_changes_state", { fromPaths: [`${P}-x`], action: "discard" });
    expect(await pendingRedirects(ADMIN_URL as string, P)).toEqual([]);
    expect(
      await refusal(OWNER, "redirects.set_changes_state", {
        fromPaths: [`${P}-x`],
        action: "include",
      }),
    ).toContain("has no pending change");
    // A page change's redirect is automatic: always Staged.
    await asSystem(ADMIN_URL as string, async (tx) => {
      await tx`INSERT INTO pending_redirects (address, from_path, to_path, status_code, state, origin, actor_id)
               VALUES (${`${P}-auto`}, ${`${P}-auto`}, '/', 301, 'staged', 'page_move', ${SYSTEM_ID}::uuid)`;
    });
    expect(
      await refusal(OWNER, "redirects.set_changes_state", {
        fromPaths: [`${P}-auto`],
        action: "keep_as_draft",
      }),
    ).toContain("automatic change");
  });

  it("deleting a live rule stages its removal; deleting a rule that is only pending drops the change", async () => {
    await seedLiveRedirects(ADMIN_URL as string, SYSTEM_ID, [
      { fromPath: `${P}-old/`, toPath: "/", statusCode: 301 },
    ]);
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-new`, toPath: "/t1550-live" }],
    });
    const listed = await op<{ redirects: { id: string; fromPath: string }[] }>(
      OWNER,
      "redirects.list",
      { query: P },
    );
    const ids = listed.redirects.map((r) => r.id);
    const r = await op<{ deleted: number; changes: { fromPath: string; outcome: string }[] }>(
      OWNER,
      "redirects.delete_many",
      { redirectIds: ids },
    );
    expect(r.changes.map((c) => [c.fromPath, c.outcome])).toEqual([
      [`${P}-new`, "unchanged"],
      [`${P}-old/`, "pending"],
    ]);
    expect(await liveRedirects(ADMIN_URL as string, P)).toHaveLength(1);
    expect(await pendingRedirects(ADMIN_URL as string, P)).toEqual([
      {
        fromPath: `${P}-old/`,
        toPath: null,
        statusCode: null,
        state: "staged",
        origin: "manual",
        chatSessionId: null,
      },
    ]);
  });

  it("deleting again a rule whose removal is a Draft stages that removal", async () => {
    await seedLiveRedirects(ADMIN_URL as string, SYSTEM_ID, [
      { fromPath: `${P}-again`, toPath: "/", statusCode: 301 },
    ]);
    await op(OWNER, "redirects.delete_many", { fromPaths: [`${P}-again`], goLive: "later" });
    expect(await pendingRedirects(ADMIN_URL as string, `${P}-again`)).toEqual([
      expect.objectContaining({ toPath: null, state: "draft" }),
    ]);
    const r = await op<{ changes: { fromPath: string; outcome: string }[] }>(
      OWNER,
      "redirects.delete_many",
      { fromPaths: [`${P}-again`] },
    );
    expect(r.changes.map((c) => [c.fromPath, c.outcome])).toEqual([[`${P}-again`, "pending"]]);
    expect(await pendingRedirects(ADMIN_URL as string, `${P}-again`)).toEqual([
      expect.objectContaining({ toPath: null, state: "staged" }),
    ]);
    // The live rule answers until its removal goes live.
    expect(await liveRedirects(ADMIN_URL as string, `${P}-again`)).toEqual([
      { fromPath: `${P}-again`, toPath: "/", statusCode: 301 },
    ]);
  });

  it("one pending change per address: a new one replaces the other chat's, and the result says so", async () => {
    const a = await op<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      {
        title: "t1550 Spring",
      },
    );
    const chatCtx: ExecutionContext = {
      ...AI,
      chatBranchId: a.chatBranchId,
      chatTaskId: a.chatSessionId,
    };
    await op(chatCtx, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-promo`, toPath: "/t1550-live" }],
    });
    const second = await op<{ changes: { replaced: string | null }[] }>(
      OWNER,
      "redirects.create_many",
      { redirects: [{ fromPath: `${P}-promo/`, toPath: "/", statusCode: 302 }], upsert: true },
    );
    expect(second.changes[0]?.replaced).toContain('from chat "t1550 Spring"');
    // One change per address, under the spelling the address is stored in
    // (#1517: an upsert updates the rule in place).
    expect(await pendingRedirects(ADMIN_URL as string, P)).toEqual([
      expect.objectContaining({ fromPath: `${P}-promo`, toPath: "/", statusCode: 302 }),
    ]);
  });

  it("Undo of a chat removes its pending changes and never touches the live rules", async () => {
    await seedLiveRedirects(ADMIN_URL as string, SYSTEM_ID, [
      { fromPath: `${P}-stay`, toPath: "/", statusCode: 301 },
    ]);
    const chat = await op<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      { title: "t1550 Undo" },
    );
    const chatCtx: ExecutionContext = {
      ...SYS,
      chatBranchId: chat.chatBranchId,
      chatTaskId: chat.chatSessionId,
    };
    await op(chatCtx, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-mine`, toPath: "/t1550-live" }],
    });
    await op(chatCtx, "redirects.delete_many", { fromPaths: [`${P}-stay`] });
    expect(await pendingRedirects(ADMIN_URL as string, P)).toHaveLength(2);
    const undone = await op<{ applied: boolean; droppedRows: number }>(SYS, "chat.undo_changes", {
      chatSessionId: chat.chatSessionId,
    });
    expect(undone).toMatchObject({ applied: true, droppedRows: 2 });
    expect(await pendingRedirects(ADMIN_URL as string, P)).toEqual([]);
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([
      { fromPath: `${P}-stay`, toPath: "/", statusCode: 301 },
    ]);
  });
});

describe("Go live now (#1550)", () => {
  it("puts a manual change live without Publish live, logs it, and pushes the live hosting", async () => {
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-now`, toPath: "/t1550-live", statusCode: 302 }],
      goLive: "later",
    });
    const r = await op<{ applied: { fromPath: string }[]; targets: { status: string }[] }>(
      OWNER,
      "redirects.go_live_now",
      { fromPaths: [`${P}-now`], repoRoot: root },
    );
    expect(r.applied.map((a) => a.fromPath)).toEqual([`${P}-now`]);
    expect(r.targets.map((t) => t.status)).toEqual(["applied"]);
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([
      { fromPath: `${P}-now`, toPath: "/t1550-live", statusCode: 302 },
    ]);
    expect(await pendingRedirects(ADMIN_URL as string, P)).toEqual([]);
    expect(await caddySnippet()).toContain(`${P}-now`);
    const log = await asSystem(
      ADMIN_URL as string,
      async (tx) =>
        (await tx`SELECT kind, run_id, before_rules, after_rules FROM redirect_release_log
                WHERE address = ${`${P}-now`}`) as {
          kind: string;
          run_id: string | null;
          before_rules: unknown;
          after_rules: unknown;
        }[],
    );
    expect(log).toEqual([
      {
        kind: "go_live_now",
        run_id: null,
        before_rules: [],
        after_rules: [{ fromPath: `${P}-now`, toPath: "/t1550-live", statusCode: 302 }],
      },
    ]);
  });

  it("pushes a hosting target that backs off from an earlier failure right away", async () => {
    // Production failed earlier and waits an hour for its next retry.
    await asSystem(ADMIN_URL as string, async (tx) => {
      await tx`
        INSERT INTO redirect_sync_state (target_id, wanted_revision, synced_revision, failed_attempts, next_attempt_at)
        VALUES (${productionTargetId}::uuid, 2, 1, 3, now() + interval '1 hour')
        ON CONFLICT (target_id) DO UPDATE SET wanted_revision = 2, synced_revision = 1,
          failed_attempts = 3, next_attempt_at = EXCLUDED.next_attempt_at`;
    });
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-backoff`, toPath: "/t1550-live" }],
    });
    const r = await op<{ targets: { status: string }[] }>(OWNER, "redirects.go_live_now", {
      fromPaths: [`${P}-backoff`],
      repoRoot: root,
    });
    expect(r.targets.map((t) => t.status)).toEqual(["applied"]);
    expect(await caddySnippet()).toContain(`${P}-backoff`);
    const state = await asSystem(
      ADMIN_URL as string,
      async (tx) =>
        (await tx`SELECT wanted_revision = synced_revision AS in_sync, next_attempt_at
                  FROM redirect_sync_state WHERE target_id = ${productionTargetId}::uuid`) as {
          in_sync: boolean;
          next_attempt_at: Date | null;
        }[],
    );
    expect(state).toEqual([{ in_sync: true, next_attempt_at: null }]);
  });

  it("refuses an automatic change, a target the live build lacks and a path a live page answers, all at once", async () => {
    await op(OWNER, "redirects.create_many", {
      redirects: [
        { fromPath: `${P}-unserved`, toPath: "/t1550-draft-page" },
        { fromPath: `${P}-live`, toPath: "/" },
      ],
    });
    await asSystem(ADMIN_URL as string, async (tx) => {
      await tx`INSERT INTO pending_redirects (address, from_path, to_path, status_code, state, origin, actor_id)
               VALUES (${`${P}-moved`}, ${`${P}-moved`}, '/', 301, 'staged', 'page_move', ${SYSTEM_ID}::uuid)`;
    });
    const why = await refusal(OWNER, "redirects.go_live_now", {
      fromPaths: [`${P}-moved`],
      repoRoot: root,
    });
    expect(why).toContain("automatic change");
    const both = await refusal(OWNER, "redirects.go_live_now", {
      fromPaths: [`${P}-unserved`, `${P}-live`],
      repoRoot: root,
    });
    expect(both).toContain("is not on the live site yet");
    expect(both).toContain("a live page answers");
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([]);
  });

  it("refuses before anything is live, without the Publish live permission, and for the AI", async () => {
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-early`, toPath: "/" }],
    });
    expect(
      await refusal(REVIEWER, "redirects.go_live_now", {
        fromPaths: [`${P}-early`],
        repoRoot: root,
      }),
    ).toContain("Publish live permission");
    expect(
      await refusal(AI, "redirects.go_live_now", { fromPaths: [`${P}-early`], repoRoot: root }),
    ).toContain("ActorScope");
    await serveLive({});
    expect(
      await refusal(OWNER, "redirects.go_live_now", { fromPaths: [`${P}-early`], repoRoot: root }),
    ).toContain("nothing is live");
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([]);
  });

  it("the AI proposes; the approver needs the Publish live permission; the approval puts it live", async () => {
    await op(AI, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-ai`, toPath: "/t1550-live" }],
    });
    const { proposalId } = await op<{ proposalId: string }>(AI, "redirects.propose_go_live", {
      fromPaths: [`${P}-ai`],
    });
    expect(await refusal(AI, "redirects.execute_go_live", { proposalId })).toContain("ActorScope");
    expect(
      await refusal(REVIEWER, "redirects.execute_go_live", { proposalId, repoRoot: root }),
    ).toContain("permission_denied");
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([]);
    await op(OWNER, "redirects.execute_go_live", { proposalId, repoRoot: root });
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([
      { fromPath: `${P}-ai`, toPath: "/t1550-live", statusCode: 301 },
    ]);
    const status = await asSystem(
      ADMIN_URL as string,
      async (tx) =>
        (await tx`SELECT status FROM redirect_pending_actions WHERE id = ${proposalId}::uuid`) as {
          status: string;
        }[],
    );
    expect(status[0]?.status).toBe("applied");
  });

  it("an approval puts live the change its card showed: a change saved since refuses it", async () => {
    await op(AI, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-bound`, toPath: "/t1550-live" }],
    });
    const { proposalId } = await op<{ proposalId: string }>(AI, "redirects.propose_go_live", {
      fromPaths: [`${P}-bound`],
    });
    // Someone changes the rule while the card waits.
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-bound`, toPath: "/" }],
      upsert: true,
    });
    const why = await refusal(OWNER, "redirects.execute_go_live", { proposalId, repoRoot: root });
    expect(why).toContain("changed after it was proposed");
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([]);
    // The proposal stays pending for a reject; the newer change stays Staged.
    expect(await pendingRedirects(ADMIN_URL as string, `${P}-bound`)).toEqual([
      expect.objectContaining({ toPath: "/", state: "staged" }),
    ]);
  });

  it("an approval and a reject never both succeed: the release refuses a proposal decided meanwhile", async () => {
    await op(AI, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-decided`, toPath: "/t1550-live" }],
    });
    const first = await op<{ proposalId: string }>(AI, "redirects.propose_go_live", {
      fromPaths: [`${P}-decided`],
    });
    // The approval read the proposal as pending; a reject commits before its release.
    await op(OWNER, "redirects.reject_proposal", { proposalId: first.proposalId });
    const why = await refusal(OWNER, "redirects.go_live_now", {
      fromPaths: [`${P}-decided`],
      proposalId: first.proposalId,
      repoRoot: root,
    });
    expect(why).toContain("this proposal was rejected meanwhile");
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([]);
    // The other way round: an applied proposal refuses a reject after it.
    const second = await op<{ proposalId: string }>(AI, "redirects.propose_go_live", {
      fromPaths: [`${P}-decided`],
    });
    await op(OWNER, "redirects.execute_go_live", { proposalId: second.proposalId, repoRoot: root });
    expect(
      await refusal(OWNER, "redirects.reject_proposal", { proposalId: second.proposalId }),
    ).toContain("this proposal is applied already");
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([
      { fromPath: `${P}-decided`, toPath: "/t1550-live", statusCode: 301 },
    ]);
  });

  it("proposes Go live now for as many changes as one tool call saves (500)", async () => {
    const fromPaths = Array.from({ length: 150 }, (_, i) => `${P}-many-${i}`);
    await op(AI, "redirects.create_many", {
      redirects: fromPaths.map((fromPath) => ({ fromPath, toPath: "/t1550-live" })),
    });
    const { proposalId } = await op<{ proposalId: string }>(AI, "redirects.propose_go_live", {
      fromPaths,
    });
    await op(OWNER, "redirects.execute_go_live", { proposalId, repoRoot: root });
    expect(await liveRedirects(ADMIN_URL as string, `${P}-many-`)).toHaveLength(150);
  });

  it("an external approval 'now' puts live the rules it saved, not a rule already live as it is", async () => {
    await seedLiveRedirects(ADMIN_URL as string, OWNER_ID, [
      { fromPath: `${P}-ext-same`, toPath: "https://calendar.example/a", statusCode: 302 },
    ]);
    const { proposalId } = await op<{ proposalId: string }>(AI, "redirects.propose_external", {
      redirects: [
        { fromPath: `${P}-ext-same`, url: "https://calendar.example/a", statusCode: 302 },
        { fromPath: `${P}-ext-new`, url: "https://calendar.example/b", statusCode: 302 },
      ],
      goLive: "now",
    });
    const saved = await op<{
      fromPaths: string[];
      changes: { fromPath: string; id: string; revision: number }[];
      nextStep: string;
    }>(OWNER, "redirects.execute_proposal", { proposalId });
    expect(saved.fromPaths).toEqual([`${P}-ext-same`, `${P}-ext-new`]);
    expect(saved.changes.map((c) => c.fromPath)).toEqual([`${P}-ext-new`]);
    expect(saved.nextStep).toContain(`Already live as it is: ${P}-ext-same`);
    // Every proposed path would refuse the whole batch: one has nothing pending.
    const refs = saved.changes.map(({ id, revision }) => ({ id, revision }));
    expect(
      await refusal(OWNER, "redirects.go_live_now", {
        fromPaths: saved.fromPaths,
        changes: refs,
        repoRoot: root,
      }),
    ).toContain(`${P}-ext-same`);
    await op(OWNER, "redirects.go_live_now", {
      fromPaths: saved.changes.map((c) => c.fromPath),
      changes: refs,
      repoRoot: root,
    });
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([
      { fromPath: `${P}-ext-new`, toPath: "https://calendar.example/b", statusCode: 302 },
      { fromPath: `${P}-ext-same`, toPath: "https://calendar.example/a", statusCode: 302 },
    ]);
  });

  it("the in-chat approval of an external 'now' puts its saved rules live past one already live", async () => {
    await seedLiveRedirects(ADMIN_URL as string, OWNER_ID, [
      { fromPath: `${P}-chat-same`, toPath: "https://calendar.example/a", statusCode: 302 },
    ]);
    const tool = attachGatedExecute(
      {
        name: proposeExternalRedirectTool.name,
        description: proposeExternalRedirectTool.description,
        inputSchema: proposeExternalRedirectTool.inputSchema,
        gated: proposeExternalRedirectTool.gated,
      } as FilteredTool,
      registry,
      adapter,
      AI,
      OWNER,
    );
    // The approval's Go live now reads the live build where the deploy ops write it.
    const outputRoot = process.env.CAELO_OUTPUT_ROOT;
    process.env.CAELO_OUTPUT_ROOT = root;
    try {
      const r = (await tool.execute?.({
        redirects: [
          { fromPath: `${P}-chat-same`, url: "https://calendar.example/a", statusCode: 302 },
          { fromPath: `${P}-chat-new`, url: "https://calendar.example/b", statusCode: 302 },
        ],
        goLive: "now",
      })) as { ok: boolean; value: { wentLiveNow?: boolean; warning?: string } };
      expect(r.ok).toBe(true);
      expect(r.value.wentLiveNow).toBe(true);
      expect(r.value.warning).toBeUndefined();
    } finally {
      if (outputRoot === undefined) delete process.env.CAELO_OUTPUT_ROOT;
      else process.env.CAELO_OUTPUT_ROOT = outputRoot;
    }
    expect(await liveRedirects(ADMIN_URL as string, `${P}-chat-`)).toEqual([
      { fromPath: `${P}-chat-new`, toPath: "https://calendar.example/b", statusCode: 302 },
      { fromPath: `${P}-chat-same`, toPath: "https://calendar.example/a", statusCode: 302 },
    ]);
  });

  it("waits for no release: while a Publish live holds the live site it refuses, and writes nothing", async () => {
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-busy`, toPath: "/t1550-live" }],
    });
    const run = crypto.randomUUID();
    await asSystem(ADMIN_URL as string, async (tx) => {
      await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, lease_expires_at)
               VALUES (${run}::uuid, ${productionTargetId}::uuid, ${SYSTEM_ID}::uuid, 'running',
                       now() + interval '10 minutes')`;
      await tx`UPDATE deploy_leases SET holder_run_id = ${run}::uuid, holder_sync_id = NULL,
                 acquired_at = now(), expires_at = now() + interval '10 minutes'
               WHERE name = 'live-release'`;
    });
    try {
      const why = await refusal(OWNER, "redirects.go_live_now", {
        fromPaths: [`${P}-busy`],
        repoRoot: root,
      });
      expect(why).toContain("releasing the live site right now");
      expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([]);
    } finally {
      await asSystem(ADMIN_URL as string, async (tx) => {
        await tx`UPDATE deploy_leases SET holder_run_id = NULL, acquired_at = NULL, expires_at = NULL
                 WHERE name = 'live-release'`;
        await tx`DELETE FROM deploy_runs WHERE id = ${run}::uuid`;
      });
    }
  });

  it("a release applies its plan whole or not at all: a moved-on change or live table holds all back", async () => {
    await op(OWNER, "redirects.create_many", {
      redirects: [
        { fromPath: `${P}-chain-a`, toPath: `${P}-chain-b` },
        { fromPath: `${P}-chain-b`, toPath: "/t1550-live" },
      ],
    });
    const pending = await asSystem(
      ADMIN_URL as string,
      async (tx) =>
        (await tx`SELECT id::text AS id, revision::int AS revision FROM pending_redirects
                  WHERE from_path LIKE ${`${P}-chain-%`} ORDER BY address`) as {
          id: string;
          revision: number;
        }[],
    );
    const refs = pending.map((p) => ({ id: p.id, revision: p.revision }));
    const fingerprint = await adapter.withAdminTransaction(SYS, async (tx) =>
      liveRedirectsFingerprint(await loadLiveRedirectRows(tx)),
    );
    // The second change is kept as a draft after the plan: the first one
    // alone would chain into a rule the live site does not have.
    await op(OWNER, "redirects.set_changes_state", {
      fromPaths: [`${P}-chain-b`],
      action: "keep_as_draft",
    });
    const movedOn = await adapter.withAdminTransaction(SYS, (tx) =>
      releaseRedirectChanges(
        tx,
        SYSTEM_ID,
        refs,
        { kind: "go_live_now" },
        {
          states: ["staged"],
          liveFingerprint: fingerprint,
        },
      ),
    );
    expect(movedOn.released).toBe(false);
    await op(OWNER, "redirects.set_changes_state", {
      fromPaths: [`${P}-chain-b`],
      action: "include",
    });
    const current = await asSystem(
      ADMIN_URL as string,
      async (tx) =>
        (await tx`SELECT id::text AS id, revision::int AS revision FROM pending_redirects
                  WHERE from_path LIKE ${`${P}-chain-%`} ORDER BY address`) as {
          id: string;
          revision: number;
        }[],
    );
    // A live rule changed after the plan: its chains may not hold.
    await seedLiveRedirects(ADMIN_URL as string, SYSTEM_ID, [
      { fromPath: `${P}-other`, toPath: "/", statusCode: 301 },
    ]);
    const liveChanged = await adapter.withAdminTransaction(SYS, (tx) =>
      releaseRedirectChanges(
        tx,
        SYSTEM_ID,
        current,
        { kind: "go_live_now" },
        {
          states: ["staged"],
          liveFingerprint: fingerprint,
        },
      ),
    );
    expect(liveChanged.released).toBe(false);
    expect(await liveRedirects(ADMIN_URL as string, `${P}-chain`)).toEqual([]);
    expect(await pendingRedirects(ADMIN_URL as string, `${P}-chain`)).toHaveLength(2);
  });
});

describe("a page move retargets pending changes in place (#1550)", () => {
  it("a Draft pointing at a moved page stays a manual Draft; a live rule gets an automatic Staged change", async () => {
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-campaign`, toPath: "/t1550-about" }],
      goLive: "later",
    });
    await seedLiveRedirects(ADMIN_URL as string, SYSTEM_ID, [
      { fromPath: `${P}-legacy`, toPath: "/t1550-about", statusCode: 301 },
    ]);
    await adapter.withAdminTransaction(SYS, (tx) =>
      applyPathMoveEffects(
        SYS,
        tx,
        [{ pageId: crypto.randomUUID(), from: "/t1550-about", to: "/t1550-company" }],
        "skip",
      ),
    );
    expect(await pendingRedirects(ADMIN_URL as string, P)).toEqual([
      expect.objectContaining({
        fromPath: `${P}-campaign`,
        toPath: "/t1550-company",
        state: "draft",
        origin: "manual",
      }),
      expect.objectContaining({
        fromPath: `${P}-legacy`,
        toPath: "/t1550-company",
        state: "staged",
        origin: "page_move",
      }),
    ]);
  });

  it("a page move leaves a pending change that was saved again after the move read it", async () => {
    const saved = await op<{ changes: { changeId: string | null }[] }>(
      OWNER,
      "redirects.create_many",
      { redirects: [{ fromPath: `${P}-raced-move`, toPath: "/t1550-about" }], goLive: "later" },
    );
    const id = saved.changes[0]?.changeId;
    if (!id) throw new Error("no pending change saved");
    // Another editor points it elsewhere between the move's read and its write.
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-raced-move`, toPath: "/t1550-contact" }],
      goLive: "later",
      upsert: true,
    });
    const moved = await adapter.withAdminTransaction(SYS, (tx) =>
      retargetPendingRedirects(tx, [{ id, pointedAt: "/t1550-about", toPath: "/t1550-company" }]),
    );
    expect(moved).toBe(0);
    expect(await pendingRedirects(ADMIN_URL as string, `${P}-raced-move`)).toEqual([
      expect.objectContaining({ toPath: "/t1550-contact", state: "draft" }),
    ]);
  });
});

describe("redirects.list (#1540, #1550)", () => {
  it("lists every rule with its state, filters by state, counts and pages", async () => {
    await seedLiveRedirects(ADMIN_URL as string, SYSTEM_ID, [
      { fromPath: `${P}-l1`, toPath: "/", statusCode: 301 },
      { fromPath: `${P}-l2`, toPath: "/", statusCode: 301 },
    ]);
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-l2`, toPath: "/t1550-live" }],
      upsert: true,
    });
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-n1`, toPath: "/t1550-live" }],
      goLive: "later",
    });
    const all = await op<{
      redirects: { address: string; state: string; change: { kind: string } | null }[];
      totalCount: number;
      nextCursor: string | null;
    }>(OWNER, "redirects.list", { query: P, limit: 2 });
    expect(all.totalCount).toBe(3);
    expect(all.redirects.map((r) => [r.address, r.state, r.change?.kind ?? null])).toEqual([
      [`${P}-l1`, "live", null],
      [`${P}-l2`, "staged", "change"],
    ]);
    const next = await op<{ redirects: { address: string; state: string }[] }>(
      OWNER,
      "redirects.list",
      { query: P, limit: 2, cursor: all.nextCursor },
    );
    expect(next.redirects.map((r) => [r.address, r.state])).toEqual([[`${P}-n1`, "draft"]]);
    const drafts = await op<{ redirects: { address: string }[]; totalCount: number }>(
      OWNER,
      "redirects.list",
      { query: P, state: "draft" },
    );
    expect(drafts.totalCount).toBe(1);
    expect(
      await refusal(OWNER, "redirects.list", { query: P, state: "live", cursor: all.nextCursor }),
    ).toContain("continues the list");
  });
});

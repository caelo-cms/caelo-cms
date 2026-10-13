// SPDX-License-Identifier: MPL-2.0

/**
 * #696 Phase 2 — "Install update" against real Postgres (§6):
 *
 *   - authz of the writes: the AI, system workers and non-Owners are refused;
 *     the Owner needs a fresh Google sign-in from the same session (step-up),
 *     a stale or foreign one is refused, and one sign-in authorizes exactly
 *     one action;
 *   - the step-up ops end to end (client set up → begin → redeem → record);
 *   - request rules: only the newest known release, one at a time, cancel
 *     only while pending, a failed job start ends the request;
 *   - list/get/policy.get are open to the AI (it informs, never installs);
 *   - the `platform_updater` database role the upgrader job runs as can do
 *     exactly its job and nothing else (migration 0267).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { registerAdminOps } from "../register.js";
import { _setKekForTests } from "../security/secret-box.js";
import { sessionHashOf } from "../security/step-up/gate.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const P = "pu-install";
const OWNER_EMAIL = `${P}-owner@example.com`;
const EDITOR_EMAIL = `${P}-editor@example.com`;
const NEWEST = "99.1.0";
const CLIENT_ID = "123456789-abcdef.apps.googleusercontent.com";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: `${P}-ai`,
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: `${P}-sys`,
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let owner: ExecutionContext;
let editor: ExecutionContext;
let ownerSession: string;
let editorSession: string;

async function admin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const db = new SQL(ADMIN_URL as string);
  try {
    let result!: T;
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      result = await fn(tx as unknown as SQL);
    });
    return result;
  } finally {
    await db.end();
  }
}

async function run(ctx: ExecutionContext, op: string, input: unknown) {
  return execute(registry, adapter, ctx, op, input);
}

async function okValue<T>(ctx: ExecutionContext, op: string, input: unknown): Promise<T> {
  const r = await run(ctx, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

function message(r: Awaited<ReturnType<typeof run>>): string {
  if (r.ok) return "(ok)";
  const e = r.error as { message?: string; kind: string };
  return e.message ?? e.kind;
}

async function createUser(email: string, roleNames: string[]): Promise<ExecutionContext> {
  const r = await okValue<{ userId: string }>(SYSTEM, "users.create", {
    email,
    password: "harbor-lantern-quill-71",
    displayName: email.split("@")[0],
    roleNames,
  });
  return { actorId: r.userId, actorKind: "human", requestId: `${P}-${email}` };
}

async function login(email: string): Promise<string> {
  const r = await okValue<{ token: string }>(SYSTEM, "auth.login", {
    email,
    password: "harbor-lantern-quill-71",
  });
  return sessionHashOf(r.token);
}

/** Run the real step-up ops as Google would answer them. */
async function stepUp(
  ctx: ExecutionContext,
  sessionHash: string,
  opts: { email?: string; authTimeOffsetSec?: number } = {},
) {
  const begin = await okValue<{ authorizationUrl: string }>(ctx, "step_up.begin", {
    sessionHash,
    purpose: "platform_update",
    returnTo: "/settings/updates",
    redirectUri: "https://admin.example.com/settings/updates/step-up/callback",
  });
  const url = new URL(begin.authorizationUrl);
  expect(url.searchParams.get("max_age")).toBe("0");
  expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  const state = url.searchParams.get("state") as string;
  const redeemed = await okValue<{ startedAt: string; nonce: string; clientSecret: string }>(
    ctx,
    "step_up.redeem",
    { sessionHash, state },
  );
  expect(redeemed.nonce).toBe(url.searchParams.get("nonce") as string);
  expect(redeemed.clientSecret).toBe("test-client-secret-value");
  return run(ctx, "step_up.record", {
    sessionHash,
    purpose: "platform_update",
    outcome: {
      ok: true,
      email: opts.email ?? OWNER_EMAIL,
      authTime: Math.floor(Date.now() / 1000) + (opts.authTimeOffsetSec ?? 0),
      startedAt: redeemed.startedAt,
    },
  });
}

async function setLatest(version: string | null): Promise<void> {
  await admin((tx) => tx`UPDATE release_check_cache SET latest_version = ${version} WHERE id = 1`);
}

async function wipe(): Promise<void> {
  await admin(async (tx) => {
    await tx`DELETE FROM platform_update_requests`;
    await tx`DELETE FROM step_up_google_client`;
    await tx`UPDATE platform_update_policy SET mode = 'notify', auto_security = false,
      auto_patch = false, auto_minor = false, channel = 'stable', window_start = NULL,
      window_end = NULL, window_timezone = 'UTC', soak_hours = 24, paused = false,
      paused_reason = NULL, paused_at = NULL WHERE id = 1`;
    for (const email of [OWNER_EMAIL, EDITOR_EMAIL]) {
      await tx`DELETE FROM step_up_challenges WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      await tx`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      await tx`DELETE FROM users WHERE email = ${email}`;
    }
  });
}

beforeAll(async () => {
  _setKekForTests(new Uint8Array(32).fill(7));
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  owner = await createUser(OWNER_EMAIL, ["owner"]);
  editor = await createUser(EDITOR_EMAIL, ["editor"]);
});

beforeEach(async () => {
  await admin(async (tx) => {
    await tx`DELETE FROM platform_update_requests`;
    await tx`DELETE FROM step_up_google_client`;
  });
  await setLatest(NEWEST);
  ownerSession = await login(OWNER_EMAIL);
  editorSession = await login(EDITOR_EMAIL);
  await okValue(owner, "step_up.set_client", {
    clientId: CLIENT_ID,
    clientSecret: "test-client-secret-value",
    sessionHash: ownerSession,
  });
});

afterAll(async () => {
  await wipe();
  await setLatest(null);
  _setKekForTests(null);
  await adapter.close();
});

describe("platform_updates.request authz", () => {
  it("is not reachable by the AI or system workers", async () => {
    for (const ctx of [AI, SYSTEM]) {
      const r = await run(ctx, "platform_updates.request", {
        targetVersion: NEWEST,
        sessionHash: ownerSession,
      });
      expect(r.ok === false && r.error.kind).toBe("ActorScopeRejected");
    }
    for (const op of ["platform_updates.cancel", "platform_update_policy.set", "step_up.begin"]) {
      const r = await run(AI, op, {});
      expect(r.ok === false && r.error.kind).toBe("ActorScopeRejected");
    }
  });

  it("refuses a non-Owner even with a step-up", async () => {
    const begin = await run(editor, "step_up.begin", {
      sessionHash: editorSession,
      purpose: "platform_update",
      returnTo: "/settings/updates",
      redirectUri: "https://admin.example.com/cb",
    });
    expect(message(begin)).toContain("permission_denied");
    const r = await run(editor, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: editorSession,
    });
    expect(message(r)).toContain("platform.update");
  });

  it("requires a step-up, and refuses another user's session", async () => {
    const none = await run(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    expect(message(none)).toStartWith("step_up_required:");
    const foreign = await run(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: editorSession,
    });
    expect(message(foreign)).toContain("not signed in");
  });

  it("refuses a stale step-up", async () => {
    expect((await stepUp(owner, ownerSession)).ok).toBe(true);
    await admin(
      (tx) => tx`UPDATE sessions SET step_up_at = now() - interval '11 minutes'
                  WHERE user_id = ${owner.actorId}::uuid AND step_up_at IS NOT NULL`,
    );
    const r = await run(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    expect(message(r)).toContain("step_up_required: the Google sign-in was 11 minutes ago");
  });

  it("refuses a sign-in with a different Google account", async () => {
    const r = await stepUp(owner, ownerSession, { email: "someone-else@example.com" });
    expect(message(r)).toContain("this Caelo account is");
  });

  it("refuses a Google sign-in older than the step-up itself (Google reused a session)", async () => {
    const r = await stepUp(owner, ownerSession, { authTimeOffsetSec: -3600 });
    expect(message(r)).toContain("not from this confirmation");
  });

  it("accepts a fresh step-up once, then needs a new one", async () => {
    expect((await stepUp(owner, ownerSession)).ok).toBe(true);
    const status = await okValue<{ freshUntil: string | null }>(owner, "step_up.status", {
      sessionHash: ownerSession,
    });
    expect(status.freshUntil).not.toBeNull();
    const first = await okValue<{ requestId: string }>(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    expect(first.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const cancel = await run(owner, "platform_updates.cancel", {
      requestId: first.requestId,
      sessionHash: ownerSession,
    });
    expect(message(cancel)).toStartWith("step_up_required:");
    const audit = await admin(
      (tx) =>
        tx`SELECT succeeded FROM audit_events WHERE actor_id = ${owner.actorId}::uuid
             AND operation = 'platform_updates.request' ORDER BY created_at DESC LIMIT 1`,
    );
    expect((audit as unknown as { succeeded: boolean }[])[0]?.succeeded).toBe(true);
  });
});

describe("platform_updates.request rules", () => {
  it("installs only the newest known release", async () => {
    await stepUp(owner, ownerSession);
    const r = await run(owner, "platform_updates.request", {
      targetVersion: "99.0.0",
      sessionHash: ownerSession,
    });
    expect(message(r)).toContain(`Only the newest release can be installed (${NEWEST})`);
    await setLatest(null);
    const unknown = await run(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    expect(message(unknown)).toContain("not known yet");
  });

  it("allows one request at a time; cancel works only while pending", async () => {
    await stepUp(owner, ownerSession);
    const { requestId } = await okValue<{ requestId: string }>(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    await stepUp(owner, ownerSession);
    const second = await run(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    expect(message(second)).toContain("already waiting to start");

    await admin(
      (tx) =>
        tx`UPDATE platform_update_requests SET status = 'running', started_at = now() WHERE id = ${requestId}::uuid`,
    );
    const running = await run(owner, "platform_updates.cancel", {
      requestId,
      sessionHash: ownerSession,
    });
    expect(message(running)).toContain("Only an update that has not started yet");

    await admin(
      (tx) =>
        tx`UPDATE platform_update_requests SET status = 'pending', started_at = NULL WHERE id = ${requestId}::uuid`,
    );
    await stepUp(owner, ownerSession);
    expect(
      (await run(owner, "platform_updates.cancel", { requestId, sessionHash: ownerSession })).ok,
    ).toBe(true);
    const got = await okValue<{ request: { status: string }; events: { phase: string }[] }>(
      AI,
      "platform_updates.get",
      { requestId },
    );
    expect(got.request.status).toBe("cancelled");
    expect(got.events.map((e) => e.phase)).toEqual(["queued", "finish"]);
  });

  it("a job that could not start ends the request, so it does not block the next", async () => {
    await stepUp(owner, ownerSession);
    const { requestId } = await okValue<{ requestId: string }>(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    await okValue(owner, "platform_updates.record_trigger", {
      requestId,
      outcome: { started: false, error: "HTTP 403", nextStep: "Run cms-provision upgrade." },
    });
    const list = await okValue<{ requests: { status: string; statusReason: string }[] }>(
      AI,
      "platform_updates.list",
      {},
    );
    expect(list.requests[0]?.status).toBe("failed");
    expect(list.requests[0]?.statusReason).toContain("HTTP 403");
    // Only the requester records the trigger outcome.
    const other = await run(editor, "platform_updates.record_trigger", {
      requestId,
      outcome: { started: true, execution: "x" },
    });
    expect(message(other)).toContain("No such update request of yours");
  });
});

describe("platform_update_policy", () => {
  const policy = {
    mode: "auto",
    autoSecurity: true,
    autoPatch: true,
    autoMinor: false,
    channel: "stable",
    windowStart: "02:00",
    windowEnd: "05:00",
    windowTimezone: "Europe/Berlin",
    soakHours: 48,
  };

  it("is readable by the AI and writable only by the Owner with a step-up", async () => {
    const before = await okValue<{ mode: string; soakHours: number }>(
      AI,
      "platform_update_policy.get",
      {},
    );
    expect(before).toMatchObject({ mode: "notify", soakHours: 24 });
    const noStepUp = await run(owner, "platform_update_policy.set", {
      policy,
      sessionHash: ownerSession,
    });
    expect(message(noStepUp)).toStartWith("step_up_required:");
    const editorTry = await run(editor, "platform_update_policy.set", {
      policy,
      sessionHash: editorSession,
    });
    expect(message(editorTry)).toContain("platform.update");
    await stepUp(owner, ownerSession);
    const after = await okValue<{ mode: string; windowStart: string }>(
      owner,
      "platform_update_policy.set",
      { policy, sessionHash: ownerSession },
    );
    expect(after).toMatchObject({ mode: "auto", windowStart: "02:00" });
  });

  it("rejects automatic installs off the stable channel and half-set windows", async () => {
    for (const bad of [
      { ...policy, channel: "rc" },
      { ...policy, windowEnd: null },
      { ...policy, windowTimezone: "Mars/Olympus" },
    ]) {
      const r = await run(owner, "platform_update_policy.set", {
        policy: bad,
        sessionHash: ownerSession,
      });
      expect(r.ok === false && r.error.kind).toBe("ValidationFailed");
    }
  });
});

describe("step_up.set_client", () => {
  it("replacing the client needs a step-up; the secret never leaves in status", async () => {
    const r = await run(owner, "step_up.set_client", {
      clientId: CLIENT_ID,
      clientSecret: "another-secret-value",
      sessionHash: ownerSession,
    });
    expect(message(r)).toStartWith("step_up_required:");
    const status = await okValue<Record<string, unknown>>(owner, "step_up.status", {
      sessionHash: ownerSession,
    });
    expect(status).toMatchObject({ configured: true, clientId: CLIENT_ID });
    expect(JSON.stringify(status)).not.toContain("test-client-secret-value");
  });

  it("a redeemed sign-in link cannot be used twice or from another session", async () => {
    const begin = await okValue<{ authorizationUrl: string }>(owner, "step_up.begin", {
      sessionHash: ownerSession,
      purpose: "update_policy",
      returnTo: "/settings/updates",
      redirectUri: "https://admin.example.com/cb",
    });
    const state = new URL(begin.authorizationUrl).searchParams.get("state") as string;
    const otherSession = await login(OWNER_EMAIL);
    const wrong = await run(owner, "step_up.redeem", { sessionHash: otherSession, state });
    expect(message(wrong)).toContain("another browser session");
    const again = await run(owner, "step_up.redeem", { sessionHash: ownerSession, state });
    expect(message(again)).toContain("unknown or was already used");
  });
});

describe("platform_updater database role (migration 0267)", () => {
  it("can claim and narrate a request, and nothing else", async () => {
    await stepUp(owner, ownerSession);
    const { requestId } = await okValue<{ requestId: string }>(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    const asUpdater = async (statement: string) =>
      adapter
        .withAdminTransaction(SYSTEM, async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE platform_updater`);
          // The role's policies must not depend on the session's actor kind.
          await tx.execute(sql`SELECT set_config('caelo.actor_kind', '', true)`);
          await tx.execute(sql.raw(statement));
          return "allowed";
        })
        .catch((e: unknown) => String((e as { cause?: unknown }).cause ?? e));

    for (const allowed of [
      "SELECT id, target_version, status FROM platform_update_requests",
      "SELECT mode, paused FROM platform_update_policy",
      `UPDATE platform_update_requests SET status = 'running', started_at = now(), execution = 'exec-1' WHERE id = '${requestId}'`,
      `INSERT INTO platform_update_events (request_id, phase, level, message) VALUES ('${requestId}', 'start', 'info', 'claimed')`,
      "UPDATE platform_update_policy SET paused = true, paused_at = now(), paused_reason = 'x' WHERE id = 1",
    ]) {
      expect(await asUpdater(allowed)).toBe("allowed");
    }
    for (const forbidden of [
      "SELECT email FROM users LIMIT 1",
      "SELECT token FROM sessions LIMIT 1",
      "SELECT client_id FROM step_up_google_client",
      `UPDATE platform_update_requests SET target_version = '0.0.1' WHERE id = '${requestId}'`,
      `UPDATE platform_update_requests SET requested_by = NULL WHERE id = '${requestId}'`,
      "INSERT INTO platform_update_requests (target_version, from_version, trigger) VALUES ('1.0.0', '0.1.0', 'auto')",
      `DELETE FROM platform_update_requests WHERE id = '${requestId}'`,
      "UPDATE platform_update_policy SET mode = 'auto' WHERE id = 1",
      "SELECT message FROM platform_update_events LIMIT 1",
      "UPDATE release_check_cache SET latest_version = '0.0.1'",
    ]) {
      expect(await asUpdater(forbidden)).toContain("permission denied");
    }
  });
});

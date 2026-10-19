// SPDX-License-Identifier: MPL-2.0

/**
 * #696 Phase 2 — "Install update" against real Postgres (§6):
 *
 *   - authz of the writes: the AI, system workers and non-Owners are refused;
 *     the Owner needs their password, re-entered in the same session
 *     (step-up, #757), a stale or foreign one is refused, and one
 *     confirmation authorizes exactly one action;
 *   - step_up.confirm_password: a wrong password is audited and counted,
 *     the fifth signs the session out, a right one resets the count;
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
import { STEP_UP_MAX_FAILURES } from "../ops/step-up.js";
import { registerAdminOps } from "../register.js";
import { sessionHashOf } from "../security/step-up/gate.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const P = "pu-install";
const OWNER_EMAIL = `${P}-owner@example.com`;
const EDITOR_EMAIL = `${P}-editor@example.com`;
const NEWEST = "99.1.0";
const PASSWORD = "harbor-lantern-quill-71";

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
    password: PASSWORD,
    displayName: email.split("@")[0],
    roleNames,
  });
  return { actorId: r.userId, actorKind: "human", requestId: `${P}-${email}` };
}

async function login(email: string): Promise<string> {
  const r = await okValue<{ token: string }>(SYSTEM, "auth.login", {
    email,
    password: PASSWORD,
  });
  return sessionHashOf(r.token);
}

/** The real step-up op: re-enter the password for one action. */
async function stepUp(
  ctx: ExecutionContext,
  sessionHash: string,
  opts: { password?: string; purpose?: "platform_update" | "update_policy" } = {},
) {
  return run(ctx, "step_up.confirm_password", {
    sessionHash,
    purpose: opts.purpose ?? "platform_update",
    password: opts.password ?? PASSWORD,
  });
}

/** The step-up columns of the session named by `sessionHash`; null once deleted. */
async function sessionRow(sessionHash: string) {
  const rows = await admin(
    (tx) =>
      tx`SELECT step_up_at, step_up_purpose, step_up_failures FROM sessions
           WHERE encode(sha256(convert_to(token, 'UTF8')), 'hex') = ${sessionHash}`,
  );
  return (
    (
      rows as unknown as {
        step_up_at: Date | null;
        step_up_purpose: string | null;
        step_up_failures: number;
      }[]
    )[0] ?? null
  );
}

async function setLatest(version: string | null): Promise<void> {
  await admin((tx) => tx`UPDATE release_check_cache SET latest_version = ${version} WHERE id = 1`);
}

async function wipe(): Promise<void> {
  await admin(async (tx) => {
    await tx`DELETE FROM platform_update_requests`;
    await tx`UPDATE platform_update_policy SET mode = 'notify', auto_security = false,
      auto_patch = false, auto_minor = false, channel = 'stable', window_start = NULL,
      window_end = NULL, window_timezone = 'UTC', soak_hours = 24, security_soak_hours = 2,
      paused = false, paused_reason = NULL, paused_at = NULL, paused_until = NULL,
      paused_by = NULL WHERE id = 1`;
    for (const email of [OWNER_EMAIL, EDITOR_EMAIL]) {
      await tx`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      await tx`DELETE FROM users WHERE email = ${email}`;
    }
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  owner = await createUser(OWNER_EMAIL, ["owner"]);
  editor = await createUser(EDITOR_EMAIL, ["editor"]);
});

beforeEach(async () => {
  await admin((tx) => tx`DELETE FROM platform_update_requests`);
  await setLatest(NEWEST);
  ownerSession = await login(OWNER_EMAIL);
  editorSession = await login(EDITOR_EMAIL);
});

afterAll(async () => {
  await wipe();
  await setLatest(null);
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
    for (const op of [
      "platform_updates.cancel",
      "platform_update_policy.set",
      "step_up.confirm_password",
    ]) {
      const r = await run(AI, op, {});
      expect(r.ok === false && r.error.kind).toBe("ActorScopeRejected");
    }
  });

  it("refuses a non-Owner even with their right password", async () => {
    const confirm = await stepUp(editor, editorSession);
    expect(message(confirm)).toContain("permission_denied");
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
      (tx) => tx`UPDATE sessions SET step_up_at = now() - interval '2 minutes'
                  WHERE user_id = ${owner.actorId}::uuid AND step_up_at IS NOT NULL`,
    );
    const r = await run(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    expect(message(r)).toContain("step_up_required: the password was confirmed 120 seconds ago");
  });

  it("a wrong password records nothing, is audited and counted; a right one resets the count", async () => {
    const wrong = await stepUp(owner, ownerSession, { password: "not-the-password" });
    expect(message(wrong)).toContain(`${STEP_UP_MAX_FAILURES - 1} more tries`);
    expect(await sessionRow(ownerSession)).toMatchObject({ step_up_at: null, step_up_failures: 1 });
    const request = await run(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    expect(message(request)).toStartWith("step_up_required:");
    const audit = await admin(
      (tx) =>
        tx`SELECT succeeded, result_summary FROM audit_events WHERE actor_id = ${owner.actorId}::uuid
             AND operation = 'step_up.confirm_password' ORDER BY created_at DESC LIMIT 1`,
    );
    expect((audit as unknown as { succeeded: boolean; result_summary: string }[])[0]).toMatchObject(
      { succeeded: false, result_summary: `wrong password (1/${STEP_UP_MAX_FAILURES})` },
    );
    expect((await stepUp(owner, ownerSession)).ok).toBe(true);
    expect(await sessionRow(ownerSession)).toMatchObject({
      step_up_purpose: "platform_update",
      step_up_failures: 0,
    });
  });

  it("a wrong password drops a confirmation already on the session", async () => {
    expect((await stepUp(owner, ownerSession)).ok).toBe(true);
    await stepUp(owner, ownerSession, { password: "not-the-password" });
    const r = await run(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    expect(message(r)).toStartWith("step_up_required:");
  });

  it(`the ${STEP_UP_MAX_FAILURES}th wrong password signs the session out; other sessions stay`, async () => {
    const otherSession = await login(OWNER_EMAIL);
    for (let i = 1; i < STEP_UP_MAX_FAILURES; i++) {
      await stepUp(owner, ownerSession, { password: `wrong-${i}` });
    }
    expect(await sessionRow(ownerSession)).toMatchObject({
      step_up_failures: STEP_UP_MAX_FAILURES - 1,
    });
    const last = await stepUp(owner, ownerSession, { password: "wrong-last" });
    expect(message(last)).toStartWith("step_up_signed_out:");
    expect(await sessionRow(ownerSession)).toBeNull();
    expect(await sessionRow(otherSession)).not.toBeNull();
    // The signed-out session cannot confirm, even with the right password.
    expect(message(await stepUp(owner, ownerSession))).toContain("not signed in any more");
  });

  it("confirms only the caller's own session", async () => {
    const r = await stepUp(owner, editorSession);
    expect(message(r)).toContain("not signed in any more");
    expect(await sessionRow(editorSession)).toMatchObject({
      step_up_at: null,
      step_up_failures: 0,
    });
  });

  it("a sign-in begun for another action does not authorize the install", async () => {
    expect((await stepUp(owner, ownerSession, { purpose: "update_policy" })).ok).toBe(true);
    const r = await run(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    expect(message(r)).toContain("confirmed for a different action");
  });

  it("accepts a fresh step-up once, then needs a new one", async () => {
    const confirmed = await okValue<{ freshUntil: string }>(owner, "step_up.confirm_password", {
      sessionHash: ownerSession,
      purpose: "platform_update",
      password: PASSWORD,
    });
    expect(new Date(confirmed.freshUntil).getTime()).toBeGreaterThan(Date.now());
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

describe("the converge route (#819)", () => {
  it("records which job installs the request; the default stays the upgrader", async () => {
    await stepUp(owner, ownerSession);
    const first = await okValue<{ requestId: string }>(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    const got = await okValue<{ request: { route: string } }>(AI, "platform_updates.get", {
      requestId: first.requestId,
    });
    expect(got.request.route).toBe("app_roll");
    await admin(
      (tx) =>
        tx`UPDATE platform_update_requests SET status = 'cancelled', cancelled_at = now(), finished_at = now() WHERE id = ${first.requestId}::uuid`,
    );

    await stepUp(owner, ownerSession);
    const { requestId } = await okValue<{ requestId: string }>(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
      route: "converge",
    });
    const converge = await okValue<{
      request: { route: string };
      events: { message: string }[];
    }>(AI, "platform_updates.get", { requestId });
    expect(converge.request.route).toBe("converge");
    expect(converge.events[0]?.message).toContain("Caelo's converge job installs it");
  });

  it("continues only a running converge, with the Owner's password, once per confirmation", async () => {
    await stepUp(owner, ownerSession);
    const { requestId } = await okValue<{ requestId: string }>(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
      route: "converge",
    });
    // Still pending: nothing to continue.
    await stepUp(owner, ownerSession);
    const pending = await run(owner, "platform_updates.continue", {
      requestId,
      sessionHash: ownerSession,
    });
    expect(message(pending)).toContain("Only an update that Caelo's converge job was installing");

    await admin(
      (tx) =>
        tx`UPDATE platform_update_requests SET status = 'running', started_at = now(), execution = 'conv-dead' WHERE id = ${requestId}::uuid`,
    );
    // The refusal above left the confirmation unused; it authorizes this
    // one continue, and the next needs a new one. Never the AI or another user.
    const continued = await run(owner, "platform_updates.continue", {
      requestId,
      sessionHash: ownerSession,
    });
    expect(continued.ok).toBe(true);
    const again = await run(owner, "platform_updates.continue", {
      requestId,
      sessionHash: ownerSession,
    });
    expect(again.ok).toBe(false);
    expect(
      (await run(AI, "platform_updates.continue", { requestId, sessionHash: ownerSession })).ok,
    ).toBe(false);
    await stepUp(editor, editorSession);
    expect(
      (await run(editor, "platform_updates.continue", { requestId, sessionHash: editorSession }))
        .ok,
    ).toBe(false);

    const got = await okValue<{ events: { message: string }[] }>(AI, "platform_updates.get", {
      requestId,
    });
    expect(got.events.some((e) => e.message.startsWith("Continued by the Owner"))).toBe(true);
  });

  it("an app-roll that died is not continued (the next request ends and retries it)", async () => {
    await stepUp(owner, ownerSession);
    const { requestId } = await okValue<{ requestId: string }>(owner, "platform_updates.request", {
      targetVersion: NEWEST,
      sessionHash: ownerSession,
    });
    await admin(
      (tx) =>
        tx`UPDATE platform_update_requests SET status = 'running', started_at = now() WHERE id = ${requestId}::uuid`,
    );
    await stepUp(owner, ownerSession);
    const r = await run(owner, "platform_updates.continue", {
      requestId,
      sessionHash: ownerSession,
    });
    expect(message(r)).toContain("Only an update that Caelo's converge job was installing");
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
    securitySoakHours: 2,
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
    await stepUp(owner, ownerSession, { purpose: "update_policy" });
    const after = await okValue<{ mode: string; windowStart: string }>(
      owner,
      "platform_update_policy.set",
      { policy, sessionHash: ownerSession },
    );
    expect(after).toMatchObject({ mode: "auto", windowStart: "02:00" });
  });

  it("one step-up authorizes one change, even when two race", async () => {
    await stepUp(owner, ownerSession, { purpose: "update_policy" });
    const results = await Promise.all(
      [24, 48].map((soakHours) =>
        run(owner, "platform_update_policy.set", {
          policy: { ...policy, soakHours },
          sessionHash: ownerSession,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(message(results.find((r) => !r.ok) as (typeof results)[number])).toStartWith(
      "step_up_required:",
    );
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

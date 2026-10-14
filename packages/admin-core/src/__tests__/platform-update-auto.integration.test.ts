// SPDX-License-Identifier: MPL-2.0

/**
 * #696 Phase 5 — automatic updates against real Postgres (§6):
 *
 *   - pause / resume / policy set: Owner + password confirmation only, never
 *     the AI; saving the policy never lifts a pause;
 *   - the scheduler tick (system only): its lease (concurrent ticks make
 *     one decision), the decision written as a request exactly like a
 *     manual install (trigger auto, no requester, auto_basis), one
 *     automatic attempt per release, no install next to a running one,
 *     soak / security soak / pause / infra change / notify mode, an Owner
 *     pause whose end passed is lifted, a dead automatic run is ended and
 *     pauses, a lost upgrader start is retried;
 *   - the outbox: one email per event however often ticks run, claimed by
 *     one sender, Owners as recipients, delivery recorded (incl. "no
 *     transport configured");
 *   - runAutoUpdateTick end to end with a fake upgrader + manifest reader,
 *     and on self-hosted through the update agent (#696 Phase 4c): queued
 *     only while the agent checks in without a problem;
 *   - the AI reads the scheduler's status, never writes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import {
  CAELO_VERSION,
  type ExecutionContext,
  type PlatformUpdateAgentStatus,
} from "@caelo-cms/shared";
import { SQL } from "bun";
import { runAutoUpdateTick } from "../platform-updates/scheduler.js";
import { registerAdminOps } from "../register.js";
import { sessionHashOf } from "../security/step-up/gate.js";
import { agentUpgraderTrigger } from "../security/upgrader/agent-trigger.js";
import type { UpgraderTrigger } from "../security/upgrader/job-trigger.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const P = "pu-auto";
const OWNER_EMAIL = `${P}-owner@example.com`;
const EDITOR_EMAIL = `${P}-editor@example.com`;

const [MAJ, MIN, PAT] = CAELO_VERSION.split(".").map(Number) as [number, number, number];
const NEXT_PATCH = `${MAJ}.${MIN}.${PAT + 1}`;
const NEXT_MINOR = `${MAJ}.${MIN + 1}.0`;

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

const FACTS = { security: false, advisories: [], contractMigrations: false, infraChange: false };
const SECURITY = { ...FACTS, security: true, advisories: ["GHSA-abcd-efgh-jkmp"] };

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

const run = (ctx: ExecutionContext, op: string, input: unknown) =>
  execute(registry, adapter, ctx, op, input);

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

/** The real step-up op: the user re-enters their password for a policy change. */
async function stepUp(ctx: ExecutionContext, sessionHash: string) {
  await okValue(ctx, "step_up.confirm_password", {
    sessionHash,
    purpose: "update_policy",
    password: "harbor-lantern-quill-71",
  });
}

const POLICY = {
  mode: "auto",
  autoSecurity: true,
  autoPatch: true,
  autoMinor: false,
  channel: "stable",
  windowStart: null,
  windowEnd: null,
  windowTimezone: "UTC",
  soakHours: 24,
  securitySoakHours: 2,
};

/** Write the policy directly (the ops are tested separately). */
async function setPolicy(over: Record<string, unknown> = {}): Promise<void> {
  const p = { ...POLICY, ...over };
  await admin(
    (
      tx,
    ) => tx`UPDATE platform_update_policy SET mode = ${p.mode}, auto_security = ${p.autoSecurity},
      auto_patch = ${p.autoPatch}, auto_minor = ${p.autoMinor}, soak_hours = ${p.soakHours},
      security_soak_hours = ${p.securitySoakHours}, window_start = ${p.windowStart}::time,
      window_end = ${p.windowEnd}::time, window_timezone = ${p.windowTimezone} WHERE id = 1`,
  );
}

async function setLatest(version: string | null, publishedHoursAgo = 48): Promise<void> {
  await admin(
    (tx) => tx`UPDATE release_check_cache SET latest_version = ${version},
      published_at = now() - make_interval(hours => ${publishedHoursAgo}) WHERE id = 1`,
  );
}

/** Let the next tick run (the lease is time-based). */
const expireLease = () =>
  admin((tx) => tx`UPDATE platform_update_scheduler SET last_run_at = NULL WHERE id = 1`);

async function tick(facts: unknown = FACTS, opts: { factsVersion?: string | null } = {}) {
  const latest = (
    await admin((tx) => tx`SELECT latest_version FROM release_check_cache WHERE id = 1`)
  )[0] as { latest_version: string | null };
  return okValue<{
    ran: boolean;
    action: string | null;
    reason: string | null;
    requestId: string | null;
    restartRequestId: string | null;
    notificationsQueued: number;
  }>(SYSTEM, "platform_updates.scheduler_tick", {
    holder: "test-instance",
    intervalSeconds: 900,
    factsVersion: opts.factsVersion === undefined ? latest.latest_version : opts.factsVersion,
    facts,
    upgraderAvailable: true,
    upgraderProblem: null,
  });
}

const requests = () =>
  admin(
    (tx) => tx`SELECT id::text AS id, target_version, trigger, auto_basis, requested_by, status
                 FROM platform_update_requests ORDER BY requested_at`,
  ) as Promise<
    {
      id: string;
      target_version: string;
      trigger: string;
      auto_basis: string | null;
      requested_by: string | null;
      status: string;
    }[]
  >;

const notifications = () =>
  admin(
    (tx) => tx`SELECT kind, target_version, dedupe_key, subject, body, delivery_status,
                      delivery_detail, recipients
                 FROM platform_update_notifications ORDER BY created_at`,
  ) as Promise<
    {
      kind: string;
      target_version: string;
      dedupe_key: string;
      subject: string;
      body: string;
      delivery_status: string;
      delivery_detail: string | null;
      recipients: string[];
    }[]
  >;

async function resetState(): Promise<void> {
  await admin(async (tx) => {
    await tx`DELETE FROM platform_update_notifications`;
    await tx`DELETE FROM platform_update_requests`;
    await tx`DELETE FROM platform_update_agent`;
    await tx`UPDATE platform_update_scheduler SET lease_holder = NULL, last_run_at = NULL,
      last_version = NULL, last_action = NULL, last_reason = NULL, last_wait_until = NULL`;
    await tx`UPDATE platform_update_policy SET mode = 'notify', auto_security = false,
      auto_patch = false, auto_minor = false, channel = 'stable', window_start = NULL,
      window_end = NULL, window_timezone = 'UTC', soak_hours = 24, security_soak_hours = 2,
      paused = false, paused_reason = NULL, paused_at = NULL, paused_until = NULL,
      paused_by = NULL WHERE id = 1`;
    await tx`UPDATE email_config SET transport = 'none', from_address = '', config_json = '{}'
      WHERE id = 1`;
  });
}

async function wipeUsers(): Promise<void> {
  await admin(async (tx) => {
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
  await wipeUsers();
  owner = await createUser(OWNER_EMAIL, ["owner"]);
  editor = await createUser(EDITOR_EMAIL, ["editor"]);
});

afterAll(async () => {
  await resetState();
  await wipeUsers();
});

beforeEach(async () => {
  await resetState();
  ownerSession = await login(OWNER_EMAIL);
  editorSession = await login(EDITOR_EMAIL);
});

describe("pause / resume / set (Owner + step-up)", () => {
  it("pausing needs the Owner and a password confirmation; the AI cannot", async () => {
    const until = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      message(
        await run(AI, "platform_update_policy.pause", {
          until,
          sessionHash: ownerSession,
        }),
      ),
    ).toBe("ActorScopeRejected");
    expect(
      message(
        await run(owner, "platform_update_policy.pause", {
          until,
          sessionHash: ownerSession,
        }),
      ),
    ).toStartWith("step_up_required:");
    expect(
      message(
        await run(editor, "platform_update_policy.pause", {
          until,
          sessionHash: editorSession,
        }),
      ),
    ).toContain("platform.update");

    await stepUp(owner, ownerSession);
    const paused = await okValue<{ paused: boolean; pausedUntil: string; pausedByOwner: boolean }>(
      owner,
      "platform_update_policy.pause",
      { until, reason: "Launch week", sessionHash: ownerSession },
    );
    expect(paused).toMatchObject({ paused: true, pausedByOwner: true });
    expect(new Date(paused.pausedUntil).toISOString()).toBe(until);
    // The sign-in was used up.
    expect(
      message(
        await run(owner, "platform_update_policy.resume", {
          sessionHash: ownerSession,
        }),
      ),
    ).toStartWith("step_up_required:");
    const audit = await admin(
      (tx) => tx`SELECT result_summary FROM audit_events
                  WHERE operation = 'platform_update_policy.pause' AND succeeded`,
    );
    expect((audit as unknown as { result_summary: string }[]).at(-1)?.result_summary).toContain(
      "paused until",
    );
  });

  it("refuses a pause that ends in the past", async () => {
    await stepUp(owner, ownerSession);
    const r = await run(owner, "platform_update_policy.pause", {
      until: new Date(Date.now() - 60_000).toISOString(),
      sessionHash: ownerSession,
    });
    expect(message(r)).toContain("must end in the future");
  });

  it("saving the policy keeps the pause; resume lifts it", async () => {
    await stepUp(owner, ownerSession);
    await okValue(owner, "platform_update_policy.pause", {
      until: null,
      sessionHash: ownerSession,
    });
    await stepUp(owner, ownerSession);
    const saved = await okValue<{ paused: boolean; securitySoakHours: number }>(
      owner,
      "platform_update_policy.set",
      { policy: { ...POLICY, securitySoakHours: 0 }, sessionHash: ownerSession },
    );
    expect(saved).toMatchObject({ paused: true, securitySoakHours: 0 });
    await stepUp(owner, ownerSession);
    const resumed = await okValue<{ paused: boolean; pausedUntil: string | null }>(
      owner,
      "platform_update_policy.resume",
      { sessionHash: ownerSession },
    );
    expect(resumed).toMatchObject({ paused: false, pausedUntil: null });
    await stepUp(owner, ownerSession);
    expect(
      message(
        await run(owner, "platform_update_policy.resume", {
          sessionHash: ownerSession,
        }),
      ),
    ).toContain("not paused");
  });

  it("rejects a security soak longer than the normal soak", async () => {
    const r = await run(owner, "platform_update_policy.set", {
      policy: { ...POLICY, securitySoakHours: 48 },
      sessionHash: ownerSession,
    });
    expect(r.ok === false && r.error.kind).toBe("ValidationFailed");
  });
});

describe("platform_updates.scheduler_tick", () => {
  it("is system-only: the AI and the Owner cannot run it", async () => {
    for (const ctx of [AI, owner]) {
      const r = await run(ctx, "platform_updates.scheduler_tick", {
        holder: "x",
        intervalSeconds: 900,
        factsVersion: null,
        facts: FACTS,
        upgraderAvailable: true,
        upgraderProblem: null,
      });
      expect(r.ok).toBe(false);
    }
  });

  it("queues an automatic install like a manual one, once, under a lease", async () => {
    await setPolicy();
    await setLatest(NEXT_PATCH, 48);
    // Five instances tick at once: one decides.
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => tick()));
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    const winner = results.find((r) => r.ran);
    expect(winner).toMatchObject({ action: "install" });

    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_version: NEXT_PATCH,
      trigger: "auto",
      auto_basis: "patch",
      requested_by: null,
      status: "pending",
    });
    expect(winner?.requestId).toBe(rows[0]?.id as string);
    const events = await admin(
      (tx) =>
        tx`SELECT phase, message FROM platform_update_events WHERE request_id = ${rows[0]?.id}::uuid`,
    );
    expect((events as unknown as { message: string }[])[0]?.message).toContain(
      "Automatic install queued by the update policy",
    );
    const audit = await admin(
      (tx) => tx`SELECT actor_id::text AS actor_id, result_summary FROM audit_events
                  WHERE operation = 'platform_updates.scheduler_tick' AND entity_id = ${rows[0]?.id}`,
    );
    expect((audit as unknown as { actor_id: string; result_summary: string }[])[0]).toMatchObject({
      actor_id: SYSTEM.actorId,
      result_summary: `queued automatic ${CAELO_VERSION} → ${NEXT_PATCH} (patch)`,
    });
    expect((await notifications()).map((n) => n.dedupe_key)).toEqual([`scheduled:${NEXT_PATCH}`]);

    // Later ticks: no second request, no second email.
    await expireLease();
    const again = await tick();
    expect(again).toMatchObject({ ran: true, action: "wait", requestId: null });
    expect(again.reason).toContain("under way");
    expect(await requests()).toHaveLength(1);
    expect(await notifications()).toHaveLength(1);
  });

  it("never retries a release whose automatic attempt ended", async () => {
    await setPolicy();
    await setLatest(NEXT_PATCH, 48);
    await tick();
    await admin(
      (tx) => tx`UPDATE platform_update_requests SET status = 'refused', finished_at = now(),
                   status_reason = 'Not installed automatically: outside the maintenance window.'`,
    );
    await expireLease();
    const r = await tick();
    expect(r.action).toBe("notify");
    expect(r.reason).toContain("already tried");
    expect(await requests()).toHaveLength(1);
    // The refusal gets its own email; no extra "available" mail.
    expect((await notifications()).map((n) => n.kind)).toEqual(["scheduled", "failed"]);
  });

  it("does not queue next to an update already in flight", async () => {
    await setPolicy();
    await setLatest(NEXT_PATCH, 48);
    await admin(
      (
        tx,
      ) => tx`INSERT INTO platform_update_requests (target_version, from_version, trigger, requested_by)
                 VALUES (${NEXT_PATCH}, ${CAELO_VERSION}, 'manual', ${owner.actorId}::uuid)`,
    );
    const r = await tick();
    expect(r).toMatchObject({ action: "wait", requestId: null });
    expect(await requests()).toHaveLength(1);
  });

  it("security fixes use their own shorter soak; others wait theirs out", async () => {
    await setPolicy({ autoPatch: false });
    await setLatest(NEXT_PATCH, 3);
    const normal = await tick(FACTS);
    expect(normal.action).toBe("notify");
    await expireLease();
    await setPolicy();
    const waiting = await tick(FACTS);
    expect(waiting.action).toBe("wait");
    const status = await okValue<{ lastAction: string; lastWaitUntil: string }>(
      AI,
      "platform_updates.scheduler_status",
      {},
    );
    expect(status.lastAction).toBe("wait");
    expect(Date.parse(status.lastWaitUntil)).toBeGreaterThan(Date.now() + 20 * 3_600_000);
    await expireLease();
    const security = await tick(SECURITY);
    expect(security.action).toBe("install");
    expect((await requests())[0]?.auto_basis).toBe("security");
  });

  it("infra-changing releases only notify (never queued)", async () => {
    await setPolicy();
    await setLatest(NEXT_MINOR, 48);
    await setPolicy({ autoMinor: true });
    const r = await tick({ ...FACTS, infraChange: true });
    expect(r.action).toBe("needs_cloud_shell");
    expect(await requests()).toHaveLength(0);
    const [n] = await notifications();
    expect(n).toMatchObject({ kind: "needs_cloud_shell", target_version: NEXT_MINOR });
    expect(n?.body).toContain("Cloud Shell");
  });

  it("notify mode emails once per release, and nothing when up to date", async () => {
    await setLatest(NEXT_PATCH, 1);
    expect((await tick()).action).toBe("notify");
    await expireLease();
    await tick();
    expect((await notifications()).map((n) => n.kind)).toEqual(["available"]);
    await setLatest(CAELO_VERSION, 1);
    await expireLease();
    expect((await tick(FACTS, { factsVersion: null })).action).toBe("none");
    expect(await notifications()).toHaveLength(1);
  });

  it("decides nothing when the release moved on mid-tick", async () => {
    await setPolicy();
    await setLatest(NEXT_MINOR, 48);
    const r = await tick(FACTS, { factsVersion: NEXT_PATCH });
    expect(r.action).toBe("blocked");
    expect(await notifications()).toHaveLength(0);
    expect(await requests()).toHaveLength(0);
  });

  it("waits while paused, and lifts an Owner pause whose end has passed", async () => {
    await setPolicy();
    await setLatest(NEXT_PATCH, 48);
    await admin(
      (tx) => tx`UPDATE platform_update_policy SET paused = true, paused_at = now(),
                   paused_reason = 'Launch week', paused_by = ${owner.actorId}::uuid,
                   paused_until = now() + interval '1 day' WHERE id = 1`,
    );
    const waiting = await tick();
    expect(waiting.action).toBe("wait");
    expect(waiting.reason).toContain("paused by the Owner");
    expect(await requests()).toHaveLength(0);

    await admin(
      (tx) => tx`UPDATE platform_update_policy SET paused_until = now() - interval '1 minute'`,
    );
    await expireLease();
    const resumed = await tick();
    expect(resumed.action).toBe("install");
    const policy = await okValue<{ paused: boolean }>(AI, "platform_update_policy.get", {});
    expect(policy.paused).toBe(false);
  });

  it("ends a dead automatic run, pauses, and emails the Owner", async () => {
    await setPolicy();
    await setLatest(NEXT_PATCH, 48);
    await admin(
      (tx) => tx`INSERT INTO platform_update_requests
                   (target_version, from_version, trigger, auto_basis, status, started_at)
                 VALUES (${NEXT_PATCH}, ${CAELO_VERSION}, 'auto', 'patch', 'running',
                         now() - interval '3 hours')`,
    );
    const r = await tick();
    expect(r.action).toBe("notify");
    expect((await requests())[0]?.status).toBe("failed");
    const policy = await okValue<{ paused: boolean; pausedByOwner: boolean }>(
      AI,
      "platform_update_policy.get",
      {},
    );
    expect(policy).toMatchObject({ paused: true, pausedByOwner: false });
    const [n] = await notifications();
    expect(n).toMatchObject({ kind: "failed" });
    expect(n?.body).toContain("paused until you resume");
  });

  it("emails how automatic installs ended, once each", async () => {
    await setLatest(CAELO_VERSION, 1);
    await admin(
      (tx) => tx`INSERT INTO platform_update_requests
                   (target_version, from_version, trigger, auto_basis, status, started_at, finished_at)
                 VALUES (${NEXT_PATCH}, ${CAELO_VERSION}, 'auto', 'patch', 'succeeded', now(), now()),
                        (${NEXT_MINOR}, ${CAELO_VERSION}, 'auto', 'minor', 'needs_cloud_shell', now(), now())`,
    );
    await tick(FACTS, { factsVersion: null });
    await expireLease();
    await tick(FACTS, { factsVersion: null });
    const kinds = (await notifications()).map((n) => n.kind).sort();
    expect(kinds).toEqual(["installed", "needs_cloud_shell"]);
  });

  it("asks to start the upgrader again for a request it never claimed", async () => {
    await admin(
      (tx) => tx`INSERT INTO platform_update_requests
                   (target_version, from_version, trigger, auto_basis, requested_at)
                 VALUES (${NEXT_PATCH}, ${CAELO_VERSION}, 'auto', 'patch', now() - interval '20 minutes')
                 RETURNING id`,
    );
    const [req] = await requests();
    const r = await tick(FACTS, { factsVersion: null });
    expect(r.restartRequestId).toBe(req?.id as string);
  });
});

describe("platform_updates.record_trigger for automatic requests", () => {
  it("the scheduler records its own starts, not the Owner's", async () => {
    const rows = (await admin(
      (
        tx,
      ) => tx`INSERT INTO platform_update_requests (target_version, from_version, trigger, auto_basis)
                 VALUES (${NEXT_PATCH}, ${CAELO_VERSION}, 'auto', 'patch')
                 RETURNING id::text AS id`,
    )) as unknown as { id: string }[];
    const auto = rows[0]?.id as string;
    await okValue(SYSTEM, "platform_updates.record_trigger", {
      requestId: auto,
      outcome: { started: true, execution: "exec-auto-1" },
    });
    await admin((tx) => tx`DELETE FROM platform_update_requests`);
    const manual = (
      (await admin(
        (
          tx,
        ) => tx`INSERT INTO platform_update_requests (target_version, from_version, trigger, requested_by)
                   VALUES (${NEXT_PATCH}, ${CAELO_VERSION}, 'manual', ${owner.actorId}::uuid)
                   RETURNING id::text AS id`,
      )) as unknown as { id: string }[]
    )[0]?.id as string;
    const r = await run(SYSTEM, "platform_updates.record_trigger", {
      requestId: manual,
      outcome: { started: true, execution: "x" },
    });
    expect(message(r)).toContain("No such update request");
    expect(
      (
        await run(AI, "platform_updates.record_trigger", {
          requestId: manual,
          outcome: { started: true, execution: "x" },
        })
      ).ok,
    ).toBe(false);
  });
});

describe("the outbox", () => {
  it("one sender per email, Owners as recipients, delivery recorded", async () => {
    await setLatest(NEXT_PATCH, 1);
    await tick();
    const claims = await Promise.all(
      [1, 2].map(() =>
        okValue<{ notifications: { id: string }[]; recipients: string[] }>(
          SYSTEM,
          "platform_updates.notification_claim",
          { limit: 10 },
        ),
      ),
    );
    const claimed = claims.flatMap((c) => c.notifications.map((n) => n.id));
    expect(claimed).toHaveLength(1);
    const withRows = claims.find((c) => c.notifications.length > 0);
    expect(withRows?.recipients).toContain(OWNER_EMAIL);
    expect(withRows?.recipients).not.toContain(EDITOR_EMAIL);
    await okValue(SYSTEM, "platform_updates.notification_finish", {
      id: claimed[0],
      status: "sent",
      detail: null,
      recipients: [OWNER_EMAIL],
    });
    const [n] = await notifications();
    expect(n).toMatchObject({ delivery_status: "sent", recipients: [OWNER_EMAIL] });
    // The AI sees what went out, and cannot claim or finish.
    const status = await okValue<{ notifications: { deliveryStatus: string }[] }>(
      AI,
      "platform_updates.scheduler_status",
      {},
    );
    expect(status.notifications[0]?.deliveryStatus).toBe("sent");
    expect((await run(AI, "platform_updates.notification_claim", { limit: 1 })).ok).toBe(false);
  });
});

describe("runAutoUpdateTick (the loop's body)", () => {
  const startedRuns: string[] = [];
  const trigger: UpgraderTrigger = {
    async start() {
      startedRuns.push(`run-${startedRuns.length + 1}`);
      return startedRuns.at(-1) as string;
    },
    async latest() {
      return null;
    },
  };
  const manifest = (version: string, infraContractVersion: number) => ({
    ok: true as const,
    manifest: {
      manifestVersion: 1 as const,
      version,
      channel: "stable" as const,
      digests: {
        admin: `sha256:${"a".repeat(64)}`,
        gateway: `sha256:${"b".repeat(64)}`,
        ops: `sha256:${"c".repeat(64)}`,
      },
      minFromVersion: "0.1.0",
      infraContractVersion,
      migrations: {
        contract: false,
        lastContractVersion: null,
        head: "0271_platform_auto_updates",
      },
      security: false,
      advisories: [],
    },
  });

  it("queues, starts the upgrader, and records that email is not set up", async () => {
    await setPolicy({ soakHours: 0, securitySoakHours: 0 });
    await setLatest(NEXT_PATCH, 1);
    const lines: string[] = [];
    const out = await runAutoUpdateTick({
      adapter,
      registry,
      upgrader: () => ({ ok: true, trigger }),
      readManifest: async (v) => manifest(v, 2),
      provider: "gcp",
      holder: "test",
      log: (l) => lines.push(l),
    });
    expect(out).toMatchObject({ ran: true, action: "install" });
    expect(startedRuns).toHaveLength(1);
    const events = await admin(
      (tx) =>
        tx`SELECT message FROM platform_update_events WHERE request_id = ${out.requestId}::uuid ORDER BY id`,
    );
    expect((events as unknown as { message: string }[]).map((e) => e.message).join("\n")).toContain(
      "Upgrader started (run run-1)",
    );
    const [n] = await notifications();
    expect(n).toMatchObject({ kind: "scheduled", delivery_status: "no_transport" });
    expect(lines.join("\n")).toContain("not sent");
  });

  it("does not queue an infra-changing release; sends the email through the transport", async () => {
    await setPolicy({ soakHours: 0, securitySoakHours: 0 });
    await setLatest(NEXT_PATCH, 1);
    await admin(
      (tx) => tx`UPDATE email_config SET transport = 'resend', from_address = 'caelo@example.com',
                   config_json = '{"apiKey":"re_test_key"}' WHERE id = 1`,
    );
    const sent: { to: string; subject: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "https://api.resend.com/emails") {
        const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string };
        sent.push({ to: body.to[0] as string, subject: body.subject });
        return new Response(JSON.stringify({ id: "msg-1" }), { status: 200 });
      }
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      const out = await runAutoUpdateTick({
        adapter,
        registry,
        upgrader: () => ({ ok: true, trigger }),
        // The installed release was converged to contract 2; the new one needs 3.
        readManifest: async (v) => manifest(v, v === CAELO_VERSION ? 2 : 3),
        provider: "gcp",
        holder: "test",
        log: () => {},
      });
      expect(out).toMatchObject({ action: "needs_cloud_shell", requestId: null, delivered: 1 });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(await requests()).toHaveLength(0);
    expect(sent).toEqual([
      { to: OWNER_EMAIL, subject: `Caelo v${NEXT_PATCH} needs you to install it in Cloud Shell` },
    ]);
    const [n] = await notifications();
    expect(n).toMatchObject({ delivery_status: "sent", recipients: [OWNER_EMAIL] });
  });

  it("an unreadable manifest blocks and says so", async () => {
    await setPolicy({ soakHours: 0, securitySoakHours: 0 });
    await setLatest(NEXT_PATCH, 1);
    const out = await runAutoUpdateTick({
      adapter,
      registry,
      upgrader: () => ({ ok: true, trigger }),
      readManifest: async () => ({ ok: false, message: "HTTP 404" }),
      provider: "gcp",
      holder: "test",
      log: () => {},
    });
    expect(out.action).toBe("blocked");
    const status = await okValue<{ lastReason: string }>(
      AI,
      "platform_updates.scheduler_status",
      {},
    );
    expect(status.lastReason).toContain("HTTP 404");
    expect(await requests()).toHaveLength(0);
  });
});

describe("runAutoUpdateTick on self-hosted: through the update agent", () => {
  const manifest = (version: string) => ({
    ok: true as const,
    manifest: {
      manifestVersion: 1 as const,
      version,
      channel: "stable" as const,
      digests: {
        admin: `sha256:${"a".repeat(64)}`,
        gateway: `sha256:${"b".repeat(64)}`,
        ops: `sha256:${"c".repeat(64)}`,
      },
      minFromVersion: "0.1.0",
      // Ignored on self-hosted: its Compose setup is rendered by the release itself.
      infraContractVersion: 9,
      migrations: {
        contract: false,
        lastContractVersion: null,
        head: "0271_platform_auto_updates",
      },
      security: false,
      advisories: [],
    },
  });
  const readAgent = async (): Promise<PlatformUpdateAgentStatus | null> =>
    (
      await okValue<{ agent: PlatformUpdateAgentStatus | null }>(
        SYSTEM,
        "platform_updates.agent_status",
        {},
      )
    ).agent;
  const tickSelfHosted = () =>
    runAutoUpdateTick({
      adapter,
      registry,
      // What the admin wires on self-hosted (lib/server/upgrader.ts).
      upgrader: () => ({ ok: true, trigger: agentUpgraderTrigger(readAgent) }),
      readManifest: async (v) => manifest(v),
      provider: "self-hosted",
      holder: "test",
      log: () => {},
    });
  const beat = (minutesAgo: number, problem: string | null = null) =>
    admin(
      (tx) => tx`INSERT INTO platform_update_agent (id, agent_version, host, last_seen_at, problem)
                 VALUES (1, ${CAELO_VERSION}, 'box-1', now() - make_interval(mins => ${minutesAgo}), ${problem})
                 ON CONFLICT (id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
                   problem = EXCLUDED.problem`,
    );

  it("queues nothing while no agent is set up, and says so", async () => {
    await setPolicy({ soakHours: 0, securitySoakHours: 0 });
    await setLatest(NEXT_PATCH, 1);
    const out = await tickSelfHosted();
    expect(out.action).toBe("blocked");
    const status = await okValue<{ lastReason: string }>(
      AI,
      "platform_updates.scheduler_status",
      {},
    );
    expect(status.lastReason).toContain("update agent is not set up");
    expect(await requests()).toHaveLength(0);
  });

  it("queues nothing while the agent is silent or reports a problem", async () => {
    await setPolicy({ soakHours: 0, securitySoakHours: 0 });
    await setLatest(NEXT_PATCH, 1);
    await beat(30);
    expect((await tickSelfHosted()).action).toBe("blocked");
    await beat(0, "cosign is not installed on the server.");
    await expireLease();
    expect((await tickSelfHosted()).action).toBe("blocked");
    const status = await okValue<{ lastReason: string }>(
      AI,
      "platform_updates.scheduler_status",
      {},
    );
    expect(status.lastReason).toContain("cosign is not installed");
    expect(await requests()).toHaveLength(0);
  });

  it("with the agent checking in: the automatic request is queued for it", async () => {
    await setPolicy({ soakHours: 0, securitySoakHours: 0 });
    await setLatest(NEXT_PATCH, 1);
    await beat(0);
    const out = await tickSelfHosted();
    expect(out).toMatchObject({ ran: true, action: "install" });
    const [req] = await requests();
    expect(req).toMatchObject({
      id: out.requestId,
      trigger: "auto",
      auto_basis: "patch",
      requested_by: null,
      // Pending: the agent claims it on its next poll (job_claim), like a manual one.
      status: "pending",
    });
    const events = await admin(
      (tx) =>
        tx`SELECT message FROM platform_update_events WHERE request_id = ${out.requestId}::uuid ORDER BY id`,
    );
    expect((events as unknown as { message: string }[]).map((e) => e.message).join("\n")).toContain(
      "Upgrader started (run agent@box-1)",
    );
  });
});

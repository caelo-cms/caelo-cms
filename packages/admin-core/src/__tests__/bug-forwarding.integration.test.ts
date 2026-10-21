// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #901 (#904 / #905 / #906) — forwarding AI bug reports to the Caelo
 * bug intake. Real Postgres (§6); the intake is an in-process fake that
 * verifies every signature exactly like the real one must, so a signing
 * regression fails here.
 *
 * Pinned behaviour:
 *   - nothing is queued or sent before the Owner opts in;
 *   - opting in queues new reports; earlier ones need an explicit click;
 *   - the bytes sent equal the Owner's preview and are redacted;
 *   - the install registers its key once, then signs every report;
 *   - retryable failures back off, permanent ones stop, withdrawn consent
 *     un-queues;
 *   - the Owner can re-queue a report that ended in `failed` (#982), only
 *     while forwarding is on;
 *   - the AI can neither give consent nor send earlier reports.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import {
  BUG_INTAKE_HEADERS,
  type BugIntakeClusterInfo,
  bugIntakeRegisterRequest,
  bugIntakeReport,
  bugIntakeSigningString,
  type ExecutionContext,
} from "@caelo-cms/shared";
import { SQL } from "bun";
import { BugIntakeClient } from "../bug-forwarding/client.js";
import { forwardDueReports, refreshClusterStatus } from "../bug-forwarding/worker.js";
import { registerAdminOps } from "../register.js";
import { _setKekForTests } from "../security/secret-box.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "bug-forwarding-test",
};
const HUMAN: ExecutionContext = { ...SYSTEM, actorKind: "human" };
const AI: ExecutionContext = { ...SYSTEM, actorKind: "ai" };

async function admin(fn: (tx: SQL) => Promise<unknown>): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function reset(): Promise<void> {
  await admin(async (tx) => {
    await tx`DELETE FROM ai_bug_reports`;
    await tx`UPDATE telemetry_settings SET bug_forwarding_enabled = false,
      bug_forwarding_decided_at = NULL, install_id = NULL, bug_intake_public_key = NULL,
      bug_intake_private_key_ciphertext = NULL, bug_intake_private_key_iv = NULL,
      bug_intake_private_key_kek_fp = NULL, bug_intake_registered_at = NULL,
      install_ping_enabled = false, error_reporting_enabled = false WHERE id = 1`;
  });
}

/** In-process intake: pins keys on register, verifies signatures on everything else. */
class FakeIntake {
  keys = new Map<string, string>();
  reports: Array<Record<string, unknown>> = [];
  registerCalls = 0;
  /** Next N report answers; empty = accept. */
  answers: Array<{ status: number; body: unknown }> = [];
  clusters = new Map<string, BugIntakeClusterInfo>();

  fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    if (path === "/v1/installs") {
      this.registerCalls++;
      const req = bugIntakeRegisterRequest.parse(JSON.parse(body));
      this.keys.set(req.installId, req.publicKey);
      return new Response(null, { status: 204 });
    }
    const installId = headers.get(BUG_INTAKE_HEADERS.installId) ?? "";
    const key = this.keys.get(installId);
    if (!key) return Response.json({ error: "unknown install", retryable: false }, { status: 401 });
    const publicKey = await crypto.subtle.importKey(
      "raw",
      Buffer.from(key, "base64"),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const message = await bugIntakeSigningString({
      method: "POST",
      path,
      timestamp: headers.get(BUG_INTAKE_HEADERS.timestamp) ?? "",
      body,
    });
    const valid = await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      Buffer.from(headers.get(BUG_INTAKE_HEADERS.signature) ?? "", "base64"),
      new TextEncoder().encode(message),
    );
    if (!valid) return Response.json({ error: "bad signature", retryable: false }, { status: 401 });
    if (path === "/v1/reports") {
      const next = this.answers.shift();
      if (next) return Response.json(next.body, { status: next.status });
      const report = bugIntakeReport.parse(JSON.parse(body));
      this.reports.push(JSON.parse(body));
      const cluster: BugIntakeClusterInfo = {
        clusterId: `c-${report.fingerprint.slice(0, 8)}`,
        status: "open",
        issueUrl: "https://github.com/caelo-cms/caelo-cms/issues/1",
        fixedInVersion: null,
      };
      this.clusters.set(cluster.clusterId, cluster);
      return Response.json(cluster);
    }
    if (path === "/v1/clusters/status") {
      const { clusterIds } = JSON.parse(body) as { clusterIds: string[] };
      return Response.json({
        clusters: clusterIds.flatMap((id) => this.clusters.get(id) ?? []),
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

let intake: FakeIntake;
const worker = () => ({
  adapter,
  registry,
  client: new BugIntakeClient({ baseUrl: "https://intake.test", fetchImpl: intake.fetch }),
});

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function file(title: string, extra: Record<string, unknown> = {}) {
  return op<{ id: string; forwardingState: string }>(SYSTEM, "ai_bug_reports.create", {
    title,
    whatHappened: "screenshot_page ignored the selector for max@example.de",
    expected: "A cropped screenshot.",
    suspectedTool: "screenshot_page",
    evidence: "see https://kunde.example.de/preise",
    ...extra,
  });
}

async function rows() {
  const r = await op<{
    reports: Array<{
      id: string;
      forwardingState: string;
      forwardError: string | null;
      upstreamStatus: string | null;
      upstreamIssueUrl: string | null;
      upstreamFixedIn: string | null;
    }>;
  }>(SYSTEM, "ai_bug_reports.list", { limit: 200 });
  return r.reports;
}

beforeAll(async () => {
  // The install's intake signing key is sealed with the KEK. Set it here
  // rather than relying on CAELO_SECRET_KEK or on another test file having
  // left one behind: that ordering dependency is what broke this suite.
  _setKekForTests(new Uint8Array(32).fill(23));
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

beforeEach(async () => {
  await reset();
  intake = new FakeIntake();
});

afterAll(async () => {
  await reset();
  await adapter.close();
  _setKekForTests(null);
});

describe("bug forwarding", () => {
  it("keeps everything local and sends nothing before the Owner opts in", async () => {
    const r = await file("BF before opt-in");
    expect(r.forwardingState).toBe("local_only");
    expect(await forwardDueReports(worker())).toBe(0);
    expect(intake.registerCalls).toBe(0);
    const state = await op<{
      enabled: boolean;
      installId: string | null;
      decidedAt: string | null;
    }>(SYSTEM, "bug_forwarding.get", {});
    expect(state).toMatchObject({ enabled: false, installId: null, decidedAt: null });
  });

  it("the AI can neither consent nor send earlier reports", async () => {
    for (const name of ["bug_forwarding.set", "bug_forwarding.queue_unsent"]) {
      const r = await execute(
        registry,
        adapter,
        AI,
        name,
        name.endsWith("set") ? { enabled: true } : {},
      );
      expect(r.ok).toBe(false);
    }
  });

  it("after opt-in, registers once, sends the previewed bytes signed and records the cluster", async () => {
    const set = await op<{ installId: string }>(HUMAN, "bug_forwarding.set", { enabled: true });
    expect(set.installId).toMatch(/^[0-9a-f-]{36}$/);
    const a = await file("BF first");
    const b = await file("BF second");
    expect(a.forwardingState).toBe("queued");

    const preview = await op<{ payload: Record<string, unknown> }>(
      HUMAN,
      "bug_forwarding.preview",
      { reportId: a.id },
    );
    expect(await forwardDueReports(worker())).toBe(2);
    expect(intake.registerCalls).toBe(1);
    expect(intake.reports.find((r) => r.reportId === a.id)).toEqual(preview.payload);
    // Redacted on the install, before it left.
    expect(JSON.stringify(intake.reports)).not.toContain("max@example.de");
    expect(JSON.stringify(intake.reports)).not.toContain("kunde.example.de");

    const listed = (await rows()).filter((r) => r.id === a.id || r.id === b.id);
    expect(listed.every((r) => r.forwardingState === "sent")).toBe(true);
    expect(listed[0]?.upstreamStatus).toBe("open");
    expect(listed[0]?.upstreamIssueUrl).toContain("/issues/1");

    // The key is pinned: a later report signs without registering again.
    await file("BF third");
    await forwardDueReports(worker());
    expect(intake.registerCalls).toBe(1);
    expect(intake.reports.length).toBe(3);
  });

  it("the bug_report result tells the AI a queued report will reach the Caelo team", async () => {
    await op(HUMAN, "bug_forwarding.set", { enabled: true });
    const { bugReportTool, bugReportToolInput } = await import("../ai/tools/bug-report.js");
    const r = await bugReportTool.handler(
      SYSTEM,
      bugReportToolInput.parse({ title: "BF tool", whatHappened: "x", expected: "y" }),
      { adapter, registry } as Parameters<typeof bugReportTool.handler>[2],
    );
    expect(r.content).toContain("will be sent to the Caelo team");
  });

  it("backs off on a retryable answer and stops on a permanent refusal", async () => {
    await op(HUMAN, "bug_forwarding.set", { enabled: true });
    const a = await file("BF retry");
    intake.answers.push({ status: 503, body: { error: "maintenance", retryable: true } });
    await forwardDueReports(worker());
    let row = (await rows()).find((r) => r.id === a.id);
    expect(row?.forwardingState).toBe("queued");
    expect(row?.forwardError).toContain("maintenance");
    // Not due again yet: the backoff holds it.
    expect(await forwardDueReports(worker())).toBe(0);

    const b = await file("BF refused");
    intake.answers.push({ status: 422, body: { error: "report too large", retryable: false } });
    await forwardDueReports(worker());
    row = (await rows()).find((r) => r.id === b.id);
    expect(row?.forwardingState).toBe("failed");
    expect(row?.forwardError).toContain("report too large");
  });

  it("a report that cannot be built stops with the reason instead of blocking the queue", async () => {
    await op(HUMAN, "bug_forwarding.set", { enabled: true });
    const broken = await file("BF broken");
    const fine = await file("BF fine");
    // A fingerprint the wire schema refuses (only possible through old or hand-edited rows).
    await admin(
      (tx) => tx`UPDATE ai_bug_reports SET fingerprint = 'not-hex' WHERE id = ${broken.id}::uuid`,
    );
    await forwardDueReports(worker());
    const all = await rows();
    expect(all.find((r) => r.id === broken.id)).toMatchObject({ forwardingState: "failed" });
    expect(all.find((r) => r.id === broken.id)?.forwardError).toContain("Could not build");
    expect(all.find((r) => r.id === fine.id)?.forwardingState).toBe("sent");
  });

  it("withdrawn consent un-queues what has not left; earlier reports need an explicit send", async () => {
    const early = await file("BF early");
    await op(HUMAN, "bug_forwarding.set", { enabled: true });
    const queued = await file("BF queued");
    const off = await op<{ unqueued: number }>(HUMAN, "bug_forwarding.set", { enabled: false });
    expect(off.unqueued).toBe(1);
    expect((await rows()).find((r) => r.id === queued.id)?.forwardingState).toBe("local_only");

    await op(HUMAN, "bug_forwarding.set", { enabled: true });
    const sent = await op<{ queued: number }>(HUMAN, "bug_forwarding.queue_unsent", {});
    expect(sent.queued).toBe(2);
    await forwardDueReports(worker());
    const ids = intake.reports.map((r) => r.reportId);
    expect(ids).toContain(early.id);
    expect(ids).toContain(queued.id);
  });

  it("the Owner re-queues a report that ended in failed and the next tick sends it (#982)", async () => {
    await op(HUMAN, "bug_forwarding.set", { enabled: true });
    const a = await file("BF failed then resent");
    // The intake was unreachable for every attempt: the report used up its
    // retries and stopped.
    await admin(
      (tx) => tx`UPDATE ai_bug_reports SET forwarding_state = 'failed', next_forward_at = NULL,
        forward_attempts = 8, forward_error = 'fetch failed: connection refused'
        WHERE id = ${a.id}::uuid`,
    );
    // A closed report is not worth sending; it stays as it is.
    const closed = await file("BF failed but fixed");
    await admin(
      (tx) => tx`UPDATE ai_bug_reports SET forwarding_state = 'failed', next_forward_at = NULL,
        status = 'fixed' WHERE id = ${closed.id}::uuid`,
    );
    const before = await op<{ counts: { failed: number; unsent: number } }>(
      HUMAN,
      "bug_forwarding.get",
      {},
    );
    expect(before.counts).toMatchObject({ failed: 2, unsent: 1 });

    const r = await op<{ queued: number; retried: number }>(
      HUMAN,
      "bug_forwarding.queue_unsent",
      {},
    );
    expect(r).toEqual({ queued: 1, retried: 1 });
    let row = (await rows()).find((x) => x.id === a.id);
    expect(row).toMatchObject({ forwardingState: "queued", forwardError: null });

    // A fresh start: the next tick claims it at once, and a retryable answer
    // keeps it queued instead of failing on the old attempt count.
    intake.answers.push({ status: 503, body: { error: "maintenance", retryable: true } });
    expect(await forwardDueReports(worker())).toBe(1);
    row = (await rows()).find((x) => x.id === a.id);
    expect(row?.forwardingState).toBe("queued");

    await admin(
      (tx) => tx`UPDATE ai_bug_reports SET next_forward_at = now() WHERE id = ${a.id}::uuid`,
    );
    expect(await forwardDueReports(worker())).toBe(1);
    expect(intake.reports.map((x) => x.reportId)).toEqual([a.id]);
    row = (await rows()).find((x) => x.id === a.id);
    expect(row).toMatchObject({ forwardingState: "sent", forwardError: null });
    expect((await rows()).find((x) => x.id === closed.id)?.forwardingState).toBe("failed");
  });

  it("re-sending is refused while forwarding is off, with the next step", async () => {
    await op(HUMAN, "bug_forwarding.set", { enabled: true });
    const a = await file("BF failed while off");
    await op(HUMAN, "bug_forwarding.set", { enabled: false });
    await admin(
      (tx) => tx`UPDATE ai_bug_reports SET forwarding_state = 'failed', forward_attempts = 8
        WHERE id = ${a.id}::uuid`,
    );
    const r = await execute(registry, adapter, HUMAN, "bug_forwarding.queue_unsent", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("Turn on");
    expect((await rows()).find((x) => x.id === a.id)?.forwardingState).toBe("failed");
  });

  it("refreshes upstream status so the Owner learns a fix shipped", async () => {
    await op(HUMAN, "bug_forwarding.set", { enabled: true });
    const a = await file("BF status");
    await forwardDueReports(worker());
    const clusterId = [...intake.clusters.keys()][0]!;
    intake.clusters.set(clusterId, {
      clusterId,
      status: "fixed",
      issueUrl: "https://github.com/caelo-cms/caelo-cms/issues/1",
      fixedInVersion: "0.11.0",
    });
    // Force staleness so the refresh picks it up now.
    await admin(
      (tx) => tx`UPDATE ai_bug_reports SET upstream_checked_at = now() - interval '1 day'`,
    );
    expect(await refreshClusterStatus(worker())).toBe(1);
    const row = (await rows()).find((r) => r.id === a.id);
    expect(row?.upstreamStatus).toBe("fixed");
    expect(row?.upstreamFixedIn).toBe("0.11.0");
  });

  it("the Owner's telemetry toggle passes RLS (0318 policy fix)", async () => {
    const r = await execute(registry, adapter, HUMAN, "telemetry.set", {
      installPingEnabled: false,
      errorReportingEnabled: true,
    });
    expect(r.ok).toBe(true);
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — the job's reporter: a small input goes inline, a large one
 * in parts the action then names; a busy or starting admin is retried, a
 * `409` stops the attempt for good, and a refusal or an admin that stays
 * away ends the call with the reason.
 */

import { describe, expect, it } from "bun:test";
import {
  createJobReporter,
  isPassingReportFault,
  JobStoppedError,
  ReportError,
  type ReportTransport,
} from "../job-reporter.js";
import {
  INLINE_PAYLOAD_CHARS,
  type JobOrder,
  type ReportAnswer,
  type ReportEnvelope,
} from "../protocol.js";

const ORDER: JobOrder = {
  version: "0.12.0",
  kind: "quality_audit",
  subjectId: "00000000-0000-4000-8000-000000001359",
  attempt: 2,
  token: "t".repeat(43),
};

type Reply = { status: number; answer: ReportAnswer } | Error;

/** A transport answering from `replies` in order (the last one repeats). */
function scripted(replies: Reply[]): ReportTransport & { sent: ReportEnvelope[] } {
  const sent: ReportEnvelope[] = [];
  let i = 0;
  return {
    label: "test",
    sent,
    async send(envelope) {
      sent.push(envelope);
      const reply = replies[Math.min(i, replies.length - 1)] as Reply;
      i += 1;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

const okReply = (value: unknown = {}): Reply => ({ status: 200, answer: { ok: true, value } });
const refusal = (status: number, code: string, retryAfterSeconds?: number): Reply => ({
  status,
  answer: {
    ok: false,
    error: { code, message: `${code}!` },
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  },
});

/**
 * An admin like the real one: it holds parts by upload id, reads an upload
 * once (also when the action then fails), and fails the action with a 500
 * `failures` times before it runs it.
 */
function readOnceAdmin(failures: number) {
  const held = new Map<string, Map<number, string>>();
  const log: string[] = [];
  const actions: ReportEnvelope[] = [];
  let failuresLeft = failures;
  let mostHeld = 0;
  const reply = (r: Reply) => r as { status: number; answer: ReportAnswer };
  const transport: ReportTransport = {
    label: "test",
    async send(envelope) {
      if (envelope.action === "upload-part") {
        const p = envelope.payload as { uploadId: string; part: number; data: string };
        const parts = held.get(p.uploadId) ?? new Map<number, string>();
        parts.set(p.part, p.data);
        held.set(p.uploadId, parts);
        mostHeld = Math.max(
          mostHeld,
          [...held.values()].reduce((n, m) => n + m.size, 0),
        );
        log.push("part");
        return reply(okReply());
      }
      if (!envelope.upload) return reply(okReply());
      actions.push(envelope);
      const parts = held.get(envelope.upload.uploadId);
      if (parts?.size !== envelope.upload.parts) {
        log.push("gone");
        return reply(refusal(400, "incomplete-upload"));
      }
      held.delete(envelope.upload.uploadId);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        log.push("failed");
        return reply(refusal(500, "failed"));
      }
      log.push("ran");
      return reply(okReply("recorded"));
    },
  };
  return { transport, log, actions, mostHeld: () => mostHeld };
}

function clock() {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
}

describe("createJobReporter", () => {
  it("sends a small input inline, as this attempt", async () => {
    const t = scripted([okReply({ kind: "run" })]);
    const r = createJobReporter(ORDER, t);
    expect(await r.call("start")).toEqual({ kind: "run" });
    expect(t.sent).toEqual([
      { subjectId: ORDER.subjectId, attempt: 2, action: "start", payload: {} },
    ]);
  });

  it("sends a large input in parts first, then the action naming them", async () => {
    const t = scripted([okReply()]);
    const r = createJobReporter(ORDER, t);
    const big = { blob: "x".repeat(INLINE_PAYLOAD_CHARS * 3) };
    await r.call("result", big);
    const parts = t.sent.filter((e) => e.action === "upload-part");
    expect(parts.length).toBeGreaterThan(1);
    const last = t.sent.at(-1) as ReportEnvelope;
    expect(last.action).toBe("result");
    expect(last.payload).toBeUndefined();
    expect(last.upload?.parts).toBe(parts.length);
    const uploadId = last.upload?.uploadId;
    const joined = parts
      .map((e) => e.payload as { uploadId: string; part: number; data: string })
      .map((p) => {
        expect(p.uploadId).toBe(uploadId as string);
        return p;
      })
      .sort((a, b) => a.part - b.part)
      .map((p) => p.data)
      .join("");
    expect(JSON.parse(joined)).toEqual(big);
  });

  it("sends the parts once more when the admin no longer holds them (it reads an upload once)", async () => {
    const big = { blob: "x".repeat(INLINE_PAYLOAD_CHARS * 2) };
    const answers: Reply[] = [];
    const t: ReportTransport & { sent: ReportEnvelope[] } = {
      label: "test",
      sent: [],
      async send(envelope) {
        t.sent.push(envelope);
        // The first time the action comes, its parts are gone.
        if (envelope.action === "result" && !answers.length) {
          answers.push(refusal(400, "incomplete-upload"));
          return refusal(400, "incomplete-upload") as { status: number; answer: ReportAnswer };
        }
        return okReply("recorded") as { status: number; answer: ReportAnswer };
      },
    };
    const r = createJobReporter(ORDER, t);
    expect(await r.call("result", big)).toBe("recorded");
    const actions = t.sent.filter((e) => e.action === "result");
    expect(actions).toHaveLength(2);
    // The same upload: a part sent again replaces itself.
    expect(actions[0]?.upload?.uploadId).toBe(actions[1]?.upload?.uploadId as string);
    const parts = t.sent.filter((e) => e.action === "upload-part");
    expect(parts).toHaveLength(2 * (actions[0]?.upload?.parts ?? 0));
  });

  it("#1359 review: an uploaded action that fails after the admin read its parts is sent again with its parts, as often as the budget allows", async () => {
    const c = clock();
    const admin = readOnceAdmin(2);
    const r = createJobReporter(ORDER, admin.transport, { sleep: c.sleep, now: c.now });
    const big = { blob: "x".repeat(INLINE_PAYLOAD_CHARS * 2) };
    expect(await r.call("batch", big)).toBe("recorded");
    const n = admin.actions[0]?.upload?.parts ?? 0;
    const parts = Array.from({ length: n }, () => "part");
    expect(admin.log).toEqual([
      ...parts,
      "failed",
      "gone",
      ...parts,
      "failed",
      "gone",
      ...parts,
      "ran",
    ]);
    // One upload throughout: the run never holds more than one copy.
    expect(new Set(admin.actions.map((e) => e.upload?.uploadId)).size).toBe(1);
    expect(admin.mostHeld()).toBe(n);
  });

  it("#1359 review: an uploaded action that keeps failing ends on its own failure, a passing fault, not on the parts its retry found gone", async () => {
    const c = clock();
    const admin = readOnceAdmin(Number.POSITIVE_INFINITY);
    const r = createJobReporter(ORDER, admin.transport, { sleep: c.sleep, now: c.now });
    const big = { blob: "x".repeat(INLINE_PAYLOAD_CHARS * 2) };
    const e = await r.call("batch", big).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ReportError);
    expect((e as ReportError).status).toBe(500);
    expect((e as ReportError).code).toBe("failed");
    expect(isPassingReportFault(e)).toBe(true);
    // Retried for the whole budget, not given up after two failures.
    expect(admin.log.filter((l) => l === "failed").length).toBeGreaterThan(5);
    expect(c.now()).toBeLessThanOrEqual(3 * 60_000);
  });

  it("retries a starting or busy admin, waiting as a 429 asks", async () => {
    const c = clock();
    const t = scripted([
      refusal(503, "unavailable"),
      new Error("ECONNRESET"),
      refusal(429, "rate-limited", 7),
      okReply("done"),
    ]);
    const r = createJobReporter(ORDER, t, { sleep: c.sleep, now: c.now });
    expect(await r.call("heartbeat")).toBe("done");
    expect(t.sent).toHaveLength(4);
    expect(c.slept[2]).toBe(7000);
  });

  it("stops the attempt for good on a 409, without sending again", async () => {
    const t = scripted([refusal(409, "stale")]);
    const r = createJobReporter(ORDER, t);
    await expect(r.call("source", { name: "modules" })).rejects.toBeInstanceOf(JobStoppedError);
    expect(r.stopped).toBe(true);
    await expect(r.call("result", {})).rejects.toBeInstanceOf(JobStoppedError);
    expect(t.sent).toHaveLength(1);
  });

  it("does not retry a refusal; the error names the action and the reason", async () => {
    const t = scripted([refusal(400, "bad-input")]);
    const r = createJobReporter(ORDER, t);
    const e = await r.call("result", {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ReportError);
    expect((e as ReportError).status).toBe(400);
    expect((e as ReportError).message).toContain('"result"');
    expect((e as ReportError).message).toContain("bad-input");
    expect(t.sent).toHaveLength(1);
  });

  it("gives up on an admin that stays unreachable past the budget", async () => {
    const c = clock();
    const t = scripted([new Error("connect ETIMEDOUT")]);
    const r = createJobReporter(ORDER, t, { sleep: c.sleep, now: c.now, retryBudgetMs: 10_000 });
    const e = await r.call("heartbeat").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ReportError);
    expect((e as ReportError).code).toBe("unreachable");
    expect(c.now()).toBeLessThanOrEqual(10_000);
  });
});

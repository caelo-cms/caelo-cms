// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — who may report to `POST /api/internal/jobs/<kind>/report`,
 * and how much:
 *
 *   - the kind's own service account through IAP (its verified assertion,
 *     `CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT` for the quality audit) — and
 *     then still only with the attempt's token (admin-core dispatch);
 *   - nobody else: another IAP identity, a forged assertion, no IAP at all,
 *     and nobody at all on an install whose jobs run inside the admin;
 *   - a body over the cap is refused while it streams in, whatever its
 *     Content-Length claims.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  type AdmittedReport,
  createIapVerifier,
  IAP_ASSERTION_HEADER,
  iapTestKeyPairForTests,
  MAX_REPORT_BODY_BYTES,
  type ReportResponse,
  setIapVerifierForTests,
  signIapTestAssertionForTests,
} from "@caelo-cms/admin-core";
import { POST } from "../../routes/api/internal/jobs/[kind]/report/+server.js";
import { authorizeJobReport, keptAliveAnswer, readReportBody } from "./reporting-jobs.js";

const AUDIENCE = "/projects/42/locations/europe-west1/services/caelo-production-admin";
const RUNNER_SA = "caelo-production-audit-run@p.iam.gserviceaccount.com";
const KEY = iapTestKeyPairForTests("k1");
const OTHER_KEY = iapTestKeyPairForTests("k1");
const env = { CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT: RUNNER_SA };

beforeAll(() => {
  setIapVerifierForTests(
    createIapVerifier({
      audience: () => AUDIENCE,
      keys: async () => ({ [KEY.kid]: KEY.publicPem }),
    }),
  );
});
afterAll(() => setIapVerifierForTests(null));

const reportRequest = (headers: Record<string, string>, body?: BodyInit) =>
  new Request("https://admin.example.com/api/internal/jobs/quality_audit/report", {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body }),
  });

/** A refusal is returned, never thrown (SvelteKit makes a thrown Response a 500). */
async function status(p: Promise<Response | null>): Promise<number | "ok"> {
  const refused = await p;
  return refused === null ? "ok" : refused.status;
}

async function bodyStatus(p: ReturnType<typeof readReportBody>): Promise<number | string> {
  const body = await p;
  return "refused" in body ? body.refused.status : body.text;
}

describe("authorizeJobReport (#1359)", () => {
  it("lets the quality audit's runner in through IAP", async () => {
    const assertion = signIapTestAssertionForTests(KEY, { aud: AUDIENCE, email: RUNNER_SA });
    const req = reportRequest({ [IAP_ASSERTION_HEADER]: assertion, authorization: "Bearer jwt" });
    expect(await status(authorizeJobReport(req, "quality_audit", env))).toBe("ok");
  });

  it("refuses another IAP identity: an operator, the scheduler", async () => {
    for (const email of [
      "owner@example.com",
      "caelo-production-scheduler@p.iam.gserviceaccount.com",
    ]) {
      const assertion = signIapTestAssertionForTests(KEY, { aud: AUDIENCE, email });
      expect(
        await status(
          authorizeJobReport(
            reportRequest({ [IAP_ASSERTION_HEADER]: assertion }),
            "quality_audit",
            env,
          ),
        ),
      ).toBe(401);
    }
  });

  it("refuses a forged assertion naming the runner, and a request without IAP", async () => {
    const forged = signIapTestAssertionForTests(OTHER_KEY, { aud: AUDIENCE, email: RUNNER_SA });
    expect(
      await status(
        authorizeJobReport(reportRequest({ [IAP_ASSERTION_HEADER]: forged }), "quality_audit", env),
      ),
    ).toBe(401);
    expect(await status(authorizeJobReport(reportRequest({}), "quality_audit", env))).toBe(401);
  });

  it("#1360: each kind takes reports from its own job only — the crawler is not the audit runner", async () => {
    const crawler = "caelo-production-import@p.iam.gserviceaccount.com";
    const both = { ...env, CAELO_IMPORT_CRAWL_SERVICE_ACCOUNT: crawler };
    const as = (email: string) =>
      reportRequest({
        [IAP_ASSERTION_HEADER]: signIapTestAssertionForTests(KEY, { aud: AUDIENCE, email }),
      });
    expect(await status(authorizeJobReport(as(crawler), "site_import", both))).toBe("ok");
    expect(await status(authorizeJobReport(as(RUNNER_SA), "site_import", both))).toBe(401);
    expect(await status(authorizeJobReport(as(crawler), "quality_audit", both))).toBe(401);
  });

  it("takes no report over HTTP where the jobs run inside the admin (no runner account set)", async () => {
    const assertion = signIapTestAssertionForTests(KEY, { aud: AUDIENCE, email: RUNNER_SA });
    expect(
      await status(
        authorizeJobReport(
          reportRequest({ [IAP_ASSERTION_HEADER]: assertion }),
          "quality_audit",
          {},
        ),
      ),
    ).toBe(401);
  });
});

describe("readReportBody (#1359)", () => {
  it("reads a body under the cap", async () => {
    expect(await bodyStatus(readReportBody(reportRequest({}, '{"a":1}'), 100))).toBe('{"a":1}');
  });

  it("refuses a body whose Content-Length is over the cap before reading it", async () => {
    const req = reportRequest({ "content-length": "1000" }, "x".repeat(1000));
    expect(await bodyStatus(readReportBody(req, 100))).toBe(413);
  });

  it("refuses a streamed body that grows past the cap, whatever it claimed", async () => {
    const chunks = ["x".repeat(60), "y".repeat(60)];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(next));
      },
    });
    // A streamed body needs `duplex`, which the DOM's RequestInit type lacks.
    const init = { method: "POST", body: stream, duplex: "half" } as RequestInit;
    const req = new Request(
      "https://admin.example.com/api/internal/jobs/quality_audit/report",
      init,
    );
    expect(await bodyStatus(readReportBody(req, 100))).toBe(413);
  });
});

describe("POST /api/internal/jobs/<kind>/report answers its refusals (#1359)", () => {
  // Called the way SvelteKit calls it: a thrown Response would reach the
  // client as a 500, which the job retries as if the admin were down.
  const post = (request: Request, kind = "quality_audit") =>
    POST({ request, params: { kind } } as unknown as Parameters<typeof POST>[0]);

  it("returns the 401 for a caller that is not the job, as JSON the job reads", async () => {
    const saved = process.env.CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT;
    process.env.CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT = RUNNER_SA;
    try {
      const assertion = signIapTestAssertionForTests(KEY, {
        aud: AUDIENCE,
        email: "owner@example.com",
      });
      const res = await post(reportRequest({ [IAP_ASSERTION_HEADER]: assertion }, "{}"));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "not-the-job" } });
    } finally {
      if (saved === undefined) delete process.env.CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT;
      else process.env.CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT = saved;
    }
  });

  it("returns the 413 for the job's own report when it is over the cap", async () => {
    const saved = process.env.CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT;
    process.env.CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT = RUNNER_SA;
    try {
      const assertion = signIapTestAssertionForTests(KEY, { aud: AUDIENCE, email: RUNNER_SA });
      const res = await post(
        reportRequest(
          {
            [IAP_ASSERTION_HEADER]: assertion,
            "content-length": String(MAX_REPORT_BODY_BYTES + 1),
          },
          "x",
        ),
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "too-large" } });
    } finally {
      if (saved === undefined) delete process.env.CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT;
      else process.env.CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT = saved;
    }
  });

  it("returns a 404 for a kind that does not exist", async () => {
    const res = await post(reportRequest({}, "{}"), "nope");
    expect(res.status).toBe(404);
  });
});

describe("keptAliveAnswer: a long report holds its request (#1574)", () => {
  const admitted = (run: (signal?: AbortSignal) => Promise<ReportResponse>): AdmittedReport => ({
    long: true,
    run,
  });

  it("sends newlines while the action runs, then the answer: JSON whitespace the job parses", async () => {
    const res = keptAliveAnswer(
      admitted(async () => {
        await Bun.sleep(120);
        return { status: 200, answer: { ok: true, value: { outcome: "succeeded" } } };
      }),
      new AbortController().signal,
      20,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.startsWith("\n")).toBe(true);
    expect(text.trimStart()).toBe('{"ok":true,"value":{"outcome":"succeeded"}}');
    expect(JSON.parse(text)).toEqual({ ok: true, value: { outcome: "succeeded" } });
  });

  it("carries a refusal's status inside the answer, since the stream already said 200", async () => {
    const res = keptAliveAnswer(
      admitted(async () => ({
        status: 422,
        answer: { ok: false, error: { code: "refused", message: "already running" } },
      })),
      new AbortController().signal,
      20,
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({
      ok: false,
      error: { code: "refused", message: "already running" },
      status: 422,
    });
  });

  it("aborts the action when the job's request ends first", async () => {
    let seen: AbortSignal | undefined;
    const ended = new Promise<string>((resolve) => {
      const res = keptAliveAnswer(
        admitted(async (signal) => {
          seen = signal;
          await new Promise((r) => signal?.addEventListener("abort", r, { once: true }));
          resolve(String((signal?.reason as Error | undefined)?.message));
          return { status: 200, answer: { ok: true, value: {} } };
        }),
        new AbortController().signal,
        20,
      );
      // The job reads the first keep-alive and goes away.
      const reader = res.body?.getReader();
      void reader?.read().then(() => reader.cancel());
    });
    expect(await ended).toContain("ended");
    expect(seen?.aborted).toBe(true);
  });
});

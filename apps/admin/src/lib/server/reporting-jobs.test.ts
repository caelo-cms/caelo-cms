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
  createIapVerifier,
  IAP_ASSERTION_HEADER,
  iapTestKeyPairForTests,
  setIapVerifierForTests,
  signIapTestAssertionForTests,
} from "@caelo-cms/admin-core";
import { authorizeJobReport, readReportBody } from "./reporting-jobs.js";

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

async function status(p: Promise<unknown>): Promise<number | "ok"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
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
    expect(await readReportBody(reportRequest({}, '{"a":1}'), 100)).toBe('{"a":1}');
  });

  it("refuses a body whose Content-Length is over the cap before reading it", async () => {
    const req = reportRequest({ "content-length": "1000" }, "x".repeat(1000));
    expect(await status(readReportBody(req, 100))).toBe(413);
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
    expect(await status(readReportBody(req, 100))).toBe(413);
  });
});

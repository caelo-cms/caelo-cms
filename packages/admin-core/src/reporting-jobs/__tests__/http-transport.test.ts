// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — how a job container reaches the admin: a JWT it signs as
 * its own service account for exactly the admin's origin (what IAP admits),
 * reused until shortly before it expires, plus the attempt's token in its
 * own header; an answer IAP gave instead of the admin is named as such.
 */

import { describe, expect, it } from "bun:test";
import type { GoogleDeps } from "../../security/operator-access/google-iam.js";
import { httpReportTransport, serviceAccountIapCredential } from "../http-transport.js";
import { JOB_TOKEN_HEADER } from "../protocol.js";

const SA = "caelo-production-audit-run@acme.iam.gserviceaccount.com";

function google(): GoogleDeps & { signed: { url: string; body: unknown }[] } {
  const signed: { url: string; body: unknown }[] = [];
  let n = 0;
  return {
    signed,
    metadata: async (path) => {
      expect(path).toBe("instance/service-accounts/default/email");
      return SA;
    },
    accessToken: async () => "access-token",
    fetch: (async (url: string, init?: RequestInit) => {
      signed.push({ url, body: JSON.parse(String(init?.body)) });
      n += 1;
      return new Response(JSON.stringify({ signedJwt: `jwt-${n}` }));
    }) as unknown as typeof fetch,
  };
}

describe("serviceAccountIapCredential", () => {
  it("signs as the container's own account, for the admin's origin only", async () => {
    const g = google();
    const credential = serviceAccountIapCredential("https://admin.example.com/", g, () => 1000);
    expect(await credential()).toBe("jwt-1");
    expect(g.signed).toHaveLength(1);
    const call = g.signed[0] as { url: string; body: { payload: string } };
    expect(call.url).toBe(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:signJwt`,
    );
    const claims = JSON.parse(call.body.payload);
    expect(claims).toEqual({
      iss: SA,
      sub: SA,
      aud: "https://admin.example.com/*",
      iat: 1000,
      exp: 1600,
    });
  });

  it("reuses a credential until a minute before it expires", async () => {
    const g = google();
    let t = 1000;
    const credential = serviceAccountIapCredential("https://admin.example.com", g, () => t);
    await credential();
    t = 1500;
    expect(await credential()).toBe("jwt-1");
    t = 1545;
    expect(await credential()).toBe("jwt-2");
    expect(g.signed).toHaveLength(2);
  });

  it("refuses an admin URL that is not a plain https origin", () => {
    expect(() => serviceAccountIapCredential("https://admin.example.com/x", google())).toThrow();
  });
});

describe("httpReportTransport", () => {
  it("posts the envelope with the IAP credential and the attempt's token in its own header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const t = httpReportTransport({
      kind: "quality_audit",
      adminUrl: "https://admin.example.com",
      token: "tok",
      credential: async () => "jwt",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ ok: true, value: { kind: "stop" } }));
      }) as unknown as typeof fetch,
    });
    const envelope = {
      subjectId: "00000000-0000-4000-8000-000000001359",
      attempt: 1,
      action: "start",
      payload: {},
    };
    expect(await t.send(envelope)).toEqual({
      status: 200,
      answer: { ok: true, value: { kind: "stop" } },
    });
    expect(seen[0]?.url).toBe("https://admin.example.com/api/internal/jobs/quality_audit/report");
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer jwt");
    expect(headers[JOB_TOKEN_HEADER]).toBe("tok");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual(envelope);
  });

  it("names an answer IAP gave instead of the admin, and never reads it as a stop", async () => {
    const t = httpReportTransport({
      kind: "quality_audit",
      adminUrl: "https://admin.example.com",
      token: "tok",
      credential: async () => "jwt",
      fetch: (async () =>
        new Response("Forbidden", {
          status: 403,
          headers: { "x-goog-iap-generated-response": "true" },
        })) as unknown as typeof fetch,
    });
    const r = await t.send({
      subjectId: "00000000-0000-4000-8000-000000001359",
      attempt: 1,
      action: "heartbeat",
    });
    expect(r.status).toBe(403);
    expect(r.answer.ok).toBe(false);
    if (r.answer.ok) return;
    expect(r.answer.error.code).toBe("iap-refused");
    expect(r.answer.error.message).toContain("cms-provision upgrade");
  });

  it("an answer that is not the endpoint's JSON is a bad answer with its status", async () => {
    const t = httpReportTransport({
      kind: "quality_audit",
      adminUrl: "https://admin.example.com",
      token: "tok",
      credential: async () => "jwt",
      fetch: (async () =>
        new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch,
    });
    const r = await t.send({
      subjectId: "00000000-0000-4000-8000-000000001359",
      attempt: 1,
      action: "heartbeat",
    });
    expect(r.status).toBe(502);
    expect(r.answer.ok).toBe(false);
    if (!r.answer.ok) expect(r.answer.error.code).toBe("bad-answer");
  });

  it("#1574: reads a long report's kept-alive stream, a refusal's status from inside the answer", async () => {
    const streamed = (body: string) =>
      httpReportTransport({
        kind: "build",
        adminUrl: "https://admin.example.com",
        token: "tok",
        credential: async () => "jwt",
        fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
      });
    const envelope = {
      subjectId: "00000000-0000-4000-8000-000000001574",
      attempt: 1,
      action: "run",
    };
    const done = await streamed('\n\n\n{"ok":true,"value":{"outcome":"succeeded"}}').send(envelope);
    expect(done).toEqual({ status: 200, answer: { ok: true, value: { outcome: "succeeded" } } });
    const refused = await streamed(
      '\n\n{"ok":false,"error":{"code":"failed","message":"boom"},"status":500}',
    ).send(envelope);
    // A 500 the job retries as a passing fault, though the stream said 200.
    expect(refused.status).toBe(500);
    expect(refused.answer.ok).toBe(false);
  });
});

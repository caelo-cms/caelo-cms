// SPDX-License-Identifier: MPL-2.0

/**
 * #818 — `request-update` queues a release through the admin's internal
 * endpoint (IAP as caelo-mcp, internal token for `platform_updates.operator`)
 * and, with --wait, follows the request's timeline to its end: every line
 * once, in order, through the admin being replaced mid-roll, and a deadline.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import {
  describeUpdateEnd,
  type OperatorUpdateEvent,
  type OperatorUpdateRequest,
  PLATFORM_UPDATE_SCOPE,
  requestPlatformUpdate,
  waitForPlatformUpdate,
} from "./request-update.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });
const ADMIN = "https://caelo-production-admin-abc-ew.a.run.app";
const target = { projectId: "smoke", region: "europe-west1" };
const RID = "00000000-0000-4000-8000-000000000818";

function fakeGcloud(): (args: string[]) => Promise<GcloudResult> {
  const answers: Record<string, GcloudResult> = {
    "auth list": ok("smoke-ci@smoke.iam.gserviceaccount.com\n"),
    "run services list": ok("caelo-production-admin-abc\n"),
    "run services describe": ok(`${ADMIN}\n`),
    "secrets versions access": ok("s".repeat(40)),
    "auth print-access-token": ok("ya29.ci\n"),
    "services enable iamcredentials.googleapis.com": ok(),
  };
  return async (args) => {
    const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
    return (key && answers[key]) || fail(`unexpected gcloud ${args.join(" ")}`);
  };
}

function fakeFetch(admin: (body: { action: string }) => Response) {
  const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    if (url.startsWith("https://iamcredentials.googleapis.com/")) {
      return Response.json({ signedJwt: "iap.jwt.signed" });
    }
    return admin(body);
  }) as typeof fetch;
  return { doFetch, seen };
}

const request = (status: OperatorUpdateRequest["status"]): OperatorUpdateRequest => ({
  id: RID,
  targetVersion: "0.11.0-rc.1",
  fromVersion: "0.10.53",
  status,
  statusReason: status === "succeeded" ? null : "Nothing was changed: …",
  refusalCodes: status === "succeeded" ? [] : ["iam-preflight"],
  execution: "caelo-production-upgrader-x1",
});
const event = (id: number, message: string): OperatorUpdateEvent => ({
  id,
  at: `2026-10-19T10:00:0${id}Z`,
  phase: "assess",
  level: "info",
  message,
});

describe("requestPlatformUpdate", () => {
  it("asks for the version with the operator scope, naming the gcloud account", async () => {
    const { doFetch, seen } = fakeFetch(() =>
      Response.json({ ok: true, requestId: RID, execution: "caelo-production-upgrader-x1" }),
    );
    const r = await requestPlatformUpdate(target, "0.11.0-rc.1", {
      run: fakeGcloud(),
      fetch: doFetch,
    });
    expect(r).toEqual({
      ok: true,
      value: { requestId: RID, execution: "caelo-production-upgrader-x1" },
    });
    const call = seen[1];
    expect(call?.url).toBe(`${ADMIN}/api/internal/platform-update`);
    expect(call?.headers.authorization).toBe("Bearer iap.jwt.signed");
    expect(call?.body).toEqual({
      action: "request",
      version: "0.11.0-rc.1",
      requestedBy: "smoke-ci@smoke.iam.gserviceaccount.com",
    });
    const [message] = (call?.headers["x-caelo-internal-token"] ?? "").split(".");
    expect(Buffer.from(message ?? "", "base64url").toString()).toEndWith(
      `:${PLATFORM_UPDATE_SCOPE}`,
    );
  });

  it("an admin from before #818 says which release added the endpoint", async () => {
    const { doFetch } = fakeFetch(() => new Response("not found", { status: 404 }));
    const r = await requestPlatformUpdate(target, "0.11.0", { run: fakeGcloud(), fetch: doFetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("#818");
  });

  it("passes the admin's refusal through", async () => {
    const { doFetch } = fakeFetch(() =>
      Response.json({ ok: false, error: "already waiting to start" }, { status: 422 }),
    );
    const r = await requestPlatformUpdate(target, "0.11.0", { run: fakeGcloud(), fetch: doFetch });
    expect(r.ok === false && r.error).toContain("already waiting to start");
  });
});

describe("waitForPlatformUpdate", () => {
  it("prints every line once, in order, survives failed polls, and returns the end", async () => {
    const answers: (() => Response)[] = [
      () => Response.json({ ok: true, request: request("running"), events: [event(1, "a")] }),
      // The admin is being replaced: one poll fails.
      () => new Response("upstream connect error", { status: 503 }),
      () =>
        Response.json({
          ok: true,
          request: request("running"),
          events: [event(1, "a"), event(2, "b")],
        }),
      () =>
        Response.json({
          ok: true,
          request: request("succeeded"),
          events: [event(1, "a"), event(2, "b"), event(3, "c")],
        }),
    ];
    let i = 0;
    const { doFetch, seen } = fakeFetch(() => {
      const a = answers[Math.min(i, answers.length - 1)];
      i += 1;
      return (a as () => Response)();
    });
    const lines: string[] = [];
    let clock = 0;
    const r = await waitForPlatformUpdate(
      target,
      RID,
      {
        timeoutMs: 60_000,
        intervalMs: 1_000,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        onEvent: (e) => lines.push(e.message),
      },
      { run: fakeGcloud(), fetch: doFetch },
    );
    expect(r).toEqual({ ok: true, value: request("succeeded") });
    expect(lines).toEqual(["a", "b", "c"]);
    expect(seen.filter((s) => s.url.endsWith("/platform-update")).map((s) => s.body)).toEqual(
      Array(4).fill({ action: "status", requestId: RID }),
    );
  });

  it("gives up at the deadline with the last error", async () => {
    const { doFetch } = fakeFetch(() =>
      Response.json({ ok: true, request: request("running"), events: [] }),
    );
    let clock = 0;
    const r = await waitForPlatformUpdate(
      target,
      RID,
      {
        timeoutMs: 120_000,
        intervalMs: 30_000,
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        onEvent: () => {},
      },
      { run: fakeGcloud(), fetch: doFetch },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("did not end within 2 minutes");
  });
});

describe("describeUpdateEnd", () => {
  it("names the status, the codes and the reason of an unsuccessful end", () => {
    expect(describeUpdateEnd(request("succeeded"))).toEqual([
      "Caelo 0.11.0-rc.1 is installed (from 0.10.53).",
    ]);
    expect(describeUpdateEnd(request("needs_cloud_shell"))).toEqual([
      "The update to 0.11.0-rc.1 ended as needs_cloud_shell (iam-preflight).",
      "Nothing was changed: …",
    ]);
  });
});

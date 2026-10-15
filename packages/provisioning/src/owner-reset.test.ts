// SPDX-License-Identifier: MPL-2.0

/**
 * #769 — `owner-reset` asks the admin for a reset link through IAP (as
 * caelo-mcp) with the internal token for scope `auth.owner_reset`, and builds
 * the link on the admin URL the operator can open.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import { describeOwnerReset, OWNER_RESET_SCOPE, requestOwnerReset } from "./owner-reset.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });
const ADMIN = "https://caelo-production-admin-abc-ew.a.run.app";
const target = { projectId: "proj", region: "europe-west1" };

function fakeGcloud(): (args: string[]) => Promise<GcloudResult> {
  const answers: Record<string, GcloudResult> = {
    "run services list": ok("caelo-production-admin-abc\n"),
    "run services describe": ok(`${ADMIN}\n`),
    "secrets versions access": ok("s".repeat(40)),
    "auth print-access-token": ok("ya29.operator\n"),
    "services enable iamcredentials.googleapis.com": ok(),
  };
  return async (args) => {
    const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
    return (key && answers[key]) || fail(`unexpected gcloud ${args.join(" ")}`);
  };
}

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(admin: () => Response) {
  const seen: Seen[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.startsWith("https://iamcredentials.googleapis.com/")) {
      return Response.json({ signedJwt: "iap.jwt.signed" });
    }
    return admin();
  }) as typeof fetch;
  return { doFetch, seen };
}

const ISSUED = {
  ok: true,
  email: "owner@example.com",
  token: "tok/with+chars",
  expiresAt: "2026-10-15T12:52:56.000Z",
};

describe("requestOwnerReset", () => {
  it("calls the endpoint with the owner_reset scope and builds the link on the admin URL", async () => {
    const { doFetch, seen } = fakeFetch(() => Response.json(ISSUED));
    const r = await requestOwnerReset(target, {}, { run: fakeGcloud(), fetch: doFetch });
    expect(r).toEqual({
      ok: true,
      value: {
        email: "owner@example.com",
        resetUrl: `${ADMIN}/reset?token=tok%2Fwith%2Bchars`,
        expiresAt: "2026-10-15T12:52:56.000Z",
      },
    });
    const call = seen[1];
    expect(call?.url).toBe(`${ADMIN}/api/internal/owner-reset`);
    expect(call?.headers.authorization).toBe("Bearer iap.jwt.signed");
    expect(call?.body).toEqual({});
    const [message] = (call?.headers["x-caelo-internal-token"] ?? "").split(".");
    expect(Buffer.from(message ?? "", "base64url").toString()).toEndWith(`:${OWNER_RESET_SCOPE}`);
  });

  it("forwards --email so the operator can pick among several Owners", async () => {
    const { doFetch, seen } = fakeFetch(() => Response.json(ISSUED));
    await requestOwnerReset(
      target,
      { email: "owner@example.com" },
      { run: fakeGcloud(), fetch: doFetch },
    );
    expect(seen[1]?.body).toEqual({ email: "owner@example.com" });
  });

  it("passes the admin's refusal through and names the upgrade for an older admin", async () => {
    const refused = await requestOwnerReset(
      target,
      {},
      {
        run: fakeGcloud(),
        fetch: fakeFetch(() =>
          Response.json(
            { ok: false, error: "This install has 2 Owners (a@x.com, b@x.com). Name the one" },
            { status: 422 },
          ),
        ).doFetch,
      },
    );
    expect(refused.ok ? "" : refused.error).toContain("2 Owners (a@x.com, b@x.com)");

    const old = await requestOwnerReset(
      target,
      {},
      { run: fakeGcloud(), fetch: fakeFetch(() => new Response("nf", { status: 404 })).doFetch },
    );
    expect(old.ok ? "" : old.error).toContain("before #769");
    expect(old.ok ? "" : old.error).toContain("cms-provision upgrade");
  });

  it("refuses an answer without a token instead of printing a broken link", async () => {
    const r = await requestOwnerReset(
      target,
      {},
      {
        run: fakeGcloud(),
        fetch: fakeFetch(() => Response.json({ ok: true, email: "owner@example.com" })).doFetch,
      },
    );
    expect(r.ok).toBe(false);
  });
});

describe("describeOwnerReset", () => {
  it("prints the account, the link and when it stops working", () => {
    const text = describeOwnerReset({
      email: "owner@example.com",
      resetUrl: `${ADMIN}/reset?token=abc`,
      expiresAt: "2026-10-15T12:52:56.000Z",
    }).join("\n");
    expect(text).toContain("owner@example.com");
    expect(text).toContain(`  ${ADMIN}/reset?token=abc`);
    expect(text).toContain("2026-10-15T12:52:56.000Z");
  });
});

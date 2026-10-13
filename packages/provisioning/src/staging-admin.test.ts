// SPDX-License-Identifier: MPL-2.0

/**
 * #678 — `staging-domain enable` configures the admin itself: the request
 * goes through IAP (a JWT signed as caelo-mcp) with the internal token in
 * its own header, and the generated password is printed, never stored.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import { mintInternalToken } from "./internal-token.js";
import {
  applyStagingAdmin,
  describeStagingApply,
  domainEnableRetryCommand,
  inspectStagingAdmin,
  STAGING_PROVISION_SCOPE,
  type StagingApply,
} from "./staging-admin.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });
const SECRET = "s".repeat(40);
const ADMIN = "https://caelo-production-admin-abc-ew.a.run.app";
const target = { projectId: "proj", region: "europe-west1" };

function fakeGcloud(overrides: Record<string, GcloudResult> = {}) {
  const answers: Record<string, GcloudResult> = {
    "run services list": ok("caelo-production-admin-abc\n"),
    "run services describe": ok(`${ADMIN}\n`),
    "secrets versions access": ok(SECRET),
    "auth print-access-token": ok("ya29.operator\n"),
    ...overrides,
  };
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
    return (key && answers[key]) || fail(`unexpected gcloud ${args.join(" ")}`);
  };
  return { run, calls };
}

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(admin: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const s = { url, headers, body };
    seen.push(s);
    if (url.startsWith("https://iamcredentials.googleapis.com/")) {
      return Response.json({ signedJwt: "iap.jwt.signed" });
    }
    return admin(s);
  }) as typeof fetch;
  return { doFetch, seen };
}

const APPLIED: StagingApply = {
  host: "preview.searchviu.com",
  previousHost: "staging.searchviu.com",
  hostChanged: true,
  stagingUrl: "https://preview.searchviu.com",
  basicAuth: { status: "generated", enabled: true, user: "searchviu", password: "pw-123" },
  stageNeeded: "nothing-staged",
  stageNote:
    "Nothing is served at https://preview.searchviu.com/ until the next Stage — Stage once.",
  draftPages: { count: 2, pages: [{ title: "Pricing", path: "/pricing/" }] },
};

describe("applyStagingAdmin", () => {
  it("passes IAP as caelo-mcp and carries the internal token in its own header", async () => {
    const { run, calls } = fakeGcloud();
    const { doFetch, seen } = fakeFetch(() => Response.json({ ok: true, ...APPLIED }));
    const r = await applyStagingAdmin(
      target,
      { host: "preview.searchviu.com" },
      { run, fetch: doFetch, now: () => 1_000 },
    );
    expect(r).toEqual({ ok: true, value: { ok: true, ...APPLIED } as StagingApply });

    const sign = seen[0]!;
    expect(sign.url).toContain("caelo-mcp%40proj.iam.gserviceaccount.com:signJwt");
    expect(sign.headers.authorization).toBe("Bearer ya29.operator");
    expect(JSON.parse((sign.body as { payload: string }).payload)).toEqual({
      iss: "caelo-mcp@proj.iam.gserviceaccount.com",
      sub: "caelo-mcp@proj.iam.gserviceaccount.com",
      aud: `${ADMIN}/*`,
      iat: 1_000,
      exp: 1_600,
    });

    const call = seen[1]!;
    expect(call.url).toBe(`${ADMIN}/api/internal/staging/provision`);
    expect(call.headers.authorization).toBe("Bearer iap.jwt.signed");
    expect(call.body).toEqual({ mode: "apply", host: "preview.searchviu.com" });
    const [message] = (call.headers["x-caelo-internal-token"] ?? "").split(".");
    expect(Buffer.from(message ?? "", "base64url").toString()).toEndWith(
      `:${STAGING_PROVISION_SCOPE}`,
    );
    expect(calls).toContainEqual([
      "secrets",
      "versions",
      "access",
      "latest",
      "--secret=caelo-production-internal-secret",
      "--project=proj",
    ]);
  });

  it("names the fix when IAP refuses, the admin predates the endpoint, or refuses the input", async () => {
    const iap = await applyStagingAdmin(
      target,
      {},
      {
        run: fakeGcloud().run,
        fetch: fakeFetch(
          () =>
            new Response("Invalid IAP credentials", {
              status: 401,
              headers: { "x-goog-iap-generated-response": "true" },
            }),
        ).doFetch,
      },
    );
    expect(iap.ok ? "" : iap.error).toContain("cms-provision upgrade");

    const old = await applyStagingAdmin(
      target,
      {},
      {
        run: fakeGcloud().run,
        fetch: fakeFetch(() => new Response("nf", { status: 404 })).doFetch,
      },
    );
    expect(old.ok ? "" : old.error).toContain("before #678");

    const refused = await applyStagingAdmin(
      target,
      { host: "example.com" },
      {
        run: fakeGcloud().run,
        fetch: fakeFetch(() =>
          Response.json({ ok: false, error: "that is the live host" }, { status: 422 }),
        ).doFetch,
      },
    );
    expect(refused.ok ? "" : refused.error).toContain("that is the live host");
  });

  it("stops before calling the admin when the internal secret cannot be read", async () => {
    const { run } = fakeGcloud({ "secrets versions access": fail("PERMISSION_DENIED") });
    const { doFetch, seen } = fakeFetch(() => Response.json({ ok: true }));
    const r = await applyStagingAdmin(target, {}, { run, fetch: doFetch });
    expect(r.ok ? "" : r.error).toContain("PERMISSION_DENIED");
    expect(seen).toHaveLength(0);
  });
});

describe("inspectStagingAdmin", () => {
  it("reads the admin's stored host", async () => {
    const { doFetch, seen } = fakeFetch(() =>
      Response.json({ ok: true, stagingHost: "preview.searchviu.com" }),
    );
    const r = await inspectStagingAdmin(target, { run: fakeGcloud().run, fetch: doFetch });
    expect(r.ok && r.value.stagingHost).toBe("preview.searchviu.com");
    expect(seen[1]?.body).toEqual({ mode: "inspect" });
  });
});

describe("describeStagingApply", () => {
  it("prints a new credential once with how to change it, the stage note and the drafts", () => {
    const text = describeStagingApply(APPLIED).join("\n");
    expect(text).toContain("now uses preview.searchviu.com");
    expect(text).toContain("user:     searchviu");
    expect(text).toContain("password: pw-123");
    expect(text).toContain("Security → Staging access");
    expect(text).toContain("until the next Stage");
    expect(text).toContain("2 page(s) are draft");
    expect(text).toContain("Pricing (/pricing/)");
  });

  it("never prints a password it was not given", () => {
    const text = describeStagingApply({
      ...APPLIED,
      hostChanged: false,
      basicAuth: { status: "unchanged-enabled", enabled: true, user: "searchviu", password: null },
      stageNeeded: null,
      stageNote: null,
      draftPages: { count: 0, pages: [] },
    }).join("\n");
    expect(text).toContain("--show-staging-password");
    expect(text).not.toContain("password:");
    expect(text).not.toContain("draft");
  });
});

describe("mintInternalToken", () => {
  it("signs <iat>:<exp>:<scope> with the 5-minute window the admin enforces", async () => {
    const token = await mintInternalToken(SECRET, "staging.provision", 1_000);
    const [message, sig] = token.split(".");
    expect(Buffer.from(message ?? "", "base64url").toString()).toBe(
      `1000:${1_000 + 300_000}:staging.provision`,
    );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "HMAC",
        key,
        Buffer.from(sig ?? "", "base64url"),
        new TextEncoder().encode(`1000:301000:staging.provision`),
      ),
    ).toBe(true);
  });
});

describe("domainEnableRetryCommand", () => {
  it("keeps an explicitly requested host, so a retry after verification maps it", () => {
    expect(domainEnableRetryCommand("staging-domain", "preview.example.org")).toBe(
      "cms-provision staging-domain enable --staging-domain preview.example.org",
    );
    expect(domainEnableRetryCommand("admin-domain", null)).toBe(
      "cms-provision admin-domain enable",
    );
  });
});

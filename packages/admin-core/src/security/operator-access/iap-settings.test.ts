// SPDX-License-Identifier: MPL-2.0

/**
 * #914 — the operator-access sync job keeps the admin IAP resource's
 * `oauthSettings` (browser client + secret + programmatic clients) at
 * exactly the install's Google sign-in client, or clears all three.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { GoogleDeps } from "./google-iam.js";
import {
  compareOAuthSettings,
  type LiveOAuthSettings,
  OAUTH_SETTINGS_MASK,
  reconcileOAuthSettings,
  sameClients,
  secretHashMatches,
} from "./iap-settings.js";
import { type LogEntry, runSync, type SyncJobConfig } from "./sync-job.js";

const RESOURCE =
  "https://iap.googleapis.com/v1/projects/123/iap_web/cloud_run-europe-west1/services/adm";
const CLIENT = "123456789012-abc123.apps.googleusercontent.com";
const OTHER = "999-zzz.apps.googleusercontent.com";
const SECRET = "GOCSPX-the-current-secret";
const OLD_SECRET = "GOCSPX-an-older-secret";
const sha = (s: string, enc: "hex" | "base64" = "hex") =>
  createHash("sha256").update(s).digest(enc);

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

/**
 * A fake IAP settings endpoint with real state: a PATCH replaces the whole
 * `oauthSettings` message (as the message-path mask does), the secret is
 * input only and comes back as `clientSecretSha256`. IAM policies are empty.
 */
function fakeIap(
  initial: LiveOAuthSettings | undefined,
  opts: { failPatch?: boolean; hashEncoding?: "hex" | "base64" | "none" } = {},
) {
  let settings: LiveOAuthSettings | undefined = initial;
  const calls: Call[] = [];
  const deps: GoogleDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (url.includes(":iapSettings")) {
        if (method === "GET") {
          return new Response(
            JSON.stringify(
              settings === undefined
                ? { name: "x" }
                : { name: "x", accessSettings: { oauthSettings: settings } },
            ),
            { status: 200 },
          );
        }
        if (opts.failPatch) return new Response("denied", { status: 403 });
        const sent = (
          body as {
            accessSettings: { oauthSettings: LiveOAuthSettings & { clientSecret?: string } };
          }
        ).accessSettings.oauthSettings;
        const { clientSecret, ...rest } = sent;
        const encoding = opts.hashEncoding ?? "hex";
        settings = {
          ...rest,
          ...(clientSecret && encoding !== "none"
            ? { clientSecretSha256: sha(clientSecret, encoding) }
            : {}),
        };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (url.includes(":getIamPolicy")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify((body as { policy: unknown }).policy), { status: 200 });
    }) as typeof fetch,
    accessToken: async () => "tok",
    metadata: async (path) => (path === "project/numeric-project-id" ? "123" : ""),
  };
  return { deps, calls, current: () => settings };
}

const configured = (secret = SECRET): LiveOAuthSettings => ({
  clientId: CLIENT,
  clientSecretSha256: sha(secret),
  programmaticClients: [CLIENT],
});

describe("oauthSettings comparison", () => {
  it("compares client lists as sets", () => {
    expect(sameClients([CLIENT, OTHER], [OTHER, CLIENT])).toBe(true);
    expect(sameClients([CLIENT], [CLIENT, CLIENT])).toBe(false);
  });

  it("recognises the secret's SHA-256 in hex (any case) and base64", () => {
    expect(secretHashMatches(sha(SECRET), SECRET)).toBe(true);
    expect(secretHashMatches(sha(SECRET).toUpperCase(), SECRET)).toBe(true);
    expect(secretHashMatches(sha(SECRET, "base64"), SECRET)).toBe(true);
    expect(secretHashMatches(sha(OLD_SECRET), SECRET)).toBe(false);
  });

  it("is in sync only when client, secret and programmatic clients all match", () => {
    const desired = { clientId: CLIENT, clientSecret: SECRET };
    expect(compareOAuthSettings(configured(), desired)).toEqual({ inSync: true });
    expect(compareOAuthSettings(configured(OLD_SECRET), desired)).toEqual({
      inSync: false,
      secretReason: "differs",
    });
    expect(
      compareOAuthSettings({ clientId: CLIENT, programmaticClients: [CLIENT] }, desired),
    ).toEqual({ inSync: false, secretReason: "unverifiable" });
    expect(
      compareOAuthSettings({ ...configured(), programmaticClients: [CLIENT, OTHER] }, desired),
    ).toEqual({ inSync: false });
    expect(compareOAuthSettings({}, null)).toEqual({ inSync: true });
    expect(compareOAuthSettings({ loginHint: "x.com" }, null)).toEqual({ inSync: true });
    expect(compareOAuthSettings({ programmaticClients: [OTHER] }, null)).toEqual({
      inSync: false,
    });
  });
});

describe("reconcileOAuthSettings", () => {
  it("sets client, secret and programmatic clients in one PATCH masked to oauthSettings", async () => {
    const { deps, calls, current } = fakeIap(undefined);
    const r = await reconcileOAuthSettings(deps, RESOURCE, {
      clientId: CLIENT,
      clientSecret: SECRET,
    });
    expect(r).toEqual({
      before: { clientId: null, programmaticClients: [] },
      after: { clientId: CLIENT, programmaticClients: [CLIENT] },
      changed: true,
    });
    expect(current()).toEqual(configured());
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(OAUTH_SETTINGS_MASK).toBe("iapSettings.accessSettings.oauthSettings");
    expect(patches[0]?.url).toBe(
      `${RESOURCE}:iapSettings?updateMask=${encodeURIComponent(OAUTH_SETTINGS_MASK)}`,
    );
    expect(patches[0]?.body).toEqual({
      name: "projects/123/iap_web/cloud_run-europe-west1/services/adm",
      accessSettings: {
        oauthSettings: { clientId: CLIENT, clientSecret: SECRET, programmaticClients: [CLIENT] },
      },
    });
  });

  it("is a no-op on a second run (idempotent)", async () => {
    const { deps, calls } = fakeIap(undefined);
    const desired = { clientId: CLIENT, clientSecret: SECRET };
    await reconcileOAuthSettings(deps, RESOURCE, desired);
    const again = await reconcileOAuthSettings(deps, RESOURCE, desired);
    expect(again.changed).toBe(false);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("matches a base64-encoded hash as well", async () => {
    const { deps, calls } = fakeIap(undefined, { hashEncoding: "base64" });
    const desired = { clientId: CLIENT, clientSecret: SECRET };
    await reconcileOAuthSettings(deps, RESOURCE, desired);
    expect((await reconcileOAuthSettings(deps, RESOURCE, desired)).changed).toBe(false);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("re-applies a rotated secret for the same client", async () => {
    const { deps, current } = fakeIap(configured(OLD_SECRET));
    const r = await reconcileOAuthSettings(deps, RESOURCE, {
      clientId: CLIENT,
      clientSecret: SECRET,
    });
    expect(r.changed).toBe(true);
    expect(r.secretReason).toBe("differs");
    expect(current()?.clientSecretSha256).toBe(sha(SECRET));
  });

  it("replaces a client set by hand and drops extra programmatic clients", async () => {
    const { deps, current } = fakeIap({
      clientId: OTHER,
      clientSecretSha256: sha("x"),
      programmaticClients: [OTHER, CLIENT],
    });
    const r = await reconcileOAuthSettings(deps, RESOURCE, {
      clientId: CLIENT,
      clientSecret: SECRET,
    });
    expect(r.before).toEqual({ clientId: OTHER, programmaticClients: [OTHER, CLIENT] });
    expect(current()).toEqual(configured());
  });

  it("clears all three when no client is configured, keeping loginHint", async () => {
    const { deps, calls, current } = fakeIap({ ...configured(), loginHint: "example.com" });
    const r = await reconcileOAuthSettings(deps, RESOURCE, null);
    expect(r.after).toEqual({ clientId: null, programmaticClients: [] });
    expect(current()).toEqual({ loginHint: "example.com" });
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      name: "projects/123/iap_web/cloud_run-europe-west1/services/adm",
      accessSettings: { oauthSettings: { loginHint: "example.com" } },
    });
  });

  it("sends no PATCH when nothing is configured anywhere", async () => {
    const { deps, calls } = fakeIap(undefined);
    expect((await reconcileOAuthSettings(deps, RESOURCE, null)).changed).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("runSync — oauthSettings step", () => {
  const config: SyncJobConfig = {
    iapWebPath: "cloud_run-europe-west1/services/adm",
    mcpServiceAccount: "caelo-mcp@p.iam.gserviceaccount.com",
    staticMembers: "user:owner@x.com",
    databaseHost: "10.0.0.3",
    mcpSigners: "",
    oauthClientSecret: "projects/p/secrets/caelo-production-operator-oauth-client",
  };
  const file = async () => ({ client_id: CLIENT, client_secret: SECRET });

  it("replaces an old client with the configured one and logs the removal", async () => {
    const { deps, current } = fakeIap({ clientId: OTHER, programmaticClients: [OTHER] });
    const logs: LogEntry[] = [];
    const r = await runSync(config, {
      google: deps,
      readEmails: async () => [],
      readOAuthClientId: async () => CLIENT,
      readOAuthClientFile: file,
      log: (e) => logs.push(e),
    });
    expect(r.ok).toBe(true);
    expect(current()).toEqual(configured());
    expect(r.oauthSettings?.after).toEqual({ clientId: CLIENT, programmaticClients: [CLIENT] });
    expect(logs).toContainEqual(expect.objectContaining({ severity: "WARNING", clientId: OTHER }));
    // The secret never reaches the log.
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("clears the settings when no client is configured, without reading the secret", async () => {
    const { deps, current } = fakeIap(configured());
    let fileReads = 0;
    const r = await runSync(config, {
      google: deps,
      readEmails: async () => [],
      readOAuthClientId: async () => null,
      readOAuthClientFile: async () => {
        fileReads += 1;
        return {};
      },
      log: () => {},
    });
    expect(r.ok).toBe(true);
    expect(current()).toEqual({});
    expect(fileReads).toBe(0);
  });

  it("leaves the settings alone and fails when the configured client cannot be read", async () => {
    const { deps, calls, current } = fakeIap(configured());
    const logs: LogEntry[] = [];
    const r = await runSync(config, {
      google: deps,
      readEmails: async () => [],
      readOAuthClientId: async () => {
        throw new Error("permission denied for table operator_oauth_client");
      },
      readOAuthClientFile: file,
      log: (e) => logs.push(e),
    });
    expect(r.ok).toBe(false);
    expect(current()).toEqual(configured());
    expect(calls.some((c) => c.url.includes(":iapSettings"))).toBe(false);
    expect(logs.some((l) => l.severity === "ERROR" && l.message.includes("left unchanged"))).toBe(
      true,
    );
  });

  it("refuses when Secret Manager holds another client than the recorded one", async () => {
    const { deps, calls } = fakeIap(undefined);
    const logs: LogEntry[] = [];
    const r = await runSync(config, {
      google: deps,
      readEmails: async () => [],
      readOAuthClientId: async () => CLIENT,
      readOAuthClientFile: async () => ({}),
      log: (e) => logs.push(e),
    });
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.url.includes(":iapSettings"))).toBe(false);
    expect(logs.some((l) => l.message.includes("save the client again"))).toBe(true);
  });

  it("fails the run when IAP refuses the update", async () => {
    const { deps } = fakeIap(undefined, { failPatch: true });
    const r = await runSync(config, {
      google: deps,
      readEmails: async () => [],
      readOAuthClientId: async () => CLIENT,
      readOAuthClientFile: file,
      log: () => {},
    });
    expect(r.ok).toBe(false);
    expect(r.oauthSettings).toBeUndefined();
  });
});

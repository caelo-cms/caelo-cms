// SPDX-License-Identifier: MPL-2.0

/**
 * #806 — the operator-access sync job keeps the admin IAP resource's
 * `programmatic_clients` at exactly the configured remote-MCP client.
 */

import { describe, expect, it } from "bun:test";
import type { GoogleDeps } from "./google-iam.js";
import {
  desiredProgrammaticClients,
  PROGRAMMATIC_CLIENTS_MASK,
  reconcileProgrammaticClients,
  sameClients,
} from "./iap-settings.js";
import { type LogEntry, runSync, type SyncJobConfig } from "./sync-job.js";

const RESOURCE =
  "https://iap.googleapis.com/v1/projects/123/iap_web/cloud_run-europe-west1/services/adm";
const CLIENT = "123456789012-abc123.apps.googleusercontent.com";
const OTHER = "999-zzz.apps.googleusercontent.com";

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}

/** A fake IAP settings endpoint holding `programmaticClients`, plus empty IAM policies. */
function fakeIap(initial: string[] | undefined, opts: { failPatch?: boolean } = {}) {
  let clients = initial;
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
              clients === undefined
                ? { name: "x" }
                : {
                    name: "x",
                    accessSettings: { oauthSettings: { programmaticClients: clients } },
                  },
            ),
            { status: 200 },
          );
        }
        if (opts.failPatch) return new Response("denied", { status: 403 });
        clients = (body as { accessSettings: { oauthSettings: { programmaticClients: string[] } } })
          .accessSettings.oauthSettings.programmaticClients;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (url.includes(":getIamPolicy")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify((body as { policy: unknown }).policy), { status: 200 });
    }) as typeof fetch,
    accessToken: async () => "tok",
    metadata: async (path) => (path === "project/numeric-project-id" ? "123" : ""),
  };
  return { deps, calls, current: () => clients };
}

describe("programmatic_clients reconcile", () => {
  it("wants exactly the configured client, or none", () => {
    expect(desiredProgrammaticClients(CLIENT)).toEqual([CLIENT]);
    expect(desiredProgrammaticClients(null)).toEqual([]);
    expect(sameClients([CLIENT, OTHER], [OTHER, CLIENT])).toBe(true);
    expect(sameClients([CLIENT], [CLIENT, CLIENT])).toBe(false);
  });

  it("sets the configured client with a mask that touches nothing else", async () => {
    const { deps, calls, current } = fakeIap(undefined);
    const r = await reconcileProgrammaticClients(deps, RESOURCE, [CLIENT]);
    expect(r).toEqual({ before: [], after: [CLIENT], changed: true });
    expect(current()).toEqual([CLIENT]);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe(
      `${RESOURCE}:iapSettings?updateMask=${encodeURIComponent(PROGRAMMATIC_CLIENTS_MASK)}`,
    );
    expect(PROGRAMMATIC_CLIENTS_MASK).toBe(
      "iapSettings.accessSettings.oauthSettings.programmaticClients",
    );
    expect(patch?.body).toEqual({
      name: "projects/123/iap_web/cloud_run-europe-west1/services/adm",
      accessSettings: { oauthSettings: { programmaticClients: [CLIENT] } },
    });
  });

  it("removes a client someone added by hand next to the configured one", async () => {
    const { deps, current } = fakeIap([OTHER, CLIENT]);
    const r = await reconcileProgrammaticClients(deps, RESOURCE, [CLIENT]);
    expect(r.changed).toBe(true);
    expect(current()).toEqual([CLIENT]);
  });

  it("clears the list when remote MCP is turned off", async () => {
    const { deps, current } = fakeIap([CLIENT]);
    const r = await reconcileProgrammaticClients(deps, RESOURCE, []);
    expect(r).toEqual({ before: [CLIENT], after: [], changed: true });
    expect(current()).toEqual([]);
  });

  it("sends no PATCH when the list already matches", async () => {
    const { deps, calls } = fakeIap([CLIENT]);
    const r = await reconcileProgrammaticClients(deps, RESOURCE, [CLIENT]);
    expect(r.changed).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("runSync — programmatic_clients step", () => {
  const config: SyncJobConfig = {
    iapWebPath: "cloud_run-europe-west1/services/adm",
    mcpServiceAccount: "caelo-mcp@p.iam.gserviceaccount.com",
    staticMembers: "user:owner@x.com",
    databaseHost: "10.0.0.3",
    mcpSigners: "",
  };

  it("replaces an old client with the configured one and logs the removal", async () => {
    const { deps, current } = fakeIap([OTHER]);
    const logs: LogEntry[] = [];
    const r = await runSync(config, {
      google: deps,
      readEmails: async () => [],
      readProgrammaticClientId: async () => CLIENT,
      log: (e) => logs.push(e),
    });
    expect(r.ok).toBe(true);
    expect(current()).toEqual([CLIENT]);
    expect(r.programmaticClients).toEqual({ before: [OTHER], after: [CLIENT], changed: true });
    expect(logs).toContainEqual(expect.objectContaining({ severity: "WARNING", clientId: OTHER }));
  });

  it("clears the list when no client is configured", async () => {
    const { deps, current } = fakeIap([CLIENT]);
    const r = await runSync(config, {
      google: deps,
      readEmails: async () => [],
      readProgrammaticClientId: async () => null,
      log: () => {},
    });
    expect(r.ok).toBe(true);
    expect(current()).toEqual([]);
  });

  it("leaves the list alone and fails when the configured client cannot be read", async () => {
    const { deps, calls, current } = fakeIap([CLIENT]);
    const logs: LogEntry[] = [];
    const r = await runSync(config, {
      google: deps,
      readEmails: async () => [],
      readProgrammaticClientId: async () => {
        throw new Error("permission denied for table mcp_remote_oauth_client");
      },
      log: (e) => logs.push(e),
    });
    expect(r.ok).toBe(false);
    expect(current()).toEqual([CLIENT]);
    expect(calls.some((c) => c.url.includes(":iapSettings"))).toBe(false);
    expect(logs.some((l) => l.severity === "ERROR" && l.message.includes("left unchanged"))).toBe(
      true,
    );
  });

  it("fails the run when IAP refuses the update", async () => {
    const { deps } = fakeIap([], { failPatch: true });
    const r = await runSync(config, {
      google: deps,
      readEmails: async () => [],
      readProgrammaticClientId: async () => CLIENT,
      log: () => {},
    });
    expect(r.ok).toBe(false);
    expect(r.programmaticClients).toBeUndefined();
  });
});

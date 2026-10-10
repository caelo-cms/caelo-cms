// SPDX-License-Identifier: MPL-2.0

/**
 * Self-heal of a stuck Firebase Hosting custom domain + the CDN purge after
 * activation (firebase-custom-domain.ts, ops/domain_hosting.ts), run
 * against an in-memory fake of the Firebase Hosting REST surface they call
 * — same approach as static-publisher-firebase-promote.test.ts: no
 * network, no credentials (the token is passed in, or google-auth-library
 * is mocked for the op).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
// Snapshot the real module so afterAll can undo the process-global
// mock.module below (issue #305 — same pattern as the publisher tests).
import * as realGoogleAuth from "google-auth-library";
import type { FirebaseCustomDomain } from "../firebase-custom-domain-health.js";

const realGoogleAuthExports = { ...realGoogleAuth };
mock.module("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: async () => ({ token: "test-token" }) };
    }
    async getProjectId() {
      return "adc-project";
    }
  },
}));
afterAll(() => {
  mock.module("google-auth-library", () => realGoogleAuthExports);
});

const API = "https://firebasehosting.googleapis.com/v1beta1/";
const PROJECT = "p";
const SITE = "s";
const HOST = "example.com";
const DOMAINS = `projects/${PROJECT}/sites/${SITE}/customDomains`;
const TARGET = { project: PROJECT, site: SITE, token: "t" };

const DNS = [
  {
    domainName: HOST,
    records: [{ domainName: HOST, type: "A", rdata: "199.36.158.100", requiredAction: "NONE" }],
  },
];

function stuckDomain(): FirebaseCustomDomain {
  return {
    name: `${DOMAINS}/${HOST}`,
    hostState: "HOST_MISMATCH",
    ownershipState: "OWNERSHIP_PENDING",
    cert: { state: "CERT_ACTIVE", type: "TEMPORARY" },
    requiredDnsUpdates: { checkTime: "2026-10-10T14:56:00Z", desired: DNS, discovered: DNS },
    createTime: "2026-09-29T09:00:00Z",
    updateTime: "2026-09-29T09:00:00Z",
  };
}

interface Release {
  name: string;
  type: string;
  releaseTime: string;
  version: { name: string };
}

/** In-memory Firebase Hosting: custom domains + live-channel releases. */
class FakeFirebase {
  domains = new Map<string, FirebaseCustomDomain>();
  softDeleted = new Set<string>();
  live: Release[] = []; // newest first
  calls: string[] = [];
  /** POST customDomains answers 409 while the id is soft-deleted (Firebase may). */
  conflictOnSoftDeleted = false;
  /** GETs after a (re)create that still report the old state before going active. */
  pendingGetsBeforeActive = 0;
  /** Never goes active after a reconnect. */
  neverActive = false;
  clock = "2026-10-10T19:00:00Z";

  private activate(host: string): void {
    const d = this.domains.get(host);
    if (!d) return;
    this.domains.set(host, {
      ...d,
      hostState: "HOST_ACTIVE",
      ownershipState: "OWNERSHIP_ACTIVE",
      updateTime: this.clock,
    });
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, statusText: status === 200 ? "OK" : "ERR" });
    if (!url.startsWith(API)) throw new Error(`unexpected fetch ${url}`);
    const [route = "", query = ""] = url.slice(API.length).split("?");
    const params = new URLSearchParams(query);
    this.calls.push(`${method} ${route}${query ? `?${query}` : ""}`);

    if (route === DOMAINS && method === "GET") {
      const deleted =
        params.get("showDeleted") === "true"
          ? [...this.softDeleted].map((host) => ({
              ...stuckDomain(),
              name: `${DOMAINS}/${host}`,
              deleteTime: "2026-10-10T18:59:00Z",
              expireTime: "2026-11-09T18:59:00Z",
            }))
          : [];
      return json({ customDomains: [...this.domains.values(), ...deleted] });
    }
    if (route === DOMAINS && method === "POST") {
      const id = params.get("customDomainId") ?? "";
      if (this.domains.has(id) || (this.conflictOnSoftDeleted && this.softDeleted.has(id))) {
        return json({ error: { code: 409, message: "already exists" } }, 409);
      }
      this.recreate(id);
      return json({ name: "operations/create" });
    }
    const undelete = route.match(new RegExp(`^${DOMAINS}/([^/:]+):undelete$`));
    if (undelete && method === "POST") {
      const host = decodeURIComponent(undelete[1] ?? "");
      if (!this.softDeleted.has(host)) return json({ error: { code: 404 } }, 404);
      this.softDeleted.delete(host);
      this.recreate(host);
      return json({ name: "operations/undelete" });
    }
    const one = route.match(new RegExp(`^${DOMAINS}/([^/:]+)$`));
    if (one) {
      const host = decodeURIComponent(one[1] ?? "");
      const d = this.domains.get(host);
      if (method === "DELETE") {
        if (!d) return json({ error: { code: 404 } }, 404);
        this.domains.delete(host);
        this.softDeleted.add(host);
        return new Response("", { status: 200 });
      }
      if (!d) return json({ error: { code: 404, message: "not found" } }, 404);
      if (this.pendingGetsBeforeActive > 0) {
        this.pendingGetsBeforeActive -= 1;
        if (this.pendingGetsBeforeActive === 0 && !this.neverActive) this.activate(host);
        return json(d);
      }
      return json(d);
    }
    if (route === `sites/${SITE}/channels/live/releases` && method === "GET") {
      return json({ releases: this.live.slice(0, Number(params.get("pageSize") ?? 100)) });
    }
    if (route === `sites/${SITE}/releases` && method === "POST") {
      const versionName = params.get("versionName") ?? "";
      this.live.unshift({
        name: `sites/${SITE}/releases/r${this.live.length + 1}`,
        type: "DEPLOY",
        releaseTime: this.clock,
        version: { name: versionName },
      });
      return json({});
    }
    throw new Error(`unhandled ${method} ${url}`);
  };

  private recreate(host: string): void {
    this.domains.set(host, {
      ...stuckDomain(),
      name: `${DOMAINS}/${host}`,
      hostState: "HOST_PENDING",
      ownershipState: "OWNERSHIP_PENDING",
      createTime: this.clock,
      updateTime: this.clock,
    });
    if (this.pendingGetsBeforeActive === 0 && !this.neverActive) this.activate(host);
  }
}

let fake: FakeFirebase;
const realFetch = globalThis.fetch;
const ENV_KEYS = ["CAELO_PROVIDER", "CAELO_FIREBASE_SITE", "GOOGLE_CLOUD_PROJECT"] as const;
const savedEnv: Record<string, string | undefined> = {};
const noSleep = async () => {};

beforeEach(() => {
  fake = new FakeFirebase();
  fake.domains.set(HOST, stuckDomain());
  fake.live = [
    {
      name: `sites/${SITE}/releases/r0`,
      type: "DEPLOY",
      releaseTime: "2026-10-10T12:00:00Z",
      version: { name: `sites/${SITE}/versions/v-live` },
    },
  ];
  globalThis.fetch = fake.fetch as typeof fetch;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("reconnectCustomDomain", () => {
  it("deletes, re-creates, and purges the CDN by re-releasing the live version", async () => {
    const { reconnectCustomDomain } = await import("../firebase-custom-domain.js");
    const r = await reconnectCustomDomain(TARGET, HOST, { sleep: noSleep });
    expect(r.method).toBe("recreated");
    expect(r.active).toBe(true);
    expect(r.cdnPurge).toEqual({
      versionName: `sites/${SITE}/versions/v-live`,
      hostnames: [HOST],
    });
    expect(fake.calls.slice(0, 2)).toEqual([
      `DELETE ${DOMAINS}/${HOST}`,
      `POST ${DOMAINS}?customDomainId=${HOST}`,
    ]);
    // The new live release points at the version that was already live.
    expect(fake.live[0]?.version.name).toBe(`sites/${SITE}/versions/v-live`);
    expect(fake.live).toHaveLength(2);
  });

  it("falls back to :undelete when the create says the id still exists", async () => {
    fake.conflictOnSoftDeleted = true;
    const { reconnectCustomDomain } = await import("../firebase-custom-domain.js");
    const r = await reconnectCustomDomain(TARGET, HOST, { sleep: noSleep });
    expect(r.method).toBe("undeleted");
    expect(r.active).toBe(true);
    expect(fake.calls).toContain(`POST ${DOMAINS}/${HOST}:undelete`);
  });

  it("creates the domain when it was already deleted (DELETE 404)", async () => {
    fake.domains.clear();
    const { reconnectCustomDomain } = await import("../firebase-custom-domain.js");
    const r = await reconnectCustomDomain(TARGET, HOST, { sleep: noSleep });
    expect(r.method).toBe("recreated");
    expect(r.active).toBe(true);
  });

  it("polls until the domain is active", async () => {
    fake.pendingGetsBeforeActive = 3;
    const slept: number[] = [];
    const { reconnectCustomDomain } = await import("../firebase-custom-domain.js");
    const r = await reconnectCustomDomain(TARGET, HOST, {
      pollMs: 1000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(r.active).toBe(true);
    expect(slept.length).toBeGreaterThanOrEqual(2);
    expect(r.cdnPurge).not.toBeNull();
  });

  it("gives up waiting without a purge when the domain does not go active in time", async () => {
    fake.neverActive = true;
    let t = 0;
    const { reconnectCustomDomain } = await import("../firebase-custom-domain.js");
    const r = await reconnectCustomDomain(TARGET, HOST, {
      waitMs: 10_000,
      pollMs: 5_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(r.active).toBe(false);
    expect(r.cdnPurge).toBeNull();
    expect(r.domain?.hostState).toBe("HOST_PENDING");
    expect(fake.live).toHaveLength(1);
  });

  it("does not purge when nothing is live yet", async () => {
    fake.live = [];
    const { reconnectCustomDomain } = await import("../firebase-custom-domain.js");
    const r = await reconnectCustomDomain(TARGET, HOST, { sleep: noSleep });
    expect(r.active).toBe(true);
    expect(r.cdnPurge).toBeNull();
    expect(fake.live).toHaveLength(0);
  });

  it("surfaces a non-conflict create failure instead of undeleting", async () => {
    const { reconnectCustomDomain } = await import("../firebase-custom-domain.js");
    const failing = fake.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && String(input).includes("customDomainId=")) {
        return new Response("denied", { status: 403, statusText: "Forbidden" });
      }
      return failing(input, init);
    }) as typeof fetch;
    await expect(reconnectCustomDomain(TARGET, HOST, { sleep: noSleep })).rejects.toThrow("403");
  });
});

describe("purgeCdnIfDomainsActivatedSinceLastRelease", () => {
  it("re-releases once after a domain turned active, then stays quiet", async () => {
    const { purgeCdnIfDomainsActivatedSinceLastRelease, listCustomDomains } = await import(
      "../firebase-custom-domain.js"
    );
    fake.domains.set(HOST, {
      ...stuckDomain(),
      hostState: "HOST_ACTIVE",
      ownershipState: "OWNERSHIP_ACTIVE",
      updateTime: "2026-10-10T18:00:00Z",
    });
    const first = await purgeCdnIfDomainsActivatedSinceLastRelease(
      TARGET,
      await listCustomDomains(TARGET),
    );
    expect(first).toEqual({ versionName: `sites/${SITE}/versions/v-live`, hostnames: [HOST] });
    const second = await purgeCdnIfDomainsActivatedSinceLastRelease(
      TARGET,
      await listCustomDomains(TARGET),
    );
    expect(second).toBeNull();
    expect(fake.live).toHaveLength(2);
  });

  it("does nothing for inactive domains or a disabled site", async () => {
    const { purgeCdnIfDomainsActivatedSinceLastRelease } = await import(
      "../firebase-custom-domain.js"
    );
    expect(await purgeCdnIfDomainsActivatedSinceLastRelease(TARGET, [stuckDomain()])).toBeNull();
    fake.live = [
      {
        name: "r",
        type: "SITE_DISABLE",
        releaseTime: "2026-10-01T00:00:00Z",
        version: { name: "" },
      },
    ];
    const active = {
      ...stuckDomain(),
      hostState: "HOST_ACTIVE",
      ownershipState: "OWNERSHIP_ACTIVE",
    };
    expect(
      await purgeCdnIfDomainsActivatedSinceLastRelease(TARGET, [
        { ...active, updateTime: "2026-10-10T18:00:00Z" },
      ]),
    ).toBeNull();
  });
});

describe("domains.hosting_status / domains.reconnect_hosting ops", () => {
  const ctx: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-0000000000a1",
    actorKind: "human",
    requestId: "firebase-custom-domain-test",
  };
  /** recordAudit writes through tx.execute — capture instead of a DB. */
  function fakeTx() {
    const executed: unknown[] = [];
    const execute = async (q: unknown) => {
      executed.push(q);
      return [];
    };
    return { executed, tx: { execute } as never };
  }

  function firebaseEnv(): void {
    process.env.CAELO_PROVIDER = "gcp-firebase";
    process.env.CAELO_FIREBASE_SITE = SITE;
    process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
  }

  it("hosting_status reports nothing on other providers", async () => {
    process.env.CAELO_PROVIDER = "gcp";
    const { hostingStatusOp } = await import("../../ops/domain_hosting.js");
    const r = await hostingStatusOp.handler(ctx, {}, fakeTx().tx);
    expect(r.ok && r.value).toEqual({ supported: false, domains: [], cdnPurge: null, error: null });
    expect(fake.calls).toEqual([]);
  });

  it("hosting_status flags the stuck domain", async () => {
    firebaseEnv();
    const { hostingStatusOp } = await import("../../ops/domain_hosting.js");
    const r = await hostingStatusOp.handler(ctx, {}, fakeTx().tx);
    if (!r.ok) throw new Error("hosting_status failed");
    expect(r.value.domains.map((d) => [d.hostname, d.status])).toEqual([[HOST, "stuck"]]);
    expect(r.value.cdnPurge).toBeNull();
  });

  it("hosting_status reports a Firebase failure as data, not a thrown op", async () => {
    firebaseEnv();
    globalThis.fetch = (async () =>
      new Response("nope", { status: 403, statusText: "Forbidden" })) as unknown as typeof fetch;
    const { hostingStatusOp } = await import("../../ops/domain_hosting.js");
    const r = await hostingStatusOp.handler(ctx, {}, fakeTx().tx);
    if (!r.ok) throw new Error("hosting_status failed");
    expect(r.value.error).toContain("403");
  });

  it("reconnect_hosting heals the stuck domain, purges the CDN and audits", async () => {
    firebaseEnv();
    const { reconnectHostingDomainOp } = await import("../../ops/domain_hosting.js");
    const { tx, executed } = fakeTx();
    const r = await reconnectHostingDomainOp.handler(ctx, { hostname: HOST }, tx);
    if (!r.ok) throw new Error(`reconnect failed: ${JSON.stringify(r.error)}`);
    expect(r.value.method).toBe("recreated");
    expect(r.value.health?.status).toBe("active");
    expect(r.value.cdnPurge?.versionName).toBe(`sites/${SITE}/versions/v-live`);
    expect(r.value.message).toContain("active again");
    expect(executed).toHaveLength(1);
  });

  it("hosting_status lists a soft-deleted domain as deleted, without recommending anything", async () => {
    firebaseEnv();
    fake.domains.clear();
    fake.softDeleted.add(HOST);
    const { hostingStatusOp } = await import("../../ops/domain_hosting.js");
    const r = await hostingStatusOp.handler(ctx, {}, fakeTx().tx);
    if (!r.ok) throw new Error("hosting_status failed");
    expect(r.value.domains.map((d) => [d.hostname, d.status])).toEqual([[HOST, "deleted"]]);
  });

  it("reconnect_hosting finishes an interrupted reconnect (soft-deleted → undelete)", async () => {
    firebaseEnv();
    fake.domains.clear();
    fake.softDeleted.add(HOST);
    fake.conflictOnSoftDeleted = true;
    const { reconnectHostingDomainOp } = await import("../../ops/domain_hosting.js");
    const r = await reconnectHostingDomainOp.handler(ctx, { hostname: HOST }, fakeTx().tx);
    if (!r.ok) throw new Error(`reconnect failed: ${JSON.stringify(r.error)}`);
    expect(r.value.method).toBe("undeleted");
    expect(r.value.health?.status).toBe("active");
    expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("reconnect_hosting refuses an active domain and an unknown hostname", async () => {
    firebaseEnv();
    const { reconnectHostingDomainOp } = await import("../../ops/domain_hosting.js");
    fake.domains.set(HOST, {
      ...stuckDomain(),
      hostState: "HOST_ACTIVE",
      ownershipState: "OWNERSHIP_ACTIVE",
    });
    const active = await reconnectHostingDomainOp.handler(ctx, { hostname: HOST }, fakeTx().tx);
    expect(active.ok).toBe(false);
    expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    const unknown = await reconnectHostingDomainOp.handler(
      ctx,
      { hostname: "other.org" },
      fakeTx().tx,
    );
    expect(unknown.ok).toBe(false);
  });
});

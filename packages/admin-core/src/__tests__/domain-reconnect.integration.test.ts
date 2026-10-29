// SPDX-License-Identifier: MPL-2.0

/**
 * Stuck Firebase Hosting custom domain → agent-proposed reconnect, against a
 * real Postgres (migration 0250 admits the `reconnect` kind) and an
 * in-memory fake of the Firebase Hosting REST API (no network, no
 * credentials).
 *
 * The path the agent takes: list_domains shows the domain as stuck; the
 * gated propose_reconnect_domain (AI proposes, the Owner's in-chat Approve
 * executes) deletes + re-creates the domain and re-releases the live
 * version to purge the CDN; the pending row ends `applied`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import * as realGoogleAuth from "google-auth-library";
import { attachGatedExecute } from "../ai/tools/gated-tools.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { LEGACY_LIVE_RELEASE_LOCK_KEY } from "../deploy/live-release-lock.js";
import { registerAdminOps } from "../register.js";

const realGoogleAuthExports = { ...realGoogleAuth };
mock.module("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: async () => ({ token: "test-token" }) };
    }
    async getProjectId() {
      return "p";
    }
  },
}));

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const OWNER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000d0e01",
  actorKind: "human",
  requestId: "domain-reconnect-owner",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000d0e02",
  actorKind: "ai",
  requestId: "domain-reconnect-ai",
};

const API = "https://firebasehosting.googleapis.com/v1beta1/";
const HOST = "domain-reconnect.example";
const DOMAINS = "projects/p/sites/s/customDomains";
const DNS = [
  {
    domainName: HOST,
    records: [{ domainName: HOST, type: "A", rdata: "199.36.158.100", requiredAction: "NONE" }],
  },
];

interface Domain {
  name: string;
  hostState: string;
  ownershipState: string;
  updateTime: string;
  requiredDnsUpdates: { checkTime: string; desired: typeof DNS; discovered: typeof DNS };
}

let domain: Domain | null;
let liveVersions: string[];
let calls: string[];

function stuck(): Domain {
  return {
    name: `${DOMAINS}/${HOST}`,
    hostState: "HOST_MISMATCH",
    ownershipState: "OWNERSHIP_PENDING",
    updateTime: "2026-09-29T09:00:00Z",
    requiredDnsUpdates: { checkTime: "2026-10-10T14:56:00Z", desired: DNS, discovered: DNS },
  };
}

const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const [route = "", query = ""] = url.slice(API.length).split("?");
  calls.push(`${method} ${route}`);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (route === DOMAINS && method === "GET") return json({ customDomains: domain ? [domain] : [] });
  if (route === DOMAINS && method === "POST") {
    domain = {
      ...stuck(),
      hostState: "HOST_ACTIVE",
      ownershipState: "OWNERSHIP_ACTIVE",
      updateTime: new Date().toISOString(),
    };
    return json({ name: "operations/x" });
  }
  if (route === `${DOMAINS}/${HOST}`) {
    if (method === "DELETE") {
      domain = null;
      return json({});
    }
    return domain ? json(domain) : json({ error: { code: 404 } }, 404);
  }
  if (route === "sites/s/channels/live/releases") {
    return json({
      releases: liveVersions.slice(0, 1).map((v) => ({
        name: "sites/s/releases/r",
        type: "DEPLOY",
        releaseTime: "2026-10-10T12:00:00Z",
        version: { name: v },
      })),
    });
  }
  if (route === "sites/s/releases" && method === "POST") {
    liveVersions.unshift(new URLSearchParams(query).get("versionName") ?? "");
    return json({});
  }
  throw new Error(`unhandled ${method} ${url}`);
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const realFetch = globalThis.fetch;
const ENV_KEYS = ["CAELO_PROVIDER", "CAELO_FIREBASE_SITE", "GOOGLE_CLOUD_PROJECT"] as const;
const savedEnv: Record<string, string | undefined> = {};

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    let out!: T;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      out = await fn(tx as unknown as SQL);
    });
    return out;
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await asSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER.actorId}::uuid, 'human', 'domain-reconnect-owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER.actorId}::uuid, 'owner@domain-reconnect.test', 'test-only') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER.actorId}::uuid, id FROM roles WHERE name = 'owner' ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${AI.actorId}::uuid, 'ai', 'domain-reconnect-ai') ON CONFLICT DO NOTHING`;
  });
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await asSystem(async (tx) => {
    await tx`DELETE FROM domain_pending_actions WHERE proposed_by = ${AI.actorId}::uuid`;
  });
  mock.module("google-auth-library", () => realGoogleAuthExports);
});

beforeEach(() => {
  domain = stuck();
  liveVersions = ["sites/s/versions/v-live"];
  calls = [];
  globalThis.fetch = fakeFetch as typeof fetch;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CAELO_PROVIDER = "gcp-firebase";
  process.env.CAELO_FIREBASE_SITE = "s";
  process.env.GOOGLE_CLOUD_PROJECT = "p";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("stuck Firebase custom domain → propose_reconnect_domain", () => {
  it("list_domains tells the agent the domain is stuck and which tool heals it", async () => {
    const tools = createDefaultToolRegistry();
    const r = await tools.dispatch("list_domains", {}, AI, { adapter, registry });
    expect(r.ok).toBe(true);
    expect(r.content).toContain(`${HOST}: stuck — reconnect recommended`);
    expect(r.content).toContain("propose_reconnect_domain");
  });

  it("the AI cannot reconnect directly", async () => {
    const r = await execute(registry, adapter, AI, "domains.reconnect_hosting", {
      hostname: HOST,
    });
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("approved in chat: re-creates the domain, purges the CDN, row applied", async () => {
    const tool = createDefaultToolRegistry()
      .catalogue()
      .find((t) => t.name === "propose_reconnect_domain");
    if (!tool) throw new Error("propose_reconnect_domain not registered");
    const gated = attachGatedExecute(tool, registry, adapter, AI, OWNER);
    const out = (await gated.execute?.({ hostname: HOST })) as {
      ok: boolean;
      error?: string;
      value?: { reconnect?: { method: string; cdnPurge: { versionName: string } | null } };
    };
    expect(out.error).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.value?.reconnect?.method).toBe("recreated");
    expect(out.value?.reconnect?.cdnPurge?.versionName).toBe("sites/s/versions/v-live");
    expect(calls).toContain(`DELETE ${DOMAINS}/${HOST}`);
    expect(liveVersions).toEqual(["sites/s/versions/v-live", "sites/s/versions/v-live"]);
    const rows = await asSystem(
      (tx) =>
        tx`SELECT kind, status, preview->>'status' AS diagnosed FROM domain_pending_actions WHERE proposed_by = ${AI.actorId}::uuid ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({ kind: "reconnect", status: "applied", diagnosed: "stuck" });
  });

  it("a status read never re-releases while a publish holds the live-release lock", async () => {
    // Regression: the stateless CDN purge in domains.hosting_status could
    // re-release the old live version over a publish landing in between.
    // deploy.promote / deploy.rollback hold this lock across their release.
    domain = {
      ...stuck(),
      hostState: "HOST_ACTIVE",
      ownershipState: "OWNERSHIP_ACTIVE",
      updateTime: new Date().toISOString(),
    };
    const publisher = new SQL(ADMIN_URL as string);
    try {
      let releaseLock!: () => void;
      const held = new Promise<void>((r) => {
        releaseLock = r;
      });
      let locked!: () => void;
      const lockTaken = new Promise<void>((r) => {
        locked = r;
      });
      // #1225 — a Publish live of this release holds the live-release
      // lease as its run, with no transaction open: the purge skips too.
      const runId = crypto.randomUUID();
      await publisher.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, lease_expires_at)
                 SELECT ${runId}::uuid, id, '00000000-0000-0000-0000-00000000ffff'::uuid,
                        'running', clock_timestamp() + interval '2 minutes'
                 FROM deploy_targets WHERE env = 'production' LIMIT 1`;
        await tx`INSERT INTO deploy_leases (name, holder_run_id, acquired_at, expires_at)
                 VALUES ('live-release', ${runId}::uuid, clock_timestamp(),
                         clock_timestamp() + interval '2 minutes')
                 ON CONFLICT (name) DO UPDATE SET holder_run_id = EXCLUDED.holder_run_id,
                   acquired_at = EXCLUDED.acquired_at, expires_at = EXCLUDED.expires_at`;
      });
      const leased = await execute(registry, adapter, AI, "domains.hosting_status", {});
      expect((leased as { value: { cdnPurge: unknown } }).value.cdnPurge).toBeNull();
      expect(liveVersions).toEqual(["sites/s/versions/v-live"]);
      await publisher.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`UPDATE deploy_leases SET holder_run_id = NULL, acquired_at = NULL, expires_at = NULL
                 WHERE name = 'live-release'`;
        await tx`DELETE FROM deploy_runs WHERE id = ${runId}::uuid`;
      });
      // Rolling update: a publish of the previous release holds the advisory lock.
      const publish = publisher.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${LEGACY_LIVE_RELEASE_LOCK_KEY}))`;
        locked();
        await held;
      });
      await lockTaken;
      const during = await execute(registry, adapter, AI, "domains.hosting_status", {});
      expect(during.ok).toBe(true);
      expect((during as { value: { cdnPurge: unknown } }).value.cdnPurge).toBeNull();
      expect(liveVersions).toEqual(["sites/s/versions/v-live"]);
      releaseLock();
      await publish;
      const after = await execute(registry, adapter, AI, "domains.hosting_status", {});
      expect((after as { value: { cdnPurge: { hostnames: string[] } } }).value.cdnPurge).toEqual({
        versionName: "sites/s/versions/v-live",
        hostnames: [HOST],
      });
      expect(liveVersions).toHaveLength(2);
    } finally {
      await publisher.end();
    }
  });

  it("refuses to propose for an active domain or on another provider", async () => {
    domain = { ...stuck(), hostState: "HOST_ACTIVE", ownershipState: "OWNERSHIP_ACTIVE" };
    const active = await execute(registry, adapter, AI, "domains.propose_reconnect", {
      hostname: HOST,
    });
    expect(active.ok).toBe(false);
    process.env.CAELO_PROVIDER = "gcp";
    const other = await execute(registry, adapter, AI, "domains.propose_reconnect", {
      hostname: HOST,
    });
    expect(other.ok).toBe(false);
  });
});

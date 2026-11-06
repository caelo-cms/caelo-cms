// SPDX-License-Identifier: MPL-2.0

/**
 * #1476 — the cloud path of the `/setup` gate, against a real database and a
 * fake Secret Manager: the installer's token reaches `owner_bootstrap_tokens`,
 * so `users.create_first_owner` refuses without it, and a token the admin
 * cannot read refuses instead of reading as "none was ever issued".
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, OWNER_BOOTSTRAP_TOKEN_SECRET } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import type { GoogleDeps } from "../security/operator-access/google-iam.js";
import { ensureOwnerBootstrapToken } from "../security/owner-bootstrap-secret.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "owner-bootstrap-secret-test",
};

const EMAIL = "owner-bootstrap-secret@example.com";
const PASSWORD = "harbor-violet-lantern-58";
const TOKEN = "c".repeat(64);
const PROJECT = "acme-site";
// The database compares expires_at with its own clock.
const NOW = Date.now();
const VALID = new Date(NOW + 3_600_000).toISOString();
const EXPIRED = new Date(NOW - 3_600_000).toISOString();

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function tokenRows(): Promise<number> {
  return asSystem(async (tx) => {
    const rows = await tx`SELECT count(*)::int AS n FROM owner_bootstrap_tokens`;
    return (rows[0] as { n: number }).n;
  });
}

/** Secret Manager answering `status` with `body`; records what was asked. */
function secretManager(status: number, body: unknown): { deps: GoogleDeps; urls: string[] } {
  const urls: string[] = [];
  const deps: GoogleDeps = {
    accessToken: async () => "access-token",
    metadata: async (path) => {
      expect(path).toBe("project/project-id");
      return PROJECT;
    },
    fetch: (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
  };
  return { deps, urls };
}

const secretValue = (value: string) => ({
  payload: { data: Buffer.from(value, "utf8").toString("base64") },
});
const storedToken = (expiresAt: string) =>
  secretManager(200, secretValue(JSON.stringify({ token: TOKEN, expiresAt })));

const ensure = (google: GoogleDeps, provider = "gcp-firebase") =>
  ensureOwnerBootstrapToken({
    provider,
    adapter,
    registry,
    requestId: systemCtx.requestId,
    google,
    now: () => NOW,
  });

const createFirstOwner = (bootstrapToken?: string) =>
  execute(registry, adapter, systemCtx, "users.create_first_owner", {
    email: EMAIL,
    password: PASSWORD,
    displayName: "First Owner",
    ...(bootstrapToken ? { bootstrapToken } : {}),
  });

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

beforeEach(async () => {
  await asSystem(async (tx) => {
    await tx`DELETE FROM owner_bootstrap_tokens`;
    await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${EMAIL})`;
    await tx`DELETE FROM users WHERE email = ${EMAIL}`;
    await tx`UPDATE users SET deleted_at = now() WHERE deleted_at IS NULL`;
  });
});

describe("the token in Secret Manager reaches the /setup gate", () => {
  it.each(["gcp", "gcp-firebase"])("on %s, /setup needs the token afterwards", async (provider) => {
    const gcp = storedToken(VALID);
    expect(await ensure(gcp.deps, provider)).toEqual({ ok: true });
    expect(gcp.urls).toEqual([
      `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${OWNER_BOOTSTRAP_TOKEN_SECRET}/versions/latest:access`,
    ]);

    const without = await createFirstOwner();
    expect(without.ok).toBe(false);
    if (!without.ok) expect(JSON.stringify(without.error)).toContain("Bootstrap token required");

    expect((await createFirstOwner("d".repeat(64))).ok).toBe(false);
    expect((await createFirstOwner(TOKEN)).ok).toBe(true);
  });

  it("inserts once, however often /setup opens", async () => {
    await ensure(storedToken(VALID).deps);
    await ensure(storedToken(VALID).deps);
    expect(await tokenRows()).toBe(1);
  });

  it("a used token stays used on the next read", async () => {
    await ensure(storedToken(VALID).deps);
    expect((await createFirstOwner(TOKEN)).ok).toBe(true);
    await ensure(storedToken(VALID).deps);
    await asSystem(async (tx) => {
      await tx`UPDATE users SET deleted_at = now() WHERE email = ${EMAIL}`;
    });
    expect((await createFirstOwner(TOKEN)).ok).toBe(false);
  });
});

describe("fails closed", () => {
  it("an expired link is refused with the command for a new one", async () => {
    const r = await ensure(storedToken(EXPIRED).deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain(EXPIRED);
      expect(r.message).toContain(`setup-link --project ${PROJECT}`);
    }
    // In the table all the same: the gate stays shut for a late attempt.
    expect((await createFirstOwner(TOKEN)).ok).toBe(false);
  });

  it.each([
    ["no secret yet", 404, {}],
    ["no read access (also a secret that does not exist)", 403, {}],
    ["a disabled version", 400, {}],
    ["a value that is no token", 200, secretValue("garbage")],
    ["a response without a value", 200, {}],
  ])("%s: refused with the next step, no token inserted", async (_case, status, body) => {
    const r = await ensure(secretManager(status, body).deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(`setup-link --project ${PROJECT}`);
    expect(await tokenRows()).toBe(0);
  });

  it("a Secret Manager outage says to retry, not to mint a new link", async () => {
    const r = await ensure(secretManager(503, {}).deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("Reload this page");
      expect(r.message).not.toContain("setup-link");
    }
  });

  it("a failing metadata server is refused too", async () => {
    const { deps } = storedToken(VALID);
    const r = await ensure({
      ...deps,
      metadata: async () => {
        throw new Error("no metadata server");
      },
    });
    expect(r.ok).toBe(false);
  });

  it.each(["aws", "azure"])(
    "%s has no path yet: refused, never waved through",
    async (provider) => {
      const gcp = storedToken(VALID);
      const r = await ensure(gcp.deps, provider);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("#1483");
      expect(gcp.urls).toEqual([]);
    },
  );
});

describe("installs without a cloud token", () => {
  it.each([undefined, "", "self-hosted"])(
    "provider %p reads no secret and keeps the pending-token path",
    async (provider) => {
      const gcp = storedToken(VALID);
      const r = await ensureOwnerBootstrapToken({
        provider,
        adapter,
        registry,
        requestId: systemCtx.requestId,
        google: gcp.deps,
      });
      expect(r).toEqual({ ok: true });
      expect(gcp.urls).toEqual([]);
      expect(await tokenRows()).toBe(0);
    },
  );
});

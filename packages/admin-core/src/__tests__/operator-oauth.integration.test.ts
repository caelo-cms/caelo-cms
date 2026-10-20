// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #914 — the install's Google sign-in client against real Postgres
 * (§6):
 *
 *   - `operator_oauth.{get,set,clear}`: one row at most, the ID shape
 *     enforced by the op and by the table (0323), audited, Owner-only — the
 *     writer rule holds at the Postgres layer; the #806 table is gone;
 *   - the operator-access sync job's read: `operator_oauth.client_for_sync`
 *     works as the read-only `operator_access_reader` role, which may read
 *     the client ID and nothing else of the table, and write nothing (0324);
 *   - the Settings → Google sign-in flows (configure.ts) with fake Google, a
 *     fake sync job and a fake IAP: the secret version comes first, a failed
 *     write changes nothing, the secret never reaches the database or the
 *     audit log, removing clears the row;
 *   - the identity-gate guard on user creation (users.create for the panel,
 *     users.propose_create for the AI): an address outside the project's
 *     Google organisation is refused with the next step until the sign-in
 *     client is configured.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { operatorOAuthClientForSyncOp } from "../ops/security/operator_oauth.js";
import { registerAdminOps } from "../register.js";
import {
  removeGoogleSignInClient,
  saveGoogleSignInClient,
} from "../security/google-sign-in/configure.js";
import { googleSignInAvailability } from "../security/google-sign-in/setup.js";
import { setIdentityGateEnvForTests } from "../security/identity-gate.js";
import type { GoogleDeps } from "../security/operator-access/google-iam.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const CLIENT = "123456789012-abc123def456.apps.googleusercontent.com";
const OTHER = "123456789012-zzz999.apps.googleusercontent.com";
const GOOGLE_MANAGED = "777-managed.apps.googleusercontent.com";
const SECRET = "GOCSPX-super-secret-value_123";
const ADMIN_SITE = "https://caelo-production-admin-aaa-ew.a.run.app";
const PUBLIC = "https://caelo-production-gateway-bbb-xyz.a.run.app";
const STORE = "projects/acme-site/secrets/caelo-production-operator-oauth-client";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const ownerId = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: ownerId, actorKind: "human", requestId: "signin" };
const editorId = crypto.randomUUID();
const EDITOR: ExecutionContext = {
  actorId: editorId,
  actorKind: "human",
  requestId: "signin-editor",
};
const aiId = crypto.randomUUID();
const AI: ExecutionContext = { actorId: aiId, actorKind: "ai", requestId: "signin-ai" };
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "signin-sys",
};

async function admin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const db = new SQL(ADMIN_URL as string);
  try {
    let result!: T;
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      result = await fn(tx as unknown as SQL);
    });
    return result;
  } finally {
    await db.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await admin(async (tx) => {
    // The writer policy (0323) checks settings.write at the Postgres layer,
    // so the Owner is a real user with the owner role; the editor is not one.
    for (const [id, name, role] of [
      [ownerId, "Sign-in owner", "owner"],
      [editorId, "Sign-in editor", "editor"],
    ] as const) {
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${id}::uuid, 'human', ${name})`;
      await tx`INSERT INTO users (id, email, password_hash)
               VALUES (${id}::uuid, ${`${id}@t914-signin.test`}, 'test-only')`;
      await tx`INSERT INTO user_roles (user_id, role_id)
               SELECT ${id}::uuid, id FROM roles WHERE name = ${role}`;
    }
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${aiId}::uuid, 'ai', 't914-ai')`;
  });
});
afterEach(async () => {
  setIdentityGateEnvForTests(null);
  await admin(async (tx) => {
    await tx`DELETE FROM operator_oauth_client`;
  });
});
afterAll(async () => {
  await adapter.close();
});

const get = async () => {
  const r = await execute(registry, adapter, OWNER, "operator_oauth.get", {});
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { client: { clientId: string } | null }).client;
};

describe("operator_oauth ops", () => {
  it("replaced the #806 table (delete-don't-migrate)", async () => {
    const tables = (await admin(
      (tx) =>
        tx`SELECT to_regclass('public.mcp_remote_oauth_client') AS old, to_regclass('public.operator_oauth_client') AS new`,
    )) as { old: string | null; new: string | null }[];
    expect(tables[0]).toEqual({ old: null, new: "operator_oauth_client" });
  });

  it("keeps at most one client, replaces it on set, removes it on clear — audited", async () => {
    expect(await get()).toBeNull();
    for (const clientId of [CLIENT, OTHER]) {
      const r = await execute(registry, adapter, OWNER, "operator_oauth.set", { clientId });
      expect(r.ok).toBe(true);
    }
    expect((await get())?.clientId).toBe(OTHER);
    expect(await admin((tx) => tx`SELECT count(*)::int AS n FROM operator_oauth_client`)).toEqual([
      { n: 1 },
    ]);
    const cleared = await execute(registry, adapter, OWNER, "operator_oauth.clear", {});
    expect(cleared.ok && cleared.value).toEqual({ cleared: true });
    expect(await get()).toBeNull();
    const audit = (await admin(
      (tx) =>
        tx`SELECT operation FROM audit_events WHERE actor_id = ${ownerId}::uuid AND operation LIKE 'operator_oauth.%' ORDER BY created_at`,
    )) as { operation: string }[];
    expect(audit.map((a) => a.operation)).toEqual([
      "operator_oauth.set",
      "operator_oauth.set",
      "operator_oauth.clear",
    ]);
  });

  it("rejects anything that is not a Google OAuth client ID — in the op and in the table", async () => {
    const r = await execute(registry, adapter, OWNER, "operator_oauth.set", {
      clientId: "not-a-client",
    });
    expect(r.ok).toBe(false);
    const denied = await admin(
      (tx) =>
        tx`INSERT INTO operator_oauth_client (client_id, configured_by) VALUES ('evil', ${ownerId}::uuid)`,
    ).catch((e: unknown) => String(e));
    expect(String(denied)).toContain("check constraint");
  });

  it("is Owner-only: the AI can neither read nor set the client", async () => {
    for (const op of ["operator_oauth.get", "operator_oauth.set", "operator_oauth.clear"]) {
      const r = await execute(
        registry,
        adapter,
        AI,
        op,
        op.endsWith("set") ? { clientId: CLIENT } : {},
      );
      expect(r.ok === false && r.error.kind).toBe("ActorScopeRejected");
    }
    const sync = await execute(registry, adapter, OWNER, "operator_oauth.client_for_sync", {});
    expect(sync.ok === false && sync.error.kind).toBe("ActorScopeRejected");
  });

  it("refuses a human without settings.write at the Postgres layer, not only in the route", async () => {
    const set = await execute(registry, adapter, EDITOR, "operator_oauth.set", {
      clientId: OTHER,
    });
    expect(set.ok).toBe(false);
    expect(await get()).toBeNull();

    await execute(registry, adapter, OWNER, "operator_oauth.set", { clientId: CLIENT });
    const replace = await execute(registry, adapter, EDITOR, "operator_oauth.set", {
      clientId: OTHER,
    });
    expect(replace.ok).toBe(false);
    const clear = await execute(registry, adapter, EDITOR, "operator_oauth.clear", {});
    expect(clear.ok && clear.value).toEqual({ cleared: false });
    expect((await get())?.clientId).toBe(CLIENT);
  });
});

describe("the sync job's read (operator_access_reader, 0324)", () => {
  it("reads the client ID as the read-only role, regardless of the session's actor kind", async () => {
    await execute(registry, adapter, OWNER, "operator_oauth.set", { clientId: CLIENT });
    const result = await adapter.withAdminTransaction(SYSTEM, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE operator_access_reader`);
      await tx.execute(sql`SELECT set_config('caelo.actor_kind', '', true)`);
      return operatorOAuthClientForSyncOp.handler(SYSTEM, {}, tx);
    });
    expect(result.ok && result.value).toEqual({ clientId: CLIENT });
  });

  it("reads null when none is configured (the job then clears IAP's oauthSettings)", async () => {
    const r = await execute(registry, adapter, SYSTEM, "operator_oauth.client_for_sync", {});
    expect(r.ok && r.value).toEqual({ clientId: null });
  });

  it("may read nothing else of the table and write nothing", async () => {
    for (const forbidden of [
      "SELECT configured_by FROM operator_oauth_client",
      "SELECT * FROM operator_oauth_client",
      "DELETE FROM operator_oauth_client",
      "UPDATE operator_oauth_client SET client_id = client_id",
    ]) {
      const denied = await adapter
        .withAdminTransaction(SYSTEM, async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE operator_access_reader`);
          await tx.execute(sql.raw(forbidden));
          return "allowed";
        })
        .catch((e: unknown) => String((e as { cause?: unknown }).cause ?? e));
      expect(denied).toContain("permission denied");
    }
  });
});

describe("Settings → Google sign-in flows (configure.ts)", () => {
  const available = googleSignInAvailability({
    CAELO_PROVIDER: "gcp-firebase",
    CAELO_ADMIN_URL: ADMIN_SITE,
    CAELO_MCP_PUBLIC_URL: PUBLIC,
    CAELO_OPERATOR_OAUTH_CLIENT_STORE: STORE,
    CAELO_GOOGLE_ORG_DOMAIN: "acme.com",
  });
  if (available.status !== "available") throw new Error("fixture env not available");

  /** Fake Secret Manager recording the payloads it receives. */
  function fakeGoogle(opts: { status?: number } = {}) {
    const payloads: string[] = [];
    const google: GoogleDeps = {
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (opts.status) return new Response("denied", { status: opts.status });
        const body = JSON.parse(String(init?.body)) as { payload: { data: string } };
        payloads.push(Buffer.from(body.payload.data, "base64").toString("utf8"));
        return new Response(JSON.stringify({ name: `${STORE}/versions/${payloads.length + 1}` }));
      }) as typeof fetch,
      accessToken: async () => "tok",
      metadata: async () => "",
    };
    return { google, payloads };
  }
  /** IAP in front of the admin, signing people in with whatever the last payload configured. */
  function fakeIap(payloads: string[]) {
    return {
      fetch: (async () => {
        const last = JSON.parse(payloads.at(-1) ?? "{}") as { client_id?: string };
        const id = last.client_id ?? GOOGLE_MANAGED;
        return new Response(null, {
          status: 302,
          headers: { location: `https://accounts.google.com/o/oauth2/v2/auth?client_id=${id}` },
        });
      }) as typeof fetch,
      sleep: async () => {},
    };
  }
  const synced = async () => ({
    status: "synced" as const,
    target: "t",
    execution: "e",
    logsUrl: "l",
  });

  it("save: stores the secret, records the ID, syncs, and the sign-in check passes", async () => {
    const { google, payloads } = fakeGoogle();
    let syncs = 0;
    const r = await saveGoogleSignInClient(
      registry,
      adapter,
      OWNER,
      available,
      { clientId: CLIENT, clientSecret: SECRET },
      {
        google,
        check: fakeIap(payloads),
        sync: async () => {
          syncs += 1;
          // The job reads the row: it must be there before the sync starts.
          expect((await get())?.clientId).toBe(CLIENT);
          return synced();
        },
      },
    );
    expect(r.ok && r.checks.map((c) => [c.id, c.ok])).toEqual([
      ["iap-sync", true],
      ["admin-sign-in", true],
    ]);
    expect(syncs).toBe(1);
    expect(JSON.parse(payloads[0] ?? "")).toEqual({ client_id: CLIENT, client_secret: SECRET });
    // The secret is in Secret Manager only — never in cms_admin.
    const leaked = (await admin(
      (tx) =>
        tx`SELECT count(*)::int AS n FROM audit_events WHERE result_summary LIKE ${`%${SECRET}%`}`,
    )) as { n: number }[];
    expect(leaked[0]?.n).toBe(0);
  });

  it("save: a refused secret write changes nothing and names the next step", async () => {
    const { google } = fakeGoogle({ status: 403 });
    const r = await saveGoogleSignInClient(
      registry,
      adapter,
      OWNER,
      available,
      { clientId: CLIENT, clientSecret: SECRET },
      { google, check: fakeIap([]), sync: synced },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.step).toBe("secret");
      expect(r.nextStep).toContain("cms-provision upgrade");
      expect(r.error).not.toContain(SECRET);
    }
    expect(await get()).toBeNull();
  });

  it("remove: writes {}, clears the row, syncs, and IAP no longer names the client", async () => {
    await execute(registry, adapter, OWNER, "operator_oauth.set", { clientId: CLIENT });
    const { google, payloads } = fakeGoogle();
    const r = await removeGoogleSignInClient(registry, adapter, OWNER, available, CLIENT, {
      google,
      check: fakeIap(payloads),
      sync: synced,
    });
    expect(payloads).toEqual(["{}"]);
    expect(await get()).toBeNull();
    expect(r.ok && r.checks.map((c) => [c.id, c.ok])).toEqual([
      ["iap-sync", true],
      ["admin-sign-in", true],
    ]);
  });
});

describe("user creation asks the identity gate first (#914)", () => {
  const gmail = () => `t914-${crypto.randomUUID().slice(0, 8)}@gmail.com`;
  const inOrg = () => `t914-${crypto.randomUUID().slice(0, 8)}@acme.com`;
  const create = (ctx: ExecutionContext, email: string) =>
    execute(registry, adapter, { ...ctx, actorKind: "system" }, "users.create", {
      email,
      password: "a-Long-and-unique-passphrase-914!",
      displayName: "T914 user",
      roleNames: ["editor"],
    });
  const propose = (email: string) =>
    execute(registry, adapter, AI, "users.propose_create", {
      email,
      displayName: "T914 proposed",
      roleNames: ["editor"],
    });

  it("refuses an outside-the-organisation account on Google IAP without a sign-in client — panel and AI", async () => {
    setIdentityGateEnvForTests({ CAELO_PROVIDER: "gcp", CAELO_GOOGLE_ORG_DOMAIN: "acme.com" });
    const email = gmail();
    for (const r of [await create(OWNER, email), await propose(email)]) {
      expect(r.ok).toBe(false);
      if (r.ok || r.error.kind !== "HandlerError") throw new Error("expected a HandlerError");
      expect(r.error.message).toContain("outside this project's Google organisation (acme.com)");
      expect(r.error.message).toContain("Next step: Set up Google sign-in first");
      expect(r.error.message).toContain("/settings/google-sign-in");
    }
    const rows = (await admin(
      (tx) => tx`SELECT count(*)::int AS n FROM users WHERE email = ${email}`,
    )) as { n: number }[];
    expect(rows[0]?.n).toBe(0);
  });

  it("admits the organisation's accounts without a client, and everyone once it is set up", async () => {
    setIdentityGateEnvForTests({
      CAELO_PROVIDER: "gcp-firebase",
      CAELO_GOOGLE_ORG_DOMAIN: "acme.com",
    });
    expect((await create(OWNER, inOrg())).ok).toBe(true);
    await execute(registry, adapter, OWNER, "operator_oauth.set", { clientId: CLIENT });
    expect((await create(OWNER, gmail())).ok).toBe(true);
    expect((await propose(gmail())).ok).toBe(true);
  });

  it("refuses loudly when the install does not know its organisation", async () => {
    setIdentityGateEnvForTests({ CAELO_PROVIDER: "gcp" });
    const r = await create(OWNER, inOrg());
    expect(r.ok === false && r.error.kind === "HandlerError" && r.error.message).toContain(
      "does not know its Google organisation",
    );
  });

  it("passes through on providers whose gate Caelo does not manage", async () => {
    setIdentityGateEnvForTests({ CAELO_PROVIDER: "self-hosted" });
    expect((await create(OWNER, gmail())).ok).toBe(true);
  });
});

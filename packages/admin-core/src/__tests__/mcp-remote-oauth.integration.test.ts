// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — the remote-MCP OAuth client against real Postgres (§6):
 *
 *   - `mcp_remote_oauth.{get,set,clear}`: one row at most, the ID shape
 *     enforced by the op and by the table (0320), audited, Owner-only;
 *   - the operator-access sync job's read: `mcp_remote_oauth.client_for_sync`
 *     works as the read-only `operator_access_reader` role, which may read
 *     the client ID and nothing else of the table, and write nothing (0321);
 *   - the Settings → MCP → Remote flows (configure.ts) with fake Google,
 *     a fake sync job and a fake gateway: the secret version comes first, a
 *     failed write changes nothing, the secret never reaches the database
 *     or the audit log, turning off clears the row.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { mcpRemoteOAuthClientForSyncOp } from "../ops/security/mcp_remote_oauth.js";
import { registerAdminOps } from "../register.js";
import type { GoogleDeps } from "../security/operator-access/google-iam.js";
import { disableRemoteMcp, saveRemoteMcpClient } from "../security/remote-mcp/configure.js";
import { remoteMcpAvailability } from "../security/remote-mcp/setup.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const CLIENT = "123456789012-abc123def456.apps.googleusercontent.com";
const OTHER = "123456789012-zzz999.apps.googleusercontent.com";
const SECRET = "GOCSPX-super-secret-value_123";
const PUBLIC = "https://caelo-production-gateway-bbb-xyz.a.run.app";
const STORE = "projects/acme-site/secrets/caelo-production-mcp-oauth-client";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const ownerId = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: ownerId, actorKind: "human", requestId: "remote-mcp" };
const editorId = crypto.randomUUID();
const EDITOR: ExecutionContext = {
  actorId: editorId,
  actorKind: "human",
  requestId: "remote-mcp-editor",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000a11a0",
  actorKind: "ai",
  requestId: "remote-mcp-ai",
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "remote-mcp-sys",
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
    // The writer policy (0320) checks settings.write at the Postgres layer,
    // so the Owner is a real user with the owner role; the editor is not one.
    for (const [id, name, role] of [
      [ownerId, "Remote MCP owner", "owner"],
      [editorId, "Remote MCP editor", "editor"],
    ] as const) {
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${id}::uuid, 'human', ${name})`;
      await tx`INSERT INTO users (id, email, password_hash)
               VALUES (${id}::uuid, ${`${id}@t806-oauth.test`}, 'test-only')`;
      await tx`INSERT INTO user_roles (user_id, role_id)
               SELECT ${id}::uuid, id FROM roles WHERE name = ${role}`;
    }
  });
});
afterEach(async () => {
  await admin(async (tx) => {
    await tx`DELETE FROM mcp_remote_oauth_client`;
  });
});
afterAll(async () => {
  await adapter.close();
});

const get = async () => {
  const r = await execute(registry, adapter, OWNER, "mcp_remote_oauth.get", {});
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { client: { clientId: string } | null }).client;
};

describe("mcp_remote_oauth ops", () => {
  it("keeps at most one client, replaces it on set, removes it on clear — audited", async () => {
    expect(await get()).toBeNull();
    for (const clientId of [CLIENT, OTHER]) {
      const r = await execute(registry, adapter, OWNER, "mcp_remote_oauth.set", { clientId });
      expect(r.ok).toBe(true);
    }
    expect((await get())?.clientId).toBe(OTHER);
    expect(await admin((tx) => tx`SELECT count(*)::int AS n FROM mcp_remote_oauth_client`)).toEqual(
      [{ n: 1 }],
    );
    const cleared = await execute(registry, adapter, OWNER, "mcp_remote_oauth.clear", {});
    expect(cleared.ok && cleared.value).toEqual({ cleared: true });
    expect(await get()).toBeNull();
    const audit = (await admin(
      (tx) =>
        tx`SELECT operation FROM audit_events WHERE actor_id = ${ownerId}::uuid ORDER BY created_at`,
    )) as { operation: string }[];
    expect(audit.map((a) => a.operation)).toEqual([
      "mcp_remote_oauth.set",
      "mcp_remote_oauth.set",
      "mcp_remote_oauth.clear",
    ]);
  });

  it("rejects anything that is not a Google OAuth client ID — in the op and in the table", async () => {
    const r = await execute(registry, adapter, OWNER, "mcp_remote_oauth.set", {
      clientId: "not-a-client",
    });
    expect(r.ok).toBe(false);
    const denied = await admin(
      (tx) =>
        tx`INSERT INTO mcp_remote_oauth_client (client_id, configured_by) VALUES ('evil', ${ownerId}::uuid)`,
    ).catch((e: unknown) => String(e));
    expect(String(denied)).toContain("check constraint");
  });

  it("is Owner-only: the AI can neither read nor set the client", async () => {
    for (const op of ["mcp_remote_oauth.get", "mcp_remote_oauth.set", "mcp_remote_oauth.clear"]) {
      const r = await execute(
        registry,
        adapter,
        AI,
        op,
        op.endsWith("set") ? { clientId: CLIENT } : {},
      );
      expect(r.ok === false && r.error.kind).toBe("ActorScopeRejected");
    }
    const sync = await execute(registry, adapter, OWNER, "mcp_remote_oauth.client_for_sync", {});
    expect(sync.ok === false && sync.error.kind).toBe("ActorScopeRejected");
  });

  it("refuses a human without settings.write at the Postgres layer, not only in the route", async () => {
    const set = await execute(registry, adapter, EDITOR, "mcp_remote_oauth.set", {
      clientId: OTHER,
    });
    expect(set.ok).toBe(false);
    expect(await get()).toBeNull();

    await execute(registry, adapter, OWNER, "mcp_remote_oauth.set", { clientId: CLIENT });
    const replace = await execute(registry, adapter, EDITOR, "mcp_remote_oauth.set", {
      clientId: OTHER,
    });
    expect(replace.ok).toBe(false);
    const clear = await execute(registry, adapter, EDITOR, "mcp_remote_oauth.clear", {});
    expect(clear.ok && clear.value).toEqual({ cleared: false });
    expect((await get())?.clientId).toBe(CLIENT);
  });
});

describe("the sync job's read (operator_access_reader, 0321)", () => {
  it("reads the client ID as the read-only role, regardless of the session's actor kind", async () => {
    await execute(registry, adapter, OWNER, "mcp_remote_oauth.set", { clientId: CLIENT });
    const result = await adapter.withAdminTransaction(SYSTEM, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE operator_access_reader`);
      await tx.execute(sql`SELECT set_config('caelo.actor_kind', '', true)`);
      return mcpRemoteOAuthClientForSyncOp.handler(SYSTEM, {}, tx);
    });
    expect(result.ok && result.value).toEqual({ clientId: CLIENT });
  });

  it("reads null when none is configured (the job then clears programmatic_clients)", async () => {
    const r = await execute(registry, adapter, SYSTEM, "mcp_remote_oauth.client_for_sync", {});
    expect(r.ok && r.value).toEqual({ clientId: null });
  });

  it("may read nothing else of the table and write nothing", async () => {
    for (const forbidden of [
      "SELECT configured_by FROM mcp_remote_oauth_client",
      "SELECT * FROM mcp_remote_oauth_client",
      "DELETE FROM mcp_remote_oauth_client",
      "UPDATE mcp_remote_oauth_client SET client_id = client_id",
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

describe("Settings → MCP → Remote flows (configure.ts)", () => {
  const available = remoteMcpAvailability({
    CAELO_PROVIDER: "gcp-firebase",
    CAELO_MCP_PUBLIC_URL: PUBLIC,
    CAELO_IAP_AUDIENCE: "/projects/42/locations/europe-west1/services/caelo-production-admin-aaa",
    CAELO_MCP_OAUTH_CLIENT_STORE: STORE,
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
  /** A gateway that serves whatever the last payload configured. */
  function fakeGateway(payloads: string[]) {
    return {
      fetch: (async (input: string | URL | Request) => {
        const path = String(input).slice(PUBLIC.length);
        const last = JSON.parse(payloads.at(-1) ?? "{}") as { client_id?: string };
        if (path === "/api/mcp/oauth/status") {
          return Response.json(
            last.client_id ? { configured: true, clientId: last.client_id } : { configured: false },
          );
        }
        if (path === "/.well-known/oauth-authorization-server/api/mcp/oauth") {
          return Response.json({ issuer: `${PUBLIC}/api/mcp/oauth` });
        }
        if (path === "/.well-known/oauth-protected-resource/api/mcp/chat") {
          return Response.json({
            resource: `${PUBLIC}/api/mcp/chat`,
            authorization_servers: [`${PUBLIC}/api/mcp/oauth`],
          });
        }
        return new Response("no", { status: 404 });
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

  it("save: stores the secret for the gateway, records the ID, syncs, and every check passes", async () => {
    const { google, payloads } = fakeGoogle();
    let syncs = 0;
    const r = await saveRemoteMcpClient(
      registry,
      adapter,
      OWNER,
      available,
      { clientId: CLIENT, clientSecret: SECRET },
      {
        google,
        check: fakeGateway(payloads),
        sync: async () => {
          syncs += 1;
          // The job reads the row: it must be there before the sync starts.
          expect((await get())?.clientId).toBe(CLIENT);
          return synced();
        },
      },
    );
    expect(r.ok && r.checks.every((c) => c.ok)).toBe(true);
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
    const r = await saveRemoteMcpClient(
      registry,
      adapter,
      OWNER,
      available,
      { clientId: CLIENT, clientSecret: SECRET },
      { google, check: fakeGateway([]), sync: synced },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.step).toBe("secret");
      expect(r.nextStep).toContain("cms-provision upgrade");
      expect(r.error).not.toContain(SECRET);
    }
    expect(await get()).toBeNull();
  });

  it("off: writes {} for the gateway, clears the row, syncs, and the gateway reports off", async () => {
    await execute(registry, adapter, OWNER, "mcp_remote_oauth.set", { clientId: CLIENT });
    const { google, payloads } = fakeGoogle();
    const r = await disableRemoteMcp(registry, adapter, OWNER, available, {
      google,
      check: fakeGateway(payloads),
      sync: synced,
    });
    expect(payloads).toEqual(["{}"]);
    expect(await get()).toBeNull();
    expect(r.ok && r.checks.map((c) => [c.id, c.ok])).toEqual([
      ["iap-sync", true],
      ["gateway-client", true],
    ]);
  });
});

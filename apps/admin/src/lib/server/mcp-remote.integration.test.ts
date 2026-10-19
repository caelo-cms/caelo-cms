// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — `/api/mcp/remote/{chat,admin}` against a real Postgres,
 * driven by the MCP SDK's own Streamable HTTP client (its fetch routed into
 * the route handlers): initialize + tools/list per surface, every auth
 * refusal (HTTP status + structured body), sticky revocation, the admin
 * surface's permission gate, and the stateless work session persisted on
 * the connection row across requests. IAP assertions are signed with
 * generated ES256 keys through the verifier's test seam.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  configureMcpBridge,
  createIapVerifier,
  iapTestKeyPairForTests,
  setIapVerifierForTests,
  signIapTestAssertionForTests,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SQL } from "bun";
import * as adminRoute from "../../routes/api/mcp/remote/admin/+server.js";
import * as chatRoute from "../../routes/api/mcp/remote/chat/+server.js";
import { getQueryContext } from "./query.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const AUDIENCE = "/projects/42/global/backendServices/806";
const KEY = iapTestKeyPairForTests("t806-route");
let audience: string | undefined = AUDIENCE;

const OWNER = { id: "00000000-0000-4000-8806-0000000000a1", email: "owner@t806-route.test" };
const EDITOR = { id: "00000000-0000-4000-8806-0000000000a2", email: "editor@t806-route.test" };

const ownerCtx: ExecutionContext = {
  actorId: OWNER.id,
  actorKind: "human",
  requestId: "t806-route-owner",
};

type Surface = "chat" | "admin";
const routes = { chat: chatRoute, admin: adminRoute } as const;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx);
    });
  } finally {
    await sql.end();
  }
}

function assertion(email: string): string {
  return signIapTestAssertionForTests(KEY, { aud: AUDIENCE, email });
}

/** Call a route handler the way SvelteKit would (only `request` is used). */
async function callRoute(surface: Surface, request: Request): Promise<Response> {
  const route = routes[surface] as unknown as Record<
    string,
    (event: { request: Request }) => Promise<Response>
  >;
  const handler = route[request.method];
  if (!handler) return new Response(null, { status: 405 });
  return handler({ request });
}

/** An SDK client whose HTTP requests go straight into the route handler. */
async function connect(surface: Surface, email: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://admin.test/api/mcp/remote/${surface}`),
    {
      requestInit: { headers: { "x-goog-iap-jwt-assertion": assertion(email) } },
      fetch: (url, init) => callRoute(surface, new Request(url, init)),
    },
  );
  const client = new Client({ name: "t806-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function initializeRequest(headers: Record<string, string>): Request {
  return new Request("http://admin.test/api/mcp/remote/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t806-raw", version: "1" },
      },
    }),
  });
}

async function refusal(surface: Surface, headers: Record<string, string>) {
  const res = await callRoute(surface, initializeRequest(headers));
  return { status: res.status, body: (await res.json()) as { error: string; message: string } };
}

function text(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map((c) => c.text ?? "").join("\n");
}

beforeAll(async () => {
  await withSql(async (tx) => {
    for (const [u, role] of [
      [OWNER, "owner"],
      [EDITOR, "editor"],
    ] as const) {
      await tx`INSERT INTO actors (id, kind, display_name)
               VALUES (${u.id}::uuid, 'human', ${u.email}) ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO users (id, email, password_hash)
               VALUES (${u.id}::uuid, ${u.email}, 'test-only') ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO user_roles (user_id, role_id)
               SELECT ${u.id}::uuid, id FROM roles WHERE name = ${role} ON CONFLICT DO NOTHING`;
      await tx`DELETE FROM mcp_remote_connections WHERE actor_id = ${u.id}::uuid`;
    }
  });
  setIapVerifierForTests(
    createIapVerifier({
      audience: () => audience,
      keys: async () => ({ [KEY.kid]: KEY.publicPem }),
    }),
  );
  const { adapter, registry } = getQueryContext();
  // No AI provider: nothing below runs Caelo's own AI.
  configureMcpBridge({ adapter, registry, resolveProvider: async () => null });
});

afterAll(async () => {
  setIapVerifierForTests(null);
  await withSql(async (tx) => {
    for (const u of [OWNER, EDITOR]) {
      await tx`DELETE FROM mcp_remote_connections WHERE actor_id = ${u.id}::uuid`;
    }
  });
});

describe("remote MCP: initialize + tools/list", () => {
  it("chat surface serves the stdio chat tools, the chat instructions and the remote upload tool", async () => {
    const client = await connect("chat", EDITOR.email);
    expect(client.getInstructions()).toContain("caelo_chat");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "caelo_await_approval",
      "caelo_chat",
      "caelo_upload_images",
    ]);
    const upload = tools.find((t) => t.name === "caelo_upload_images");
    expect(upload?.description).toContain("filePath is refused");
    await client.close();
  });

  it("admin surface serves the companion tools plus the live Power-MCP catalogue", async () => {
    const client = await connect("admin", OWNER.email);
    expect(client.getInstructions()).toContain("caelo_open_session");
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const name of [
      "caelo_open_session",
      "caelo_get_context",
      "caelo_await_approval",
      "caelo_upload_images",
      "list_pages",
    ]) {
      expect(names.has(name)).toBe(true);
    }
    expect(names.has("spawn_subagents")).toBe(false);
    await client.close();
  });

  it("records the client's name on the connection", async () => {
    const r = await execute(
      getQueryContext().registry,
      getQueryContext().adapter,
      ownerCtx,
      "mcp_remote_connections.list",
      {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = (
      r.value as { connections: { email: string; surface: string; clientLabel: string }[] }
    ).connections;
    expect(rows.find((c) => c.email === OWNER.email && c.surface === "admin")?.clientLabel).toBe(
      "t806-client",
    );
  });
});

describe("remote MCP: refusals", () => {
  it("401 without an IAP assertion, 401 for a forged one", async () => {
    expect(await refusal("chat", {})).toMatchObject({
      status: 401,
      body: { error: "missing_iap_assertion" },
    });
    const forged = signIapTestAssertionForTests(iapTestKeyPairForTests(KEY.kid), {
      aud: AUDIENCE,
      email: OWNER.email,
    });
    expect(await refusal("admin", { "x-goog-iap-jwt-assertion": forged })).toMatchObject({
      status: 401,
      body: { error: "invalid_iap_assertion" },
    });
  });

  it("403 not_a_caelo_user for a Google account without a Caelo user", async () => {
    const r = await refusal("chat", {
      "x-goog-iap-jwt-assertion": assertion("stranger@t806.test"),
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_a_caelo_user");
    expect(r.body.message).toContain("Settings → Users");
  });

  it("503 remote_mcp_not_configured while CAELO_IAP_AUDIENCE is unset", async () => {
    audience = undefined;
    try {
      expect(
        await refusal("chat", { "x-goog-iap-jwt-assertion": assertion(OWNER.email) }),
      ).toMatchObject({ status: 503, body: { error: "remote_mcp_not_configured" } });
    } finally {
      audience = AUDIENCE;
    }
  });

  it("refuses the admin surface to a user without settings.write", async () => {
    const r = await refusal("admin", { "x-goog-iap-jwt-assertion": assertion(EDITOR.email) });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("permission_denied");
    expect(r.body.message).toContain("settings.write");
  });

  it("refuses a revoked connection, sticky across requests, until restored", async () => {
    const { adapter, registry } = getQueryContext();
    const listed = await execute(registry, adapter, ownerCtx, "mcp_remote_connections.list", {});
    if (!listed.ok) throw new Error("list failed");
    const row = (
      listed.value as { connections: { id: string; email: string; surface: string }[] }
    ).connections.find((c) => c.email === EDITOR.email && c.surface === "chat");
    expect(row).toBeDefined();
    await execute(registry, adapter, ownerCtx, "mcp_remote_connections.revoke", { id: row!.id });
    for (let i = 0; i < 2; i++) {
      const r = await refusal("chat", { "x-goog-iap-jwt-assertion": assertion(EDITOR.email) });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("remote_access_revoked");
      expect(r.body.message).toContain("revoked under Settings → MCP");
    }
    await execute(registry, adapter, ownerCtx, "mcp_remote_connections.restore", { id: row!.id });
    const client = await connect("chat", EDITOR.email);
    await client.close();
  });

  it("authenticates before reporting a malformed body", async () => {
    const malformed = (headers: Record<string, string>) =>
      callRoute(
        "chat",
        new Request("http://admin.test/api/mcp/remote/chat", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: "{not json",
        }),
      );
    expect((await malformed({})).status).toBe(401);
    expect((await malformed({ "x-goog-iap-jwt-assertion": assertion(EDITOR.email) })).status).toBe(
      400,
    );
  });

  it("answers GET (no server-initiated stream on a stateless server) with 405", async () => {
    const res = await callRoute(
      "chat",
      new Request("http://admin.test/api/mcp/remote/chat", {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "x-goog-iap-jwt-assertion": assertion(EDITOR.email),
        },
      }),
    );
    expect(res.status).toBe(405);
  });
});

describe("remote MCP: stateless work session", () => {
  it("caelo_open_session persists current_chat_session_id; a later request writes to it", async () => {
    const first = await connect("admin", OWNER.email);
    const opened = await first.callTool({
      name: "caelo_open_session",
      arguments: { newSession: true, title: "t806 route session" },
    });
    expect(opened.isError).toBeFalsy();
    const { chatSessionId } = JSON.parse(`${text(opened).split("\n}")[0]}\n}`) as {
      chatSessionId: string;
    };
    await first.close();

    const rows = await withSql(
      async (tx) =>
        (await tx`SELECT current_chat_session_id::text AS current FROM mcp_remote_connections
                  WHERE actor_id = ${OWNER.id}::uuid AND surface = 'admin'`) as {
          current: string | null;
        }[],
    );
    expect(rows[0]?.current).toBe(chatSessionId);

    // A fresh connection (any instance) continues in that session.
    const second = await connect("admin", OWNER.email);
    const listed = await second.callTool({ name: "list_pages", arguments: {} });
    expect(listed.isError).toBeFalsy();
    const runs = await withSql(
      async (tx) =>
        (await tx`SELECT count(*)::int AS n FROM chat_agent_runs
                  WHERE chat_session_id = ${chatSessionId}::uuid
                    AND mcp_remote_connection_id IS NOT NULL`) as { n: number }[],
    );
    expect(runs[0]?.n).toBe(1);
    await second.close();
  });

  it("a tool call before any session points at caelo_open_session", async () => {
    await withSql(
      (tx) =>
        tx`UPDATE mcp_remote_connections SET current_chat_session_id = NULL
           WHERE actor_id = ${OWNER.id}::uuid AND surface = 'admin'`,
    );
    const client = await connect("admin", OWNER.email);
    const r = await client.callTool({ name: "list_pages", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("caelo_open_session");
    await client.close();
  });

  it("caelo_upload_images refuses filePath remotely with a base64 hint", async () => {
    const client = await connect("chat", EDITOR.email);
    const r = await client.callTool({
      name: "caelo_upload_images",
      arguments: { images: [{ filePath: "/etc/hosts" }] },
    });
    expect(r.isError).toBe(true);
    const body = JSON.parse(text(r)) as { results: { error?: string }[] };
    expect(body.results[0]?.error).toContain("base64");
    await client.close();
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1306 — a remote MCP client that sends no `Mcp-Session-Id` (one
 * connected before 0.11.6 keeps none) looped on caelo_open_session: the
 * open succeeded but bound nothing, and the next call without
 * `workSessionId` was told "call caelo_open_session first". Now the open
 * result says the connection cannot carry the session, and the refusal
 * tells "never opened" apart from "opened, pass this id".
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import type { McpRemoteCredential } from "../ops/security/mcp_credential.js";
import { powerNoWorkSessionMessage, powerOpenSession } from "../ops/security/mcp_power.js";
import { type McpPrincipal, resolveRemoteMcpPrincipal } from "../ops/security/mcp_principal.js";
import { configureMcpBridge, type SendChatBridgeOpts } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";
import { createIapVerifier, setIapVerifierForTests } from "../security/iap-assertion.js";
import { iapTestKeyPair, signIapTestAssertion } from "../security/iap-assertion.test-helpers.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const AUDIENCE = "/projects/42/locations/europe-west1/services/caelo-admin";
const KEY = iapTestKeyPair("t1306-kid");
const OWNER = { id: "00000000-0000-4000-8130-600000000001", email: "owner@t1306.test" };

let adapter: DatabaseAdapter;
let bridge: SendChatBridgeOpts;

/** What the remote route resolves once per request, for one client app. */
async function principal(client: string): Promise<McpPrincipal> {
  const cred: McpRemoteCredential = {
    iapCredential: signIapTestAssertion(KEY, { aud: AUDIENCE, email: OWNER.email }),
    surface: "admin",
    client,
  };
  const r = await resolveRemoteMcpPrincipal(adapter, cred);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name)
               VALUES (${OWNER.id}::uuid, 'human', ${OWNER.email}) ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO users (id, email, password_hash)
               VALUES (${OWNER.id}::uuid, ${OWNER.email}, 'test-only') ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO user_roles (user_id, role_id)
               SELECT ${OWNER.id}::uuid, id FROM roles WHERE name = 'owner' ON CONFLICT DO NOTHING`;
    });
  } finally {
    await sql.end();
  }
  setIapVerifierForTests(
    createIapVerifier({
      audience: () => AUDIENCE,
      keys: async () => ({ [KEY.kid]: KEY.publicPem }),
    }),
  );
  bridge = { adapter, registry, resolveProvider: async () => null };
  configureMcpBridge(bridge);
});

afterAll(async () => {
  setIapVerifierForTests(null);
  await adapter.close();
});

describe("#1306 — a remote connection without Mcp-Session-Id", () => {
  it("is told it never opened a session, then which session it opened and to pass it", async () => {
    const p = await principal("dcr:Old Client");
    const before = await powerNoWorkSessionMessage(bridge, p);
    expect(before).toContain("has not opened a work session");
    expect(before).toContain("workSessionId");

    const opened = await powerOpenSession(bridge, p, { title: "t1306 unbound" });
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.value.carriedByConnection).toBe(false);

    const after = await powerNoWorkSessionMessage(bridge, await principal("dcr:Old Client"));
    const id = opened.value.chatSessionId;
    expect(after).toContain(`work session ${id} was the last one opened on this connection`);
    expect(after).toContain(`If you opened ${id}, do not open another`);
    expect(after).toContain(`workSessionId: "${id}"`);
    // A connection is shared by its agents: one that opened nothing is not
    // steered into another agent's session.
    expect(after).toContain("If you did not (another agent shares this connection)");
  });

  it("names the newest open, and keeps connections apart", async () => {
    const p = await principal("dcr:Old Client");
    const second = await powerOpenSession(bridge, p, { title: "t1306 second" });
    if (!second.ok) throw new Error(second.message);
    expect(await powerNoWorkSessionMessage(bridge, p)).toContain(second.value.chatSessionId);
    // Another client app of the same person is another connection.
    expect(await powerNoWorkSessionMessage(bridge, await principal("dcr:Other"))).toContain(
      "has not opened a work session",
    );
  });

  it("does not flag a session bound to a transport session", async () => {
    const p = await principal("dcr:New Client");
    const opened = await powerOpenSession(bridge, p, {
      title: "t1306 bound",
      transportSessionId: "t1306-transport-session-0001",
    });
    if (!opened.ok) throw new Error(opened.message);
    expect(opened.value.carriedByConnection).toBeUndefined();
  });
});

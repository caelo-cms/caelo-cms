// SPDX-License-Identifier: MPL-2.0

/**
 * #806 — remote MCP is routed before the gateway's database-backed
 * pipeline: it answers without a bootstrapped adapter or published
 * settings, and is never shadowed by the plugin 404.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../server.js";
import { BASE_ENV, CONFIGURED_FILE, PUBLIC } from "./__tests__/harness.js";

const saved = Object.fromEntries(Object.keys(BASE_ENV).map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("server routing (#806)", () => {
  it("serves remote MCP with no database adapter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caelo-mcp-"));
    const file = join(dir, "client.json");
    writeFileSync(file, CONFIGURED_FILE);
    Object.assign(process.env, { ...BASE_ENV, CAELO_MCP_OAUTH_CLIENT_FILE: file });
    const meta = await handleRequest(
      new Request(`${PUBLIC}/.well-known/oauth-authorization-server/api/mcp/oauth`),
    );
    expect(meta.status).toBe(200);
    const status = await handleRequest(new Request(`${PUBLIC}/api/mcp/oauth/status`));
    expect(((await status.json()) as { configured: boolean }).configured).toBe(true);
    const chat = await handleRequest(new Request(`${PUBLIC}/api/mcp/chat`, { method: "POST" }));
    expect(chat.status).toBe(401);
  });

  it("answers the structured 503 (not the bootstrap 503) when the install lacks the env", async () => {
    for (const k of Object.keys(BASE_ENV)) delete process.env[k];
    const res = await handleRequest(new Request(`${PUBLIC}/api/mcp/chat`, { method: "POST" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("remote_mcp_not_configured");
  });
});

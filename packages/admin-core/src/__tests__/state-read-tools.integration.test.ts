// SPDX-License-Identifier: MPL-2.0

/**
 * The on-demand state endpoints (2026-07 chunk audit): every context
 * chunk that previously had NO read tool gets one via makeReadTool.
 * Real Postgres (§6). Covers:
 *   - each tool answers with ok:true against a live DB
 *   - the factory generates the JSON Schema FROM the Zod schema (no
 *     hand-written duplicate to drift)
 *   - list_ai_providers never leaks key material into content or value
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { ToolContext } from "../ai/tools/dispatch.js";
import {
  getDesignManifestTool,
  getSiteDefaultsTool,
  listAiProvidersTool,
  listDomainsTool,
  listLocalesTool,
  listPendingProposalsTool,
  listRolesTool,
  listUsersTool,
} from "../ai/tools/state-read-tools.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "state-read-tools-int",
};
const toolCtx = () => ({ adapter, registry }) as ToolContext;

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

describe("state read endpoints — every chunk has a live read", () => {
  const tools = [
    getSiteDefaultsTool,
    getDesignManifestTool,
    listLocalesTool,
    listPendingProposalsTool,
    listUsersTool,
    listRolesTool,
    listAiProvidersTool,
    listDomainsTool,
  ];

  for (const tool of tools) {
    it(`${tool.name} answers ok against the live DB`, async () => {
      const r = await tool.handler(SYSTEM, {}, toolCtx());
      expect(r.ok).toBe(true);
      expect(r.content.length).toBeGreaterThan(0);
    });
  }

  it("factory generates the wire JSON Schema from the Zod schema", () => {
    // No hand-written duplicate: strict empty object → additionalProperties false.
    const js = getSiteDefaultsTool.inputSchema as {
      type?: string;
      additionalProperties?: boolean;
    };
    expect(js.type).toBe("object");
    expect(js.additionalProperties).toBe(false);
  });

  it("list_ai_providers leaks NO key material (content or value)", async () => {
    const r = await listAiProvidersTool.handler(SYSTEM, {}, toolCtx());
    expect(r.ok).toBe(true);
    // The op's config payload can carry a plaintext apiKey — the tool
    // must render only status fields and drop the raw value entirely.
    expect((r as { value?: unknown }).value).toBeUndefined();
    expect(r.content).not.toContain("sk-ant");
    expect(r.content).not.toMatch(/apiKey["':\s]+[A-Za-z0-9_-]{12}/);
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * issue #199 — bring-your-own-design drafts on the real Postgres:
 * source_kind round-trips, byod_html is sanitised AT the boundary,
 * byod_image requires its reference asset, and plain Genesis drafts
 * are untouched (regression).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let sqlc: SQL;

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue199-byod",
};

const BODY = `<style>body{background:#101418;color:#f5f5f4;font-family:Inter,sans-serif}</style><header><h1>issue199 Studio</h1></header><main><section>${"<p>Portfolio.</p>".repeat(10)}</section></main>`;

async function cleanup(): Promise<void> {
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM genesis_drafts WHERE direction LIKE 'issue199%'`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  sqlc = new SQL(ADMIN_URL!);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await sqlc.end();
  await adapter.close();
});

describe("BYOD drafts (#199)", () => {
  it("byod_html: scripts are stripped at the boundary; sourceKind round-trips", async () => {
    const r = await execute(registry, adapter, AI, "genesis.add_draft", {
      direction: "issue199 provided html",
      rationale: "operator pasted their agency's HTML",
      html: `<html><body>${BODY}<script>trackVisitors()</script></body></html>`,
      sourceKind: "byod_html",
    });
    expect(r.ok).toBe(true);

    const list = await execute(registry, adapter, AI, "genesis.list_drafts", {
      includeHtml: true,
    });
    const drafts = (
      list.value as {
        drafts: {
          direction: string;
          sourceKind: string;
          referenceAssetId: string | null;
          html?: string;
        }[];
      }
    ).drafts;
    const mine = drafts.find((d) => d.direction === "issue199 provided html");
    expect(mine?.sourceKind).toBe("byod_html");
    expect(mine?.referenceAssetId).toBeNull();
    expect(mine?.html).not.toContain("<script");
    expect(mine?.html).not.toContain("trackVisitors");
    expect(mine?.html).toContain("issue199 Studio");
  });

  it("byod_image without referenceAssetId fails loudly — the mockup IS the contract", async () => {
    const r = await execute(registry, adapter, AI, "genesis.add_draft", {
      direction: "issue199 from mockup",
      rationale: "reproduction of the attached PNG",
      html: `<html><body>${BODY}</body></html>`,
      sourceKind: "byod_image",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(JSON.stringify(r.error)).toContain("referenceAssetId");
    }
  });

  it("plain Genesis drafts default to sourceKind 'genesis' (regression)", async () => {
    const r = await execute(registry, adapter, AI, "genesis.add_draft", {
      direction: "issue199 plain",
      rationale: "normal divergent draft",
      html: `<html><body>${BODY}</body></html>`,
    });
    expect(r.ok).toBe(true);
    const list = await execute(registry, adapter, AI, "genesis.list_drafts", {
      includeHtml: false,
    });
    const mine = (
      list.value as { drafts: { direction: string; sourceKind: string }[] }
    ).drafts.find((d) => d.direction === "issue199 plain");
    expect(mine?.sourceKind).toBe("genesis");
  });
});

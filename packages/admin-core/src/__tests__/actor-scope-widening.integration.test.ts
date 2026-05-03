// SPDX-License-Identifier: MPL-2.0

/**
 * P5 widens actorScope on `modules.update` to include "ai". Other content
 * mutations stay AI-blocked until their tools land in later phases. This
 * test pins both halves of the rule.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "p5-scope-test",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "p5-scope-test-ai",
};

const SLUG = "p5-scope-mod";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM modules WHERE slug LIKE ${`${SLUG}%`}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("P5 actor scope: modules.update widened to include AI", () => {
  it("AI can call modules.update", async () => {
    const create = await execute(registry, adapter, HUMAN, "modules.create", {
      slug: SLUG,
      displayName: "X",
      html: "<p>v1</p>",
    });
    if (!create.ok) throw new Error("seed");
    const moduleId = (create.value as { moduleId: string }).moduleId;

    const r = await execute(registry, adapter, AI, "modules.update", {
      moduleId,
      html: "<p>v2</p>",
    });
    expect(r.ok).toBe(true);
  });

  it("AI can call modules.create (P6.7.3 — drives add_module_to_page / add_module_to_template)", async () => {
    const r = await execute(registry, adapter, AI, "modules.create", {
      slug: `${SLUG}-ai-allowed`,
      displayName: "Y",
      html: "<p>x</p>",
    });
    expect(r.ok).toBe(true);
  });

  it("AI can call pages.update (P6.7.5 — drives rename_page / set_page_title / change_page_slug)", async () => {
    // Non-existent page → HandlerError(page not found), NOT
    // ActorScopeRejected. Proves the validator allows AI through.
    const r = await execute(registry, adapter, AI, "pages.update", {
      pageId: "11111111-1111-4111-8111-111111111111",
      title: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { kind: string }).kind).toBe("HandlerError");
  });
});

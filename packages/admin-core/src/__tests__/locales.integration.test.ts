// SPDX-License-Identifier: MPL-2.0

/**
 * Locale registry READ surface (epic #380 Phase A, #382). The
 * propose/execute management layer is deleted; `locales.list` /
 * `locales.get` survive until the page-identity cut (#384) because
 * pages still carry a `locale` column. The translation_status CHECK
 * test guards the surviving pages column until #384 drops it.
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

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "locales-test",
};
const aiCtx: ExecutionContext = {
  ...systemCtx,
  actorKind: "ai",
  requestId: "locales-test-ai",
};

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

describe("locale registry reads", () => {
  it("locales.list is open to the AI and returns the seeded default", async () => {
    const r = await execute(registry, adapter, aiCtx, "locales.list", {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const locales = (r.value as { locales: { code: string; isDefault: boolean }[] }).locales;
    expect(locales.find((l) => l.code === "en")?.isDefault).toBe(true);
  });

  it("locales.get returns null for an unknown code", async () => {
    const r = await execute(registry, adapter, systemCtx, "locales.get", { code: "xx" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { locale: unknown }).locale).toBeNull();
  });

  it("translation_status enum accepts spec values, rejects legacy fresh/stale", async () => {
    const sqlClient = new SQL(ADMIN_URL);
    try {
      await sqlClient.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`
          INSERT INTO pages (slug, locale, name, title, template_id, status, translation_status)
          SELECT 'enum-test', 'en', 'X', 'X',
                 (SELECT id FROM templates LIMIT 1), 'draft', 'up_to_date'
        `;
      });
      // Cleanup: delete the test row.
      await sqlClient.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`DELETE FROM pages WHERE slug = 'enum-test' AND locale = 'en'`;
      });
      // Verify the legacy value is rejected.
      let rejected = false;
      try {
        await sqlClient.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
          await tx`
            INSERT INTO pages (slug, locale, name, title, template_id, status, translation_status)
            SELECT 'enum-test-bad', 'en', 'X', 'X',
                   (SELECT id FROM templates LIMIT 1), 'draft', 'fresh'
          `;
        });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    } finally {
      await sqlClient.end();
    }
  });
});

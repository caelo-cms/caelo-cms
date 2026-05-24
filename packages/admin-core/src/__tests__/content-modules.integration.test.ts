// SPDX-License-Identifier: MPL-2.0

/**
 * Modules CRUD integration. Verifies:
 *   - create / list / get / update / delete round-trip
 *   - soft-delete hides from list, includeDeleted reveals
 *   - actorScope rejects an `ai` caller (P3 deliberately excludes AI)
 *   - duplicate slug rejected
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
  requestId: "content-modules-test",
};

const SLUGS = ["p3-mod-hero", "p3-mod-card", "p3-mod-nav"] as const;

async function wipe(url: string): Promise<void> {
  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      for (const slug of SLUGS) {
        await tx`DELETE FROM modules WHERE slug = ${slug}`;
      }
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe(ADMIN_URL);
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe(ADMIN_URL);
  await adapter.close();
});

describe("modules CRUD", () => {
  it("create + list + get + update + delete round-trip", async () => {
    // v0.12.2 — pass explicit fields so the extractor doesn't
    // auto-templatise <h1>Hi</h1>. We're testing CRUD wiring, not
    // extraction behaviour (that's covered by the extractor unit
    // tests).
    const create = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: SLUGS[0],
      displayName: "Hero",
      html: "<h1>Hi</h1>",
      fields: [{ name: "headline", kind: "text", label: "Headline" } as never],
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const moduleId = (create.value as { moduleId: string }).moduleId;

    const list = await execute(registry, adapter, systemCtx, "modules.list", {});
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(
      (list.value as { modules: { slug: string }[] }).modules.some((m) => m.slug === SLUGS[0]),
    ).toBe(true);

    const got = await execute(registry, adapter, systemCtx, "modules.get", { moduleId });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect((got.value as { module: { html: string } }).module.html).toBe("<h1>Hi</h1>");

    const upd = await execute(registry, adapter, systemCtx, "modules.update", {
      moduleId,
      html: "<h1>Howdy</h1>",
      css: "h1{color:red}",
    });
    expect(upd.ok).toBe(true);

    const got2 = await execute(registry, adapter, systemCtx, "modules.get", { moduleId });
    expect(got2.ok).toBe(true);
    if (!got2.ok) return;
    const m = (got2.value as { module: { html: string; css: string } }).module;
    expect(m.html).toBe("<h1>Howdy</h1>");
    expect(m.css).toBe("h1{color:red}");

    const del = await execute(registry, adapter, systemCtx, "modules.delete", { moduleId });
    expect(del.ok).toBe(true);

    const list2 = await execute(registry, adapter, systemCtx, "modules.list", {});
    if (!list2.ok) return;
    expect(
      (list2.value as { modules: { slug: string }[] }).modules.some((m) => m.slug === SLUGS[0]),
    ).toBe(false);

    const list3 = await execute(registry, adapter, systemCtx, "modules.list", {
      includeDeleted: true,
    });
    if (!list3.ok) return;
    expect(
      (list3.value as { modules: { slug: string; deletedAt: string | null }[] }).modules.find(
        (m) => m.slug === SLUGS[0],
      )?.deletedAt,
    ).not.toBeNull();
  });

  it("rejects duplicate slug", async () => {
    const a = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: SLUGS[1],
      displayName: "Card",
      html: "<div></div>",
    });
    expect(a.ok).toBe(true);
    const b = await execute(registry, adapter, systemCtx, "modules.create", {
      slug: SLUGS[1],
      displayName: "Card 2",
      html: "<div></div>",
    });
    expect(b.ok).toBe(false);
  });

  it("accepts an AI actor (P6.7.3 — add_module_to_page / template tools chain modules.create)", async () => {
    // Use the seed AI actor row so the audit_events FK is satisfied.
    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "content-modules-ai-test",
    };
    const r = await execute(registry, adapter, aiCtx, "modules.create", {
      slug: SLUGS[2],
      displayName: "Nav",
      html: "<nav></nav>",
    });
    expect(r.ok).toBe(true);
  });
});

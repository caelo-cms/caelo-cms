// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — slug-change link rewriter integration. After change_page_slug
 * (via direct pages.update + pages.rewrite_module_links), every
 * matching <a href="/<oldSlug>..."> in module HTML round-trips to the
 * new slug. Bound to the leading "/" so it doesn't rewrite suffix
 * matches.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo/query-api";
import type { ExecutionContext } from "@caelo/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "slug-rewrite-test",
};

const TS = Date.now();
const MOD_SLUG_REF = `p8-slug-ref-${TS}`;
const MOD_SLUG_NOREF = `p8-slug-noref-${TS}`;
const MOD_SLUG_SUFFIX = `p8-slug-suffix-${TS}`;
const OLD_SLUG = `p8-old-${TS}`;
const NEW_SLUG = `p8-new-${TS}`;

let modIdRef = "";
let modIdNoRef = "";
let modIdSuffix = "";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM modules WHERE slug IN (${MOD_SLUG_REF}, ${MOD_SLUG_NOREF}, ${MOD_SLUG_SUFFIX})`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  // Module 1: contains an <a href> pointing at the old slug (root).
  const m1 = await execute(registry, adapter, systemCtx, "modules.create", {
    slug: MOD_SLUG_REF,
    displayName: "Ref module",
    html: `<p>See <a href="/${OLD_SLUG}">our page</a>.</p>`,
  });
  if (!m1.ok) throw new Error("seed m1");
  modIdRef = (m1.value as { moduleId: string }).moduleId;
  // Module 2: no reference to the slug.
  const m2 = await execute(registry, adapter, systemCtx, "modules.create", {
    slug: MOD_SLUG_NOREF,
    displayName: "Unrelated module",
    html: `<p>Hi there.</p>`,
  });
  if (!m2.ok) throw new Error("seed m2");
  modIdNoRef = (m2.value as { moduleId: string }).moduleId;
  // Module 3: text mention of the slug WITHOUT a leading "/" — must
  // NOT be rewritten.
  const m3 = await execute(registry, adapter, systemCtx, "modules.create", {
    slug: MOD_SLUG_SUFFIX,
    displayName: "Suffix mention module",
    html: `<p>Visit /not-${OLD_SLUG} for details.</p>`,
  });
  if (!m3.ok) throw new Error("seed m3");
  modIdSuffix = (m3.value as { moduleId: string }).moduleId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("P8 slug-change link rewriter", () => {
  it("lookup_links_in_modules surfaces only modules with leading-slash hrefs", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.lookup_links_in_modules", {
      oldSlug: OLD_SLUG,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = (r.value as { modules: { id: string }[] }).modules.map((m) => m.id);
    expect(ids).toContain(modIdRef);
    expect(ids).not.toContain(modIdNoRef);
    // Module 3 has /not-<oldSlug> which the LIKE pre-filter doesn't
    // catch (no leading "/<oldSlug>" prefix in any of the four needles),
    // so it's not surfaced. Defence-in-depth: even if it WERE matched,
    // the regex bound to `/<oldSlug>(["'/])` would skip it.
    expect(ids).not.toContain(modIdSuffix);
  });

  it("rewrite_module_links flips matching hrefs and audits the touched module ids", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.rewrite_module_links", {
      oldSlug: OLD_SLUG,
      newSlug: NEW_SLUG,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rewritten = (r.value as { rewrittenModuleIds: string[] }).rewrittenModuleIds;
    expect(rewritten).toContain(modIdRef);
    expect(rewritten).not.toContain(modIdNoRef);
    expect(rewritten).not.toContain(modIdSuffix);
    // Verify the module HTML actually changed.
    const get = await execute(registry, adapter, systemCtx, "modules.get", { moduleId: modIdRef });
    if (!get.ok) return;
    const html = (get.value as { module: { html: string } }).module.html;
    expect(html).toContain(`href="/${NEW_SLUG}"`);
    expect(html).not.toContain(`href="/${OLD_SLUG}"`);
  });

  it("is a no-op when oldSlug === newSlug", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.rewrite_module_links", {
      oldSlug: NEW_SLUG,
      newSlug: NEW_SLUG,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.value as { rewrittenModuleIds: string[] }).rewrittenModuleIds.length).toBe(0);
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — SEO sidecar integration:
 *  - autofill is fill-once (second call returns AlreadyAutofilled)
 *  - optimize is always allowed and bumps optimized_at
 *  - set patches discrete fields without bumping fingerprints
 *  - list_stale surfaces unfilled / never-optimized pages
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

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "seo-test",
};

const TS = Date.now();
const PAGE_SLUG = `p8-seo-${TS}`;

let pageId = "";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
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
  // Seed a draft page (uses site_defaults resolver for layout/template).
  const r = await execute(registry, adapter, systemCtx, "pages.create", {
    slug: PAGE_SLUG,
    title: "P8 SEO test page",
  });
  if (!r.ok) throw new Error("seed page failed");
  pageId = (r.value as { pageId: string }).pageId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("P8 pages_seo", () => {
  it("autofill writes fields and stamps autofilled_at", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages_seo.autofill", {
      pageId,
      metaDescription: "First-fill description.",
    });
    expect(r.ok).toBe(true);
    const get = await execute(registry, adapter, systemCtx, "pages_seo.get", { pageId });
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    const seo = (
      get.value as { seo: { metaDescription: string; autofilledAt: string | null } | null }
    ).seo;
    expect(seo?.metaDescription).toBe("First-fill description.");
    expect(seo?.autofilledAt).not.toBeNull();
  });

  it("autofill refuses on already-filled rows", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages_seo.autofill", {
      pageId,
      metaDescription: "Should not overwrite.",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const message =
      typeof r.error === "object" && r.error && "message" in r.error
        ? String((r.error as { message: unknown }).message)
        : "";
    expect(message).toContain("AlreadyAutofilled");
    const get = await execute(registry, adapter, systemCtx, "pages_seo.get", { pageId });
    if (!get.ok) return;
    expect((get.value as { seo: { metaDescription: string } }).seo.metaDescription).toBe(
      "First-fill description.",
    );
  });

  it("optimize always succeeds and bumps optimized_at", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages_seo.optimize", {
      pageId,
      metaDescription: "Optimized description.",
      context: "we just rebranded from X to Y",
    });
    expect(r.ok).toBe(true);
    const get = await execute(registry, adapter, systemCtx, "pages_seo.get", { pageId });
    if (!get.ok) return;
    const seo = (
      get.value as { seo: { metaDescription: string; optimizedAt: string | null } | null }
    ).seo;
    expect(seo?.metaDescription).toBe("Optimized description.");
    expect(seo?.optimizedAt).not.toBeNull();
  });

  it("set patches discrete fields without touching fingerprints", async () => {
    const before = await execute(registry, adapter, systemCtx, "pages_seo.get", { pageId });
    if (!before.ok) throw new Error("before get failed");
    const beforeSeo = (
      before.value as {
        seo: { autofilledAt: string | null; optimizedAt: string | null; noindex: boolean } | null;
      }
    ).seo!;

    const r = await execute(registry, adapter, systemCtx, "pages_seo.set", {
      pageId,
      noindex: true,
      changefreq: "daily",
    });
    expect(r.ok).toBe(true);

    const after = await execute(registry, adapter, systemCtx, "pages_seo.get", { pageId });
    if (!after.ok) return;
    const afterSeo = (
      after.value as {
        seo: {
          noindex: boolean;
          changefreq: string;
          autofilledAt: string | null;
          optimizedAt: string | null;
        };
      }
    ).seo;
    expect(afterSeo.noindex).toBe(true);
    expect(afterSeo.changefreq).toBe("daily");
    // Fingerprints from previous tests stay untouched.
    expect(afterSeo.autofilledAt).toBe(beforeSeo.autofilledAt);
    expect(afterSeo.optimizedAt).toBe(beforeSeo.optimizedAt);
  });
});

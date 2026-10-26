// SPDX-License-Identifier: MPL-2.0

/**
 * CLAUDE.md §2 SEO fill-once, enforced at the build. On searchviu.com
 * migrated pages went live with empty meta descriptions: no flow told the
 * AI to write them, and nothing checked. Pinned here:
 *
 *   - a staging or production build refuses while a published page of
 *     main has no meta description (no pages_seo row, or a blank one);
 *     drafts, deleted pages and chat-branch pages do not count;
 *   - the refusal names each page (title, path, id) and the fix
 *     (autofill_page_seo_many), and is recorded as a
 *     failed run;
 *   - a page whose description was cleared after its first autofill is
 *     flagged as such and pointed at set_page_seo_many (autofill refuses it);
 *   - pages_seo.autofill_many fills all pages in one transaction, rejects
 *     whitespace-only descriptions, and writes nothing when one page was
 *     already autofilled;
 *   - once every page has a description the gate lets the build through.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "seo-build-gate",
};

const PFX = "seo-gate";
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId: string;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
    // Other suites' leftovers must not decide this gate.
    await tx`UPDATE pages SET status = 'draft' WHERE slug NOT LIKE ${`${PFX}%`}`;
  });
}

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function createPage(slug: string, title: string, status: "draft" | "published") {
  const r = await op<{ pageId: string }>("pages.create", { slug, title, templateId, status });
  return r.pageId;
}

async function trigger(targetName: string): Promise<{ ok: boolean; message: string }> {
  const r = await execute(registry, adapter, SYS, "deploy.trigger", { targetName });
  if (r.ok) return { ok: true, message: "" };
  return { ok: false, message: (r.error as { message?: string }).message ?? r.error.kind };
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  const t = await op<{ templateId: string }>("templates.create", {
    slug: `${PFX}-tpl`,
    displayName: "SEO gate",
    html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  templateId = t.templateId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("SEO build gate", () => {
  let missingRow: string;
  let blank: string;
  let draft: string;
  let cleared: string;

  it("refuses a staging build while published pages have no meta description", async () => {
    missingRow = await createPage(`${PFX}-missing`, "Pricing", "published");
    blank = await createPage(`${PFX}-blank`, "About", "published");
    draft = await createPage(`${PFX}-draft`, "Draft", "draft");
    await op("pages_seo.set", { pageId: blank, metaDescription: "   " });

    const r = await trigger("staging");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("2 page(s) would go live without a meta description");
    expect(r.message).toContain(`'Pricing' (/${PFX}-missing, pageId ${missingRow})`);
    expect(r.message).toContain(`pageId ${blank}`);
    expect(r.message).not.toContain(draft);
    expect(r.message).toContain("autofill_page_seo_many");
    expect(r.message).toContain("one call for all of them");

    const runs = await withSql(
      (tx) =>
        tx`SELECT r.status, r.error_message FROM deploy_runs r
           JOIN deploy_targets t ON t.id = r.target_id
           WHERE t.name = 'staging' ORDER BY r.started_at DESC LIMIT 1` as unknown as Promise<
          { status: string; error_message: string }[]
        >,
    );
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error_message).toContain("Blocked, missing SEO");
  });

  it("refuses a production build the same way, before the quality gate", async () => {
    const r = await trigger("production");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("would go live without a meta description");
  });

  it("rejects whitespace-only autofill descriptions", async () => {
    const r = await execute(registry, adapter, SYS, "pages_seo.autofill_many", {
      items: [{ pageId: missingRow, metaDescription: "  " }],
    });
    expect(r.ok).toBe(false);
  });

  it("writes nothing when one page of the batch was already autofilled", async () => {
    cleared = await createPage(`${PFX}-cleared`, "Cleared", "published");
    await op("pages_seo.autofill", { pageId: cleared, metaDescription: "First fill." });
    const r = await execute(registry, adapter, SYS, "pages_seo.autofill_many", {
      items: [
        { pageId: missingRow, metaDescription: "Plans and prices." },
        { pageId: cleared, metaDescription: "Second fill." },
      ],
    });
    expect(r.ok).toBe(false);
    const seo = await op<{ seo: { metaDescription: string } | null }>("pages_seo.get", {
      pageId: missingRow,
    });
    expect(seo.seo?.metaDescription ?? "").toBe("");
  });

  it("names an already-autofilled page whose description was cleared, with set_page_seo_many", async () => {
    await op("pages_seo.set", { pageId: cleared, metaDescription: "" });
    const r = await trigger("staging");
    expect(r.ok).toBe(false);
    expect(r.message).toContain(`pageId ${cleared}, already autofilled`);
    expect(r.message).toContain("set_page_seo_many");
  });

  it("lets the build through once every published page has a description", async () => {
    const tools = createDefaultToolRegistry();
    const filled = await tools.dispatch(
      "autofill_page_seo_many",
      {
        items: [
          { pageId: missingRow, metaDescription: "Plans and prices for every team size." },
          { pageId: blank, metaDescription: "Who we are and what we build." },
        ],
      },
      SYS,
      { registry, adapter },
    );
    expect(filled.ok).toBe(true);
    await op("pages_seo.set", { pageId: cleared, metaDescription: "Restored by hand." });

    const r = await trigger("staging");
    // Past the SEO gate; whatever this stack does next (no deploy bridge
    // is configured in this suite) is not about meta descriptions.
    expect(r.message).not.toContain("meta description");
  });
});

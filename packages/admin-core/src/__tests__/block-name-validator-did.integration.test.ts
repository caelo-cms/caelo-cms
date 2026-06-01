// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (step-09 optimization #5) — AC #1 defense-in-depth.
 *
 * AC #1 promises the generation-time blockName enum is backed by an op-layer
 * check: "the Validator still rejects an out-of-set block as defense-in-depth"
 * (the enum constrains the provider, but enum adherence isn't guaranteed
 * across providers — CLAUDE.md §2 no-fallbacks keeps the loud op-level check).
 * That check (pages.set_modules verifying every blockName exists on the
 * template) had only incidental coverage. This pins it explicitly so a future
 * refactor can't delete the op-level check on the assumption the enum
 * suffices. The check is actor-agnostic — it fires regardless of whether the
 * AI honoured the enum.
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

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue106-block-did",
};

const PFX = "issue106-block-did";
const TPL_SLUG = `${PFX}-tpl`;
const MOD_SLUG = `${PFX}-mod`;
const PAGE_SLUG = `${PFX}-page`;

let pageId: string;
let moduleId: string;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
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

  const tpl = await execute(registry, adapter, SYS, "templates.create", {
    slug: TPL_SLUG,
    displayName: "Block DiD T",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  if (!tpl.ok) throw new Error("tpl seed");
  const templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const mod = await execute(registry, adapter, SYS, "modules.create", {
    slug: MOD_SLUG,
    displayName: "Block DiD Module",
    html: "<p>x</p>",
    css: "",
    js: "",
  });
  if (!mod.ok) throw new Error("mod seed");
  moduleId = (mod.value as { moduleId: string }).moduleId;
  const pg = await execute(registry, adapter, SYS, "pages.create", {
    slug: PAGE_SLUG,
    title: "Block DiD P",
    templateId,
  });
  if (!pg.ok) throw new Error("page seed");
  pageId = (pg.value as { pageId: string }).pageId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("pages.set_modules rejects out-of-template blockName (AC #1 defense-in-depth, #106 opt 5)", () => {
  it("rejects a block not on the template even with a valid moduleId", async () => {
    const r = await execute(registry, adapter, SYS, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "hero", moduleIds: [moduleId] }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("HandlerError");
    expect((r.error as { message: string }).message).toContain("unknown block names");
    expect((r.error as { message: string }).message).toContain("hero");
  });

  it("accepts the real template block (proves the check is specific, not blanket)", async () => {
    const r = await execute(registry, adapter, SYS, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    expect(r.ok).toBe(true);
  });
});

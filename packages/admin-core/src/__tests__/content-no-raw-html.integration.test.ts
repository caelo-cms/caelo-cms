// SPDX-License-Identifier: MPL-2.0

/**
 * §3.1 invariant under regression test: pages.create / pages.update reject any
 * payload carrying an `html` key. The Validator (Zod `.strict()`) refuses
 * before the handler runs, so this is enforced at the Query API boundary, not
 * just by the lack of an `html` column.
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
  requestId: "content-noraw-test",
};

const TPL_SLUG = "p3-noraw-tpl";
const PAGE_SLUG = "p3-noraw-page";

async function wipe(url: string): Promise<void> {
  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

let templateId = "";
let pageId = "";

beforeAll(async () => {
  await wipe(ADMIN_URL);
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "T",
    html: "<body></body>",
  });
  if (!tpl.ok) throw new Error("seed failed");
  templateId = (tpl.value as { templateId: string }).templateId;

  const pg = await execute(registry, adapter, systemCtx, "pages.create", {
    slug: PAGE_SLUG,
    title: "P",
    templateId,
  });
  if (!pg.ok) throw new Error("page seed failed");
  pageId = (pg.value as { pageId: string }).pageId;
});

afterAll(async () => {
  await wipe(ADMIN_URL);
  await adapter.close();
});

describe("no-raw-html invariant", () => {
  it("pages.create rejects an `html` field at the Validator", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.create", {
      slug: "should-not-create",
      title: "X",
      templateId,
      html: "<p>raw</p>",
    } as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { kind: string }).kind).toBe("ValidationFailed");
  });

  it("pages.update rejects an `html` field at the Validator", async () => {
    const r = await execute(registry, adapter, systemCtx, "pages.update", {
      pageId,
      html: "<p>also bad</p>",
    } as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { kind: string }).kind).toBe("ValidationFailed");
  });
});

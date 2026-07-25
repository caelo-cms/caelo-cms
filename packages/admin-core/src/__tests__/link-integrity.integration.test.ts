// SPDX-License-Identifier: MPL-2.0

/**
 * Internal-link integrity scan (`scanBranchInternalLinks`) — the check
 * wired into chat.publish / chat.merge_to_main. It collects every
 * internal href in the shipped pages (raw module HTML + content_instance
 * values) and flags the ones that resolve to no existing page. Runs
 * against real Postgres through the op layer to seed pages, then invokes
 * the helper inside an admin tx (the same view the publish op uses).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { scanBranchInternalLinks } from "../ops/content/link-integrity.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "link-integrity-test",
};

const TS = Date.now().toString(36);
const TPL_SLUG = `lint-tpl-${TS}`;
const TARGET_SLUG = `lint-target-${TS}`;
const LINKER_SLUG = `lint-linker-${TS}`;
let templateId = "";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`lint-%-${TS}`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`lint-%-${TS}`}`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`LINT %`})`;
      await tx`DELETE FROM modules WHERE display_name LIKE ${"LINT %"}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
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

  const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "LINT TPL",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, systemCtx, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });

  // An existing target page every valid internal link points at.
  const target = await execute(registry, adapter, systemCtx, "pages.build_page", {
    page: { slug: TARGET_SLUG, title: "LINT Target", templateId },
    modules: [
      {
        blockName: "content",
        displayName: "LINT Target Body",
        html: "<p>{{t}}</p>",
        fields: [{ name: "t", kind: "text", label: "T" }],
        content: { source: "inline", values: { t: "hi" } },
      },
    ],
  });
  if (!target.ok) throw new Error(`target seed failed: ${JSON.stringify(target.error)}`);

  // A page whose module links to BOTH the existing target (good) and a
  // page that was never built (broken) — via a hardcoded href in the
  // module HTML AND a url content value.
  const linker = await execute(registry, adapter, systemCtx, "pages.build_page", {
    page: { slug: LINKER_SLUG, title: "LINT Linker", templateId },
    modules: [
      {
        blockName: "content",
        displayName: "LINT Linker Nav",
        html: `<nav><a href="/${TARGET_SLUG}">good</a><a href="/does-not-exist">bad html link</a><a href="#top">frag</a><a href="https://example.com">ext</a></nav>`,
        fields: [{ name: "cta_href", kind: "url", label: "CTA href" }],
        content: { source: "inline", values: { cta_href: "/also-missing" } },
      },
    ],
  });
  if (!linker.ok) throw new Error(`linker seed failed: ${JSON.stringify(linker.error)}`);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("scanBranchInternalLinks", () => {
  it("flags internal links (HTML + content values) that resolve to no page, and NOT valid ones", async () => {
    const result = await adapter.withAdminTransaction(systemCtx, (tx) =>
      scanBranchInternalLinks(tx, null),
    );
    // Broken: the hardcoded /does-not-exist and the /also-missing content value.
    expect(result.brokenInternalLinks).toContain("/does-not-exist");
    expect(result.brokenInternalLinks).toContain("/also-missing");
    // Not broken: the link to the existing target page.
    expect(result.brokenInternalLinks).not.toContain(`/${TARGET_SLUG}`);
    // Fragments + absolute URLs are not internal-page links — never flagged.
    expect(result.brokenInternalLinks).not.toContain("#top");
    expect(result.brokenInternalLinks).not.toContain("https://example.com");
  });
});

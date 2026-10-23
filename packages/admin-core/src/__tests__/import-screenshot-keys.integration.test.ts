// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: `imports.get_page_screenshot_keys` (behind the AI's
 * `get_import_page_screenshot` tool) must resolve a page id given as the
 * staging `import_pages.id`, the built CMS page id (`accepted_page_id`), OR
 * — for a directly-built #278 page — a built page whose slug matches the crawled
 * `proposed_slug`. Before the fix it matched only the raw `import_pages.id`, so
 * the migrate flow surfaced a red "import page not found" for every built /
 * directly-built page the AI asked for a screenshot of.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { LocalVolumeAdapter, setMediaStorage } from "../media/storage.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let sqlc: SQL;
let mediaRoot: string;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "sskeys-sys",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "sskeys-ai",
};

const SLUG = "sskeys-home";
const TPL = "sskeys-tpl";

async function wipe(): Promise<void> {
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${SLUG})`;
    await tx`DELETE FROM import_pages WHERE proposed_slug = ${SLUG}`;
    await tx`DELETE FROM pages WHERE slug = ${SLUG}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL})`;
    await tx`DELETE FROM templates WHERE slug = ${TPL}`;
  });
}

/** A template with the one `content` block the crawled page fills. */
async function seedContentTemplate(): Promise<string> {
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: TPL,
    displayName: "Import test template",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(`templates.create: ${JSON.stringify(tpl.error)}`);
  const templateId = (tpl.value as { templateId: string }).templateId;
  const blocks = await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  if (!blocks.ok) throw new Error(`template_blocks.set: ${JSON.stringify(blocks.error)}`);
  return templateId;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  sqlc = new SQL(ADMIN_URL);
  mediaRoot = await mkdtemp(join(tmpdir(), "sskeys-media-"));
  setMediaStorage(new LocalVolumeAdapter(mediaRoot));
  await wipe();
});

afterAll(async () => {
  await wipe();
  await rm(mediaRoot, { recursive: true, force: true });
  await sqlc.end();
  await adapter.close();
});

describe("imports.get_page_screenshot_keys — id resolution (#278)", () => {
  it("resolves the staging id, the accepted page id, AND a slug-matched built page", async () => {
    const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
      sourceUrl: "http://127.0.0.1/sskeys?run",
      depth: 1,
      maxPages: 10,
    });
    if (!run.ok) throw new Error(JSON.stringify(run.error));
    const runId = (run.value as { runId: string }).runId;

    await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
      runId,
      pages: [
        {
          sourceUrl: "http://127.0.0.1/sskeys-home",
          proposedSlug: SLUG,
          proposedTitle: "SSKeys Home",
          proposedModules: [
            { blockName: "content", position: 0, html: "<p>x</p>", displayName: "SSKeys Content" },
          ],
          proposedThemeTokens: {},
          signature: "home",
        },
      ],
    });
    await execute(registry, adapter, SYSTEM, "imports.update_run_status", {
      runId,
      status: "ready_for_review",
      pagesSeen: 1,
      pagesExtracted: 1,
    });
    const templateId = await seedContentTemplate();
    const pending = await execute(registry, adapter, SYSTEM, "imports.list_pages", { runId });
    if (!pending.ok) throw new Error(JSON.stringify(pending.error));
    const stagingId = (pending.value as { pages: { id: string }[] }).pages[0]?.id;
    if (!stagingId) throw new Error("write_extracted_pages left no import page");
    const accepted = await execute(registry, adapter, SYSTEM, "imports.accept_page", {
      importPageId: stagingId,
      templateId,
    });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));

    let importPageId = "";
    let builtPageId = "";
    await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        SELECT id::text AS id, accepted_page_id::text AS pid
        FROM import_pages WHERE proposed_slug = ${SLUG} LIMIT 1
      `) as unknown as { id: string; pid: string | null }[];
      importPageId = rows[0]?.id ?? "";
      builtPageId = rows[0]?.pid ?? "";
    });
    expect(importPageId).not.toBe("");
    expect(builtPageId).not.toBe("");

    const call = (id: string) =>
      execute(registry, adapter, AI, "imports.get_page_screenshot_keys", { importPageId: id });

    // Staging id (always worked) + accepted CMS page id (failed before the fix).
    expect((await call(importPageId)).ok).toBe(true);
    expect((await call(builtPageId)).ok).toBe(true);
    // A bogus id still fails loudly.
    expect((await call("00000000-0000-0000-0000-0000000000aa")).ok).toBe(false);

    // #278 direct-build: drop the accepted_page_id link so resolution must fall
    // through to matching the built page's slug against proposed_slug.
    await sqlc.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE import_pages SET accepted_page_id = NULL WHERE proposed_slug = ${SLUG}`;
    });
    expect((await call(builtPageId)).ok).toBe(true);
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * #1748 — a core value that changes the markup around its placeholder.
 *
 * Seen on 0.12.16 (2026-11-26): a module rendered the site texts into an
 * inert `<template data-tool-tx>{{#ui_texts}}{{key}}={{text}}\n{{/ui_texts}}</template>`
 * for a tool's script. One text read `Die Datei sollte direkt mit <?xml
 * beginnen.`; the browser parsed `<?xml` as a bogus comment that swallowed
 * the rest of the template, its `</template>` and the page footer. No write
 * tool and no Stage check said so.
 *
 * Maintainer decision 2026-11-27, end to end (real Postgres, real
 * generator): rendering and existing content stay as they are, and a value
 * that breaks the structure is refused —
 * - at write: a list entry, a content instance value and a module HTML
 *   change that would put a stored value where it breaks, each with the
 *   field, the spelling and what to write instead;
 * - at Stage: a value stored before the rule renders as written, the
 *   Stage records it as `value-breaks-markup`, the audit names the repair
 *   and Publish live refuses the build.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { pageOutputPath } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { ToolRegistry } from "../ai/tools/dispatch.js";
import { inspectPageRenderTool } from "../ai/tools/inspect-page-render.js";
import { setDeployBridge } from "../ops/deploy.js";
import { claimedRenderSources } from "../quality/audit-job.js";
import type { ClaimedAuditRun } from "../quality/audit-run.js";
import { createRenderCheck } from "../quality/checks/render.js";
import { registerAdminOps } from "../register.js";
import { stageChatSessions } from "../stage/stage-chats.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1748",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "t1748-ai",
};
const OWNER_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t1748-owner" };
const PFX = "t1748";
const LIST_SLUG = `${PFX}-ui-texts`;

/** The #1748 module: the site texts in an inert template for a tool's script, a footer after them. */
const TOOL_HTML =
  '<section class="tool"><h2>{{titel}}</h2>' +
  "<template data-tool-tx>{{#ui_texts}}{{key}}={{text}}\n{{/ui_texts}}</template>" +
  "<footer>Fußzeile</footer></section>";

const XML_ID = "00000000-0000-4000-9000-000000001748";
const OK_ID = "00000000-0000-4000-9000-000000001749";
const XML_TEXT = "Die Datei sollte direkt mit <?xml beginnen.";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prevSkipServeCheck: string | undefined;
let prevOutputRoot: string | undefined;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;
let pageId = "";
let moduleId = "";
let instanceId = "";
let listId = "";

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  await sqlSystem(async (tx) => {
    await tx.unsafe("DELETE FROM quality_audit_runs");
    await tx.unsafe("DELETE FROM deploy_runs");
    await tx.unsafe(`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages)`);
    await tx.unsafe(`DELETE FROM page_modules`);
    await tx.unsafe(`DELETE FROM pages`);
    await tx.unsafe(`DELETE FROM content_instances`);
    await tx.unsafe(`DELETE FROM modules WHERE slug LIKE '%${PFX}%'`);
    await tx.unsafe(`DELETE FROM lists WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${PFX}-%'`);
  });
}

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** A write the rule refuses: its error, with the details it is patched by. */
async function refusedWrite(
  name: string,
  args: unknown,
): Promise<{ message: string; refusal?: boolean; errors?: { path: unknown[] }[] }> {
  const r = await execute(registry, adapter, SYS, name, args);
  if (r.ok) throw new Error(`${name} was not refused`);
  return r.error as { message: string; refusal?: boolean; errors?: { path: unknown[] }[] };
}

async function openChat(title: string): Promise<string> {
  const chat = await execute(registry, adapter, OWNER, "chat.create_session", { title });
  if (!chat.ok) throw new Error(JSON.stringify(chat.error));
  return (chat.value as { chatSessionId: string }).chatSessionId;
}

async function stage(title: string) {
  const staged = await stageChatSessions({ registry, adapter }, OWNER, [await openChat(title)]);
  if (!staged.ok) throw new Error(staged.error.message);
  return staged.value;
}

/** A page of the staged build, as staging serves it. */
async function stagedHtml(runId: string, id: string): Promise<string> {
  const rows = await sqlSystem(
    async (tx) =>
      (await tx`SELECT (SELECT out_dir FROM deploy_targets WHERE name = 'staging') AS out_dir,
                       current_path FROM pages WHERE id = ${id}::uuid`) as {
        out_dir: string;
        current_path: string;
      }[],
  );
  const row = rows[0];
  if (!row) throw new Error(`no page ${id}`);
  return readFile(
    join(testRoot, row.out_dir, "builds", runId, pageOutputPath(row.current_path)),
    "utf8",
  );
}

/** The render check's findings on the audit a Stage queued. */
async function renderFindings(runId: string) {
  const queued = await sqlSystem(
    async (tx) =>
      (await tx`SELECT id::text AS id FROM quality_audit_runs
                WHERE deploy_run_id = ${runId}::uuid AND status = 'queued'`) as { id: string }[],
  );
  const auditRunId = queued[0]?.id;
  if (!auditRunId) throw new Error("the Stage queued no audit");
  const claimed = await sysOp<{ state: string; run: ClaimedAuditRun | null }>(
    "quality_audits.claim",
    { auditRunId },
  );
  expect(claimed.state).toBe("claimed");
  const run = claimed.run as ClaimedAuditRun;
  return createRenderCheck(claimedRenderSources(run)).run({
    pages: run.checkPages.map((p) => ({
      pageId: p.pageId,
      path: p.currentPath,
      url: `https://staging.example.test${p.currentPath}`,
      html: "",
    })),
    build: {
      baseUrl: "https://staging.example.test",
      probe: async () => ({ found: true, status: 200 }),
      text: async () => null,
    },
  });
}

const entry = (id: string, key: string, text: string) => ({
  id,
  node: "text",
  values: { key, text },
});

beforeAll(async () => {
  await cleanup();
  restoreBase = await pinSiteBaseUrl(ADMIN_URL, "https://example.com");
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "de");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-t1748-"));
  prevSkipServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  prevOutputRoot = process.env.CAELO_OUTPUT_ROOT;
  process.env.CAELO_OUTPUT_ROOT = testRoot;
  await sqlSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 't1748 owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
  });

  const { layoutId } = await sysOp<{ layoutId: string }>("layouts.create", {
    slug: `${PFX}-layout`,
    displayName: "T1748 layout",
    html: '<body><caelo-slot name="content"></caelo-slot></body>',
    css: "",
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { templateId } = await sysOp<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "T1748",
    html: '<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
    css: "",
    layoutId,
  });
  await sysOp("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { lists } = await sysOp<{ lists: { id: string }[] }>("lists.upsert_many", {
    lists: [
      {
        slug: LIST_SLUG,
        name: "Tool texts",
        purpose: "The interface texts of the sitemap checker's script.",
        type: "site-texts",
        items: [entry(OK_ID, "done", "Fertig")],
      },
    ],
  });
  listId = lists[0]?.id as string;
  pageId = (
    await sysOp<{ pageId: string }>("pages.build_page", {
      // The site's root page, which a staging build needs.
      page: {
        slug: "home",
        title: "Sitemap-Checker",
        templateId,
        status: "draft",
        pageType: "home",
      },
      modules: [
        {
          blockName: "content",
          displayName: `${PFX} Sitemap-Checker`,
          description: "The sitemap checker tool with its interface texts.",
          kind: "content",
          html: TOOL_HTML,
          fields: [
            { name: "titel", kind: "text", label: "Titel" },
            {
              name: "ui_texts",
              kind: "list",
              listType: "site-texts",
              bind: "shared",
              list: `caelo:list/${listId}`,
              label: "Tool texts",
            },
          ],
          content: { source: "inline", values: { titel: "Sitemap prüfen" } },
        },
      ],
    })
  ).pageId;
  const placed = await sqlSystem(
    async (tx) =>
      (await tx`SELECT module_id::text AS module_id, content_instance_id::text AS ci
                  FROM page_modules WHERE page_id = ${pageId}::uuid`) as {
        module_id: string;
        ci: string;
      }[],
  );
  moduleId = placed[0]?.module_id as string;
  instanceId = placed[0]?.ci as string;
  await sysOp("pages.set_status", { pageId, status: "published" });
  await sysOp("pages_seo.autofill", { pageId, metaDescription: "A test page." });
}, 60_000);

afterAll(async () => {
  if (prevSkipServeCheck === undefined) delete process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  else process.env.CAELO_SKIP_STAGING_SERVE_CHECK = prevSkipServeCheck;
  if (prevOutputRoot === undefined) delete process.env.CAELO_OUTPUT_ROOT;
  else process.env.CAELO_OUTPUT_ROOT = prevOutputRoot;
  await cleanup();
  await restoreBase?.();
  await restoreLanguage?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("#1748 — the write tools refuse a value that breaks the markup where it is placed", () => {
  it("a list entry the module renders inside its <template>, with the spelling and the fix", async () => {
    const refused = await refusedWrite("lists.patch_items_many", {
      lists: [
        {
          slug: LIST_SLUG,
          patches: [{ op: "add", item: entry(XML_ID, "xml_start", XML_TEXT) }],
        },
      ],
    });
    expect(refused.refusal).toBe(true);
    expect(refused.message).toContain("<?xml");
    expect(refused.message).toContain("inside <template>");
    expect(refused.message).toContain("&lt;?xml");
    expect(refused.message).toContain("Nothing was written");
    // Nothing was stored: the list still holds its one entry.
    const list = await sysOp<{ list: { items: unknown[] } }>("lists.get", { slug: LIST_SLUG });
    expect(list.list.items).toHaveLength(1);
  });

  it("the same entry written as &lt; is stored", async () => {
    await sysOp("lists.patch_items_many", {
      lists: [
        {
          slug: LIST_SLUG,
          patches: [
            {
              op: "add",
              item: entry(XML_ID, "xml_start", "Die Datei sollte direkt mit &lt;?xml beginnen."),
            },
          ],
        },
      ],
    });
  });

  it("upsert_many names each breaking entry by its path", async () => {
    const refused = await refusedWrite("lists.upsert_many", {
      lists: [
        {
          slug: LIST_SLUG,
          name: "Tool texts",
          purpose: "The interface texts of the sitemap checker's script.",
          type: "site-texts",
          items: [entry(OK_ID, "done", "Fertig</template>"), entry(XML_ID, "xml_start", "ok")],
        },
      ],
    });
    expect(refused.errors?.map((d) => d.path)).toEqual([
      ["lists", 0, "items", 0, "values", "text"],
    ]);
    expect(refused.message).toContain("</template>");
  });

  it("a content instance value, at its field, with what to write instead", async () => {
    // The title also sits in an attribute: a quote would end it there.
    await sysOp("modules.update", {
      moduleId,
      html: TOOL_HTML.replace("<h2>{{titel}}</h2>", '<h2 title="{{titel}}">{{titel}}</h2>'),
    });
    const refused = await refusedWrite("content_instances.set_values", {
      id: instanceId,
      values: { titel: 'Die "Sitemap" prüfen' },
    });
    expect(refused.refusal).toBe(true);
    expect(refused.errors?.map((d) => d.path)).toEqual([["values", "titel"]]);
    expect(refused.message).toContain("&quot;");
    // A value that keeps the markup is stored, entities and inline markup included.
    await sysOp("content_instances.set_values", {
      id: instanceId,
      values: { titel: "Die &bdquo;Sitemap&ldquo; prüfen" },
    });
  });

  it("a module HTML change that puts a stored list entry where it breaks", async () => {
    await sysOp("lists.patch_items_many", {
      lists: [
        {
          slug: LIST_SLUG,
          patches: [{ op: "update", itemId: OK_ID, values: { text: 'Klicken Sie auf "Prüfen"' } }],
        },
      ],
    });
    const refused = await refusedWrite("modules.update", {
      moduleId,
      html: TOOL_HTML.replace("{{key}}={{text}}\n", '<i data-t="{{text}}">{{key}}</i>'),
    });
    expect(refused.refusal).toBe(true);
    expect(refused.message).toContain(`the shared list "${LIST_SLUG}"`);
    expect(refused.message).toContain("nothing was saved");
  });
});

describe("#1748 — a breaking value stored before the rule", () => {
  let runId = "";

  beforeAll(async () => {
    // Stored by an older release: no write saw it.
    await sqlSystem(async (tx) => {
      const items = [entry(OK_ID, "done", "Fertig"), entry(XML_ID, "xml_start", XML_TEXT)];
      await tx`UPDATE lists SET items = (${JSON.stringify(items)}::text)::jsonb WHERE id = ${listId}::uuid`;
      await tx`UPDATE modules SET html = ${TOOL_HTML} WHERE id = ${moduleId}::uuid`;
    });
  });

  const marker = `value-breaks-markup:ui_texts[${XML_ID}].text:processing-instruction`;

  it("the editor preview renders it as before and flags it, with the repair", async () => {
    const r = await sysOp<{ html: string; missingSlots: string[] }>("pages.render_preview", {
      pageId,
    });
    expect(r.html).toContain(`xml_start=${XML_TEXT}`);
    expect(r.missingSlots).toContain(marker);
    const tools = new ToolRegistry();
    tools.register(inspectPageRenderTool);
    const inspected = await tools.dispatch("inspect_page_render", { pageId }, AI, {
      adapter,
      registry,
    });
    expect(inspected.ok).toBe(true);
    const summary = JSON.parse(inspected.content) as {
      slots: { nextSteps?: Record<string, string> };
    };
    expect(summary.slots.nextSteps?.[marker]).toContain("patch_list_items_many");
    expect(summary.slots.nextSteps?.[marker]).toContain("&lt;");
  }, 60_000);

  it("the Stage ships it as the preview shows it, records it and names the repair", async () => {
    const staged = await stage("t1748 xml");
    runId = staged.runId;
    const report = staged.renderReport;
    expect(report?.total).toBe(1);
    expect(report?.failures.map((f) => f.reason)).toEqual([marker]);
    expect(report?.operatorText).toContain("A text contains markup that breaks the page");
    expect(report?.operatorText).not.toContain("value-breaks-markup");
    expect(report?.aiText).toContain(marker);
    expect(report?.aiText).toContain("patch_list_items_many");
    expect(await stagedHtml(runId, pageId)).toContain(`xml_start=${XML_TEXT}`);
  }, 120_000);

  it("its audit files it with the tool that repairs it", async () => {
    const findings = await renderFindings(runId);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "render/value-breaks-markup",
      severity: "error",
      fix: { tool: "patch_list_items_many" },
    });
    expect(findings[0]?.fix?.hint).toContain("&lt;");
  });

  it("Publish live refuses the build", async () => {
    await sqlSystem(async (tx) => {
      await tx`UPDATE quality_audit_runs
                  SET status = 'passed', gate_rules = 2, finished_at = now()
                WHERE deploy_run_id = ${runId}::uuid`;
    });
    const gate = await execute(registry, adapter, OWNER, "quality_audits.gate_status", {});
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    expect((gate.value as { gate: { open: boolean; state: string } }).gate).toMatchObject({
      open: false,
      state: "render",
    });
    const refused = await execute(registry, adapter, OWNER, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect((refused.error as { message: string }).message).toContain(
        "1 spot it could not render",
      );
    }
  }, 120_000);

  it("repaired with &lt;, the next Stage records nothing", async () => {
    await sysOp("lists.patch_items_many", {
      lists: [
        {
          slug: LIST_SLUG,
          patches: [
            {
              op: "update",
              itemId: XML_ID,
              values: { text: "Die Datei sollte direkt mit &lt;?xml beginnen." },
            },
          ],
        },
      ],
    });
    const staged = await stage("t1748 repaired");
    expect(staged.renderReport).toBeNull();
    expect(await stagedHtml(staged.runId, pageId)).toContain("<footer>Fußzeile</footer>");
  }, 120_000);
});

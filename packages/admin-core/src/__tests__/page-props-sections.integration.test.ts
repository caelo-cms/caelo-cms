// SPDX-License-Identifier: MPL-2.0

/**
 * #1561 — `{{#page.props.x}}…{{/page.props.x}}` on a page whose type does
 * not declare `x`.
 *
 * Seen on 0.12.4 (2026-11-10): a help-page head showed its meta block with
 * `{{#page.props.stand}}`, and the home page placed the same module. Its
 * type declares no `stand`, so the whole section stayed raw, inner
 * placeholders included, under a marker the render gate lets through:
 * neither the Stage nor Publish live stopped raw `{{…}}` from reaching
 * visitors.
 *
 * Maintainer decision 2026-11-24, end to end (real generator, real
 * Postgres), the editor preview and the build alike:
 * - a property another page type declares is absent: the section renders
 *   nothing, the inverted one its body, and nothing is reported;
 * - a property no page type declares (a typo) stays loud: the preview flags
 *   it, the Stage ships the spot as the preview shows it and records it,
 *   the audit names it with the tools that repair it, and Publish live and
 *   a production build refuse it.
 *
 * #1717 — the same end to end for a `{{page.*}}` key the page does not
 * have (`{{page.titel}}`) and a path a property cannot answer
 * (`{{page.props.stand.formatted}}` on a text property).
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

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1561",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "t1561-ai",
};
const OWNER_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t1561-owner" };
const PFX = "t1561";
const HELP_TYPE = `${PFX}-hilfe`;

/** The shared help-page head: its meta block shows only where the page has a `stand`. */
const HEAD =
  '<header class="hk"><h1>{{titel}}</h1>' +
  '{{#page.props.stand}}<ul class="hx-meta"><li><b>{{fuer_label}}</b> {{page.props.fuer_wen}}</li><li>{{page.props.stand}}</li></ul>{{/page.props.stand}}' +
  '{{^page.props.stand}}<p class="hx-none">Allgemeine Hilfe</p>{{/page.props.stand}}</header>';
/** The same head with a property name no page type declares. */
const TYPO_HEAD =
  '<header class="hk"><h1>{{titel}}</h1>' +
  '{{#page.props.stnad}}<ul class="hx-meta"><li><b>{{fuer_label}}</b> {{page.props.fuer_wen}}</li></ul>{{/page.props.stnad}}</header>';

/** The head with a page key the page does not have and a path its text property cannot answer (#1717). */
const PATH_HEAD =
  '<header class="hk"><h1>{{page.titel}}</h1><p>{{page.props.stand.formatted}}</p></header>';

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prevSkipServeCheck: string | undefined;
let prevOutputRoot: string | undefined;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;
let homeId = "";
let helpId = "";
let moduleId = "";

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
    await tx.unsafe(`DELETE FROM page_types WHERE slug LIKE '${PFX}-%'`);
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

async function openChat(title: string): Promise<string> {
  const chat = await execute(registry, adapter, OWNER, "chat.create_session", { title });
  if (!chat.ok) throw new Error(JSON.stringify(chat.error));
  return (chat.value as { chatSessionId: string }).chatSessionId;
}

async function preview(pageId: string): Promise<{ html: string; missingSlots: string[] }> {
  return sysOp("pages.render_preview", { pageId });
}

async function stage(title: string) {
  const staged = await stageChatSessions({ registry, adapter }, OWNER, [await openChat(title)]);
  if (!staged.ok) throw new Error(staged.error.message);
  return staged.value;
}

/** A page of the staged build, as staging serves it. */
async function stagedHtml(runId: string, pageId: string): Promise<string> {
  const rows = await sqlSystem(
    async (tx) =>
      (await tx`SELECT (SELECT out_dir FROM deploy_targets WHERE name = 'staging') AS out_dir,
                       current_path FROM pages WHERE id = ${pageId}::uuid`) as {
        out_dir: string;
        current_path: string;
      }[],
  );
  const row = rows[0];
  if (!row) throw new Error(`no page ${pageId}`);
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

beforeAll(async () => {
  await cleanup();
  restoreBase = await pinSiteBaseUrl(ADMIN_URL, "https://example.com");
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "de");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-t1561-"));
  prevSkipServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  prevOutputRoot = process.env.CAELO_OUTPUT_ROOT;
  process.env.CAELO_OUTPUT_ROOT = testRoot;
  await sqlSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 't1561 owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
  });

  const { layoutId } = await sysOp<{ layoutId: string }>("layouts.create", {
    slug: `${PFX}-layout`,
    displayName: "T1561 layout",
    html: '<body><caelo-slot name="content"></caelo-slot></body>',
    css: "",
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { templateId } = await sysOp<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "T1561",
    html: '<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
    css: "",
    layoutId,
  });
  await sysOp("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  await sysOp("page_types.upsert_many", {
    pageTypes: [
      {
        slug: HELP_TYPE,
        name: "Hilfe",
        purpose: "Help articles with a review date and an audience.",
        collection: true,
        templates: [templateId],
        defaultTemplate: templateId,
        properties: [
          { name: "stand", label: "Stand", type: "text" },
          { name: "fuer_wen", label: "Für wen", type: "text" },
        ],
        vocabularies: [],
      },
    ],
  });
  helpId = (
    await sysOp<{ pageId: string }>("pages.build_page", {
      page: {
        slug: "hilfe-konto",
        title: "Konto",
        templateId,
        status: "draft",
        pageType: HELP_TYPE,
        properties: { stand: "November 2026", fuer_wen: "Alle Teams" },
      },
      modules: [
        {
          blockName: "content",
          displayName: `${PFX} Hilfe-Kopf`,
          description: "The head of a help page, with its review date and audience.",
          kind: "hero",
          html: HEAD,
          fields: [
            { name: "titel", kind: "text", label: "Titel" },
            { name: "fuer_label", kind: "text", label: "Für-Label" },
          ],
          content: { source: "inline", values: { titel: "Konto", fuer_label: "Für:" } },
        },
      ],
    })
  ).pageId;
  const placed = await sqlSystem(
    async (tx) =>
      (await tx`SELECT module_id::text AS id FROM page_modules WHERE page_id = ${helpId}::uuid`) as {
        id: string;
      }[],
  );
  moduleId = placed[0]?.id as string;
  homeId = (
    await sysOp<{ pageId: string }>("pages.build_page", {
      page: { slug: "home", title: "Start", templateId, status: "draft", pageType: "home" },
      modules: [
        {
          blockName: "content",
          moduleId,
          content: { source: "inline", values: { titel: "Hilfe", fuer_label: "Für:" } },
        },
      ],
    })
  ).pageId;
  for (const pageId of [helpId, homeId]) {
    await sysOp("pages.set_status", { pageId, status: "published" });
    await sysOp("pages_seo.autofill", { pageId, metaDescription: "A test page." });
  }
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

describe("#1561 — a property another page type declares is absent", () => {
  it("the editor preview renders the section only where the page's type has the property", async () => {
    const home = await preview(homeId);
    expect(home.html).toContain('<p class="hx-none">Allgemeine Hilfe</p>');
    expect(home.html).not.toContain("hx-meta");
    expect(home.html).not.toContain("{{");
    expect(
      home.missingSlots.filter((m) => m.includes("page.props") || m.includes("page-prop")),
    ).toEqual([]);

    const help = await preview(helpId);
    expect(help.html).toContain("<b>Für:</b> Alle Teams");
    expect(help.html).toContain("<li>November 2026</li>");
    expect(help.html).not.toContain("hx-none");
    expect(help.html).not.toContain("{{");
  }, 60_000);

  it("the Stage builds the same and records nothing to repair", async () => {
    const staged = await stage("t1561 shared head");
    expect(staged.renderReport).toBeNull();
    const home = await stagedHtml(staged.runId, homeId);
    expect(home).toContain('<p class="hx-none">Allgemeine Hilfe</p>');
    expect(home).not.toContain("hx-meta");
    expect(home).not.toContain("{{");
    const help = await stagedHtml(staged.runId, helpId);
    expect(help).toContain("<b>Für:</b> Alle Teams");
    expect(help).not.toContain("{{");
  }, 120_000);
});

describe("#1561 — a property no page type declares fails loudly", () => {
  let runId = "";

  beforeAll(async () => {
    // The write tools take a `page.props` name without checking it (the
    // page type may come after the module); only the render knows.
    await sqlSystem(
      (tx) => tx`UPDATE modules SET html = ${TYPO_HEAD} WHERE id = ${moduleId}::uuid`,
    );
  });

  it("the editor preview flags it and shows the spot raw", async () => {
    for (const pageId of [homeId, helpId]) {
      const r = await preview(pageId);
      expect(r.missingSlots).toContain("page-prop-unknown:stnad");
      expect(r.html).toContain("{{#page.props.stnad}}");
    }
    // The AI's look at the preview names the repair, as the Stage will.
    const tools = new ToolRegistry();
    tools.register(inspectPageRenderTool);
    const inspected = await tools.dispatch("inspect_page_render", { pageId: homeId }, AI, {
      adapter,
      registry,
    });
    expect(inspected.ok).toBe(true);
    const summary = JSON.parse(inspected.content) as {
      slots: { nextSteps?: Record<string, string> };
    };
    expect(summary.slots.nextSteps?.["page-prop-unknown:stnad"]).toContain("list_page_types");
  }, 60_000);

  it("the Stage ships the spot as the preview shows it, records it and names the repair", async () => {
    const staged = await stage("t1561 typo");
    runId = staged.runId;
    const report = staged.renderReport;
    expect(report?.total).toBe(2);
    expect(new Set(report?.failures.map((f) => f.reason))).toEqual(
      new Set(["page-prop-unknown:stnad"]),
    );
    expect(new Set(report?.failures.map((f) => f.pageId))).toEqual(new Set([homeId, helpId]));
    expect(report?.operatorText).toStartWith("Staged, but 2 spots could not be rendered");
    expect(report?.operatorText).not.toMatch(/page-prop-unknown|list_page_types/);
    expect(report?.aiText).toContain("page-prop-unknown:stnad");
    expect(report?.aiText).toContain("list_page_types");
    expect(report?.aiText).toContain("upsert_page_types_many");
    expect(await stagedHtml(runId, homeId)).toContain("{{#page.props.stnad}}");
  }, 120_000);

  it("its audit reports it once, with the tool that shows the page types' properties", async () => {
    const findings = await renderFindings(runId);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "render/page-prop-unknown",
      severity: "error",
      fix: { tool: "list_page_types" },
    });
    expect(findings[0]?.fix?.hint).toContain("update_modules_many");
  });

  it("Publish live refuses the build, and a production build of it is refused", async () => {
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
        "2 spots it could not render",
      );
    }
    const production = await execute(registry, adapter, OWNER, "deploy.trigger", {
      targetName: "production",
      repoRoot: testRoot,
    });
    expect(production.ok).toBe(false);
    if (!production.ok) {
      // Refused by the render gate, not by some other check.
      expect((production.error as { message: string }).message).toContain(
        "2 spots it could not render",
      );
    }
  }, 120_000);
});

describe("#1717 — a page key or path the page cannot answer fails loudly", () => {
  let runId = "";

  beforeAll(async () => {
    await sqlSystem(
      (tx) => tx`UPDATE modules SET html = ${PATH_HEAD} WHERE id = ${moduleId}::uuid`,
    );
  });

  it("the editor preview flags both and the AI's look names the repair", async () => {
    for (const pageId of [homeId, helpId]) {
      const r = await preview(pageId);
      expect(r.html).toContain("{{page.titel}}");
      expect(r.html).toContain("{{page.props.stand.formatted}}");
      expect(r.missingSlots).toContain("page-key-unknown:titel");
      expect(r.missingSlots).toContain("page-path-unknown:props.stand:text");
    }
    const tools = new ToolRegistry();
    tools.register(inspectPageRenderTool);
    const inspected = await tools.dispatch("inspect_page_render", { pageId: helpId }, AI, {
      adapter,
      registry,
    });
    expect(inspected.ok).toBe(true);
    const steps = (
      JSON.parse(inspected.content) as { slots: { nextSteps?: Record<string, string> } }
    ).slots.nextSteps;
    expect(steps?.["page-key-unknown:titel"]).toContain("update_modules_many");
    expect(steps?.["page-path-unknown:props.stand:text"]).toContain(
      "page.props.stand (text) has no paths",
    );
  }, 60_000);

  it("the Stage records both, the audit files each kind, and Publish live refuses", async () => {
    const staged = await stage("t1717 page paths");
    runId = staged.runId;
    expect(staged.renderReport?.total).toBe(4);
    expect(new Set(staged.renderReport?.failures.map((f) => f.reason))).toEqual(
      new Set(["page-key-unknown:titel", "page-path-unknown:props.stand:text"]),
    );
    expect(await stagedHtml(runId, homeId)).toContain("{{page.titel}}");

    const findings = await renderFindings(runId);
    expect(findings.map((f) => f.ruleId).sort()).toEqual([
      "render/page-key-unknown",
      "render/page-path-unknown",
    ]);
    for (const f of findings) {
      expect(f.severity).toBe("error");
      expect(f.fix?.tool).toBe("update_modules_many");
    }

    await sqlSystem(async (tx) => {
      await tx`UPDATE quality_audit_runs
                  SET status = 'passed', gate_rules = 2, finished_at = now()
                WHERE deploy_run_id = ${runId}::uuid`;
    });
    const refused = await execute(registry, adapter, OWNER, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect((refused.error as { message: string }).message).toContain(
        "4 spots it could not render",
      );
    }
  }, 120_000);

  it("valid keys and paths render unchanged", async () => {
    await sqlSystem(
      (tx) =>
        tx`UPDATE modules SET html = ${'<header class="hk"><h1>{{page.title}}</h1><p>{{page.props.stand}}</p><a href="{{page.link.href}}">x</a></header>'}
           WHERE id = ${moduleId}::uuid`,
    );
    const help = await preview(helpId);
    expect(help.html).toContain("<h1>Konto</h1>");
    expect(help.html).toContain("<p>November 2026</p>");
    expect(help.html).not.toContain("{{");
    expect(help.missingSlots.filter((m) => m.startsWith("page-"))).toEqual([]);
  }, 60_000);
});

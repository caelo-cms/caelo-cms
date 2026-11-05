// SPDX-License-Identifier: MPL-2.0

/**
 * #1240 — publishing a language version whose links go to pages without a
 * version in that language.
 *
 * Seen on searchVIU (v0.11.2): `home-en` set to Published in the panel,
 * then the next Stage failed with the static generator's raw markers. Two
 * holes made the reference gate miss it:
 *   - a panel status click writes the live row and leaves the chat nothing
 *     to merge, and an empty merge returned before the gate ran;
 *   - a language's own chrome is plugin data, and plugin data was resolved
 *     with no rendering language, so it could never be `variant-missing`.
 *
 * End to end (real generator, real Postgres, international-site active),
 * with the maintainer's decision of 2026-10-29: the Stage succeeds and
 * reports each target by title, Publish live refuses the same list, and a
 * deleted target is still refused before the generator runs.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, resetPluginHost, runPluginOperation } from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { pageOutputPath } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { checkReferences } from "../ops/content/link-integrity.js";
import { setDeployBridge } from "../ops/deploy.js";
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
  requestId: "t1240",
};
const OWNER_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t1240-owner" };
const PFX = "t1240";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prevSkipServeCheck: string | undefined;
let prevOutputRoot: string | undefined;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;

const ids = { deHome: "", dePricing: "", deDemo: "", deGone: "", enHome: "", layout: "" };

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
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe("DELETE FROM quality_audit_runs");
    await tx.unsafe("DELETE FROM deploy_runs");
    await tx.unsafe(`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages)`);
    await tx.unsafe(`DELETE FROM layout_modules`);
    await tx.unsafe(`DELETE FROM page_modules`);
    await tx.unsafe(`DELETE FROM pages`);
    await tx.unsafe(`DELETE FROM content_instances`);
    await tx.unsafe(`DELETE FROM modules WHERE slug LIKE '%${PFX}%'`);
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

async function intl<T>(operationName: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

/** A menu entry of a `links` list (what chrome stores). */
const menuEntry = (n: number, label: string, href: string) => ({
  id: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
  node: "link",
  values: { label, link: { href } },
});

async function openChat(title: string): Promise<string> {
  const chat = await execute(registry, adapter, OWNER, "chat.create_session", { title });
  if (!chat.ok) throw new Error(JSON.stringify(chat.error));
  return (chat.value as { chatSessionId: string }).chatSessionId;
}

beforeAll(async () => {
  await cleanup();
  restoreBase = await pinSiteBaseUrl(ADMIN_URL, "https://example.com");
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "de");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-t1240-"));
  prevSkipServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  prevOutputRoot = process.env.CAELO_OUTPUT_ROOT;
  process.env.CAELO_OUTPUT_ROOT = testRoot;
  await sqlSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 't1240 owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
  });
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));

  const { layoutId } = await sysOp<{ layoutId: string }>("layouts.create", {
    slug: `${PFX}-layout`,
    displayName: "T1240 layout",
    html: '<body><caelo-slot name="header"></caelo-slot><caelo-slot name="content"></caelo-slot></body>',
    css: "",
    blocks: [
      { name: "header", displayName: "Header", position: 0 },
      { name: "content", displayName: "Content", position: 1 },
    ],
  });
  ids.layout = layoutId;
  const { templateId } = await sysOp<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "T1240",
    html: '<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
    css: "",
    layoutId,
  });
  await sysOp("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const page = async (slug: string, title: string) =>
    (await sysOp<{ pageId: string }>("pages.create", { slug, title, templateId })).pageId;
  ids.dePricing = await page(`${PFX}-preise`, "Pricing");
  ids.deDemo = await page(`${PFX}-demo`, "Demo");
  ids.deGone = await page(`${PFX}-gone`, "Soon gone");
  ids.deHome = (
    await sysOp<{ pageId: string }>("pages.build_page", {
      page: { slug: "home", title: "Startseite", templateId, status: "draft" },
      modules: [
        {
          blockName: "content",
          displayName: `${PFX} section`,
          description: "One link in the page content.",
          kind: "content",
          html: '<a class="cta" href="{{cta_href}}">Preise</a>',
          fields: [{ name: "cta_href", kind: "link", label: "CTA link" }],
          content: { source: "inline", values: { cta_href: `/${PFX}-preise` } },
        },
      ],
    })
  ).pageId;

  // The header: a chrome module whose list links the pricing page.
  const fields = [
    {
      name: "menu",
      kind: "list",
      listType: "links",
      label: "Main menu",
      default: [menuEntry(1, "Preise", `/${PFX}-preise`)],
    },
  ];
  const { moduleId } = await sysOp<{ moduleId: string }>("modules.create", {
    slug: `${PFX}-main-menu`,
    displayName: "Main menu",
    html: '<header><nav>{{#menu}}<a href="{{link}}">{{label}}</a>{{/menu}}</nav></header>',
    css: "",
    js: "",
    fields,
  });
  await sysOp("layout_modules.set", { layoutId, blockName: "header", moduleIds: [moduleId] });

  await intl("set_locales", {
    locales: [
      { code: "de", displayName: "Deutsch", urlStrategy: "none", isDefault: true },
      { code: "en", displayName: "English", urlStrategy: "subdirectory", isDefault: false },
    ],
  });
  ids.enHome = (
    await intl<{ pageId: string }>("create_variant", {
      sourcePageId: ids.deHome,
      localeCode: "en",
    })
  ).pageId;
  // The English header's own items: a link the German header does not have
  // lives only in plugin storage — the second hole of #1240.
  await intl("set_chrome_variants", {
    variants: [
      {
        targetKey: `layout:${layoutId}:header:0`,
        localeCode: "en",
        values: {
          menu: [menuEntry(1, "Pricing", `/${PFX}-preise`), menuEntry(2, "Demo", `/${PFX}-demo`)],
        },
      },
    ],
  });
  for (const id of [ids.deHome, ids.dePricing, ids.deDemo, ids.deGone]) {
    await sysOp("pages.set_status", { pageId: id, status: "published" });
    await sysOp("pages_seo.autofill", { pageId: id, metaDescription: "A test page." });
  }
  await sysOp("pages_seo.autofill", { pageId: ids.enHome, metaDescription: "A test page." });
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

/** Every marker of a technical name an operator must never read. */
function expectOperatorWords(text: string): void {
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  expect(text).not.toContain("link-variant-missing");
  expect(text).not.toContain(`${PFX}-main-menu`);
  expect(text).not.toMatch(/create_variant|translate_variant|check_links|list_pages/);
}

interface StagedRun {
  runId: string;
  linkNotice: LinkNotice | null;
}

async function stage(title: string): Promise<StagedRun> {
  const staged = await stageChatSessions({ registry, adapter }, OWNER, [await openChat(title)]);
  if (!staged.ok) throw new Error(staged.error.message);
  return staged.value;
}

/** The staged build's audit passed: nothing but the links can close the gate. */
async function markAudited(runId: string): Promise<void> {
  await sqlSystem(async (tx) => {
    await tx`
      INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
      VALUES (${runId}::uuid, ${SYSTEM_ACTOR_ID}::uuid, 'passed',
              '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())
      ON CONFLICT DO NOTHING`;
    await tx`UPDATE quality_audit_runs SET status = 'passed', gate_rules = 2
             WHERE deploy_run_id = ${runId}::uuid`;
  });
}

const publishLive = () =>
  execute(registry, adapter, OWNER, "deploy.promote", {
    fromTarget: "staging",
    toTarget: "production",
    repoRoot: testRoot,
  });

describe("#1240 — a language version linking pages without a version in that language", () => {
  it("the publish click reports the links in the operator's words, and the status stands", async () => {
    // The panel click: no chat branch, the live row only.
    const clicked = await execute(registry, adapter, OWNER, "pages.set_status", {
      pageId: ids.enHome,
      status: "published",
    });
    expect(clicked.ok).toBe(true);
    const r = await execute(registry, adapter, OWNER, "links.publish_notice", {
      pageIds: [ids.enHome],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { notice } = r.value as { notice: LinkNotice };
    expect(notice.targets.map((t) => t.title).sort()).toEqual(["Demo", "Pricing"]);
    const pricing = notice.targets.find((t) => t.title === "Pricing");
    expect(pricing?.path).toBe(`/${PFX}-preise`);
    expect(pricing?.areas).toEqual(["a page section", "the header"]);
    expect(notice.operatorText).toContain("Pricing");
    expect(notice.operatorText).toContain("no English version");
    expect(notice.operatorText).toContain("a page section and the header of /en");
    expectOperatorWords(notice.operatorText);
    expect(notice.fixLabel).toBe("Create English versions");
    expect(notice.linkingPages.map((p) => p.id)).toEqual([ids.enHome]);
    // The AI gets the same list and the tools.
    expect(notice.aiText).toContain(notice.operatorText);
    expect(notice.aiText).toContain("create_variant");
    expect(notice.aiText).toContain("translate_variant");
    expect(notice.aiText).toContain("list_pages");
  });

  it("the gate reads a language's own chrome in that language", async () => {
    const issues = await adapter.withAdminTransaction(SYS, (tx) =>
      checkReferences(tx, { branchId: null, env: "production" }),
    );
    const targets = issues.filter((i) => i.problem === "variant-missing");
    // Pricing from the page section and the header; Demo ONLY from the
    // English chrome variant, which is plugin data.
    expect(targets.map((i) => i.targetPageId)).toContain(ids.dePricing);
    expect(targets.map((i) => i.targetPageId)).toContain(ids.deDemo);
    expect(targets.every((i) => i.severity === "block")).toBe(true);
    const stageIssues = await adapter.withAdminTransaction(SYS, (tx) =>
      checkReferences(tx, { branchId: null, env: "staging" }),
    );
    expect(
      stageIssues.filter((i) => i.problem === "variant-missing").map((i) => i.severity),
    ).not.toContain("block");
  });

  it("the Stage succeeds, renders the links for review and reports them", async () => {
    const staged = await stage("t1240 stage");
    const built = await sqlSystem(
      async (tx) =>
        (await tx`SELECT out_dir FROM deploy_targets WHERE name = 'staging'`) as {
          out_dir: string;
        }[],
    );
    const html = await readFile(
      join(testRoot, built[0]?.out_dir ?? "", "builds", staged.runId, pageOutputPath("/en")),
      "utf8",
    );
    expect(html).toContain(`href="/${PFX}-preise/"`);
    expect(html).toContain(`href="/${PFX}-demo/"`);
    expect(html).not.toContain("caelo:page/");
    expect(staged.linkNotice?.targets.map((t) => t.title).sort()).toEqual(["Demo", "Pricing"]);
    expectOperatorWords(staged.linkNotice?.operatorText ?? "");
    const stored = await sqlSystem(
      async (tx) =>
        (await tx`SELECT link_notice FROM deploy_runs WHERE id = ${staged.runId}::uuid`) as {
          link_notice: LinkNotice | null;
        }[],
    );
    expect(stored[0]?.link_notice?.operatorText).toBe(staged.linkNotice?.operatorText as string);
    await markAudited(staged.runId);
  }, 120_000);

  it("Publish live refuses that Stage with the same list, even with a passed audit", async () => {
    const gate = await execute(registry, adapter, OWNER, "quality_audits.gate_status", {});
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    const view = (gate.value as { gate: { open: boolean; state: string; linkNotice: unknown } })
      .gate;
    expect(view.open).toBe(false);
    expect(view.state).toBe("links");
    expect(view.linkNotice).not.toBeNull();

    const refused = await publishLive();
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const message = (refused.error as { message: string }).message;
    expect(message).toContain("Pricing");
    expect(message).toContain("Demo");
    expectOperatorWords(message);
  });

  it("a direct production build is refused before the generator, in the same words", async () => {
    const refused = await execute(registry, adapter, OWNER, "deploy.trigger", {
      targetName: "production",
      repoRoot: testRoot,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const message = (refused.error as { message: string }).message;
    expect(message).toContain("Pricing");
    expect(message).not.toContain("generator failed");
    expectOperatorWords(message);
  });

  it("back to draft and a new Stage open Publish live again", async () => {
    await execute(registry, adapter, OWNER, "pages.set_status_many", {
      pageIds: [ids.enHome],
      status: "draft",
    });
    const staged = await stage("t1240 draft");
    expect(staged.linkNotice).toBeNull();
    await markAudited(staged.runId);
    const gate = await execute(registry, adapter, OWNER, "quality_audits.gate_status", {});
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    expect((gate.value as { gate: { state: string } }).gate.state).not.toBe("links");
  }, 120_000);

  it("a deleted target is refused before the generator runs, also with nothing to merge", async () => {
    await sqlSystem(async (tx) => {
      await tx`UPDATE pages SET deleted_at = now() WHERE id = ${ids.dePricing}::uuid`;
    });
    try {
      const chatId = await openChat("t1240 deleted");
      const staged = await stageChatSessions({ registry, adapter }, OWNER, [chatId]);
      expect(staged.ok).toBe(false);
      if (staged.ok) return;
      expect(staged.error.step).toBe("deploy");
      expect(staged.error.message).toContain("Stage refused");
      expect(staged.error.message).not.toContain("generator failed");
      const failed = await sqlSystem(
        async (tx) =>
          (await tx`
            SELECT r.error_message FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
            WHERE t.env = 'staging' AND r.status = 'failed' ORDER BY r.started_at DESC LIMIT 1
          `) as { error_message: string }[],
      );
      expect(failed[0]?.error_message).toStartWith("Blocked, links:");
    } finally {
      await sqlSystem(async (tx) => {
        await tx`UPDATE pages SET deleted_at = NULL WHERE id = ${ids.dePricing}::uuid`;
      });
    }
  }, 120_000);

  it("a Stage's report covers what the build rendered, not only what the check read", async () => {
    await execute(registry, adapter, OWNER, "pages.set_status", {
      pageId: ids.enHome,
      status: "published",
    });
    const staged = await stage("t1240 again");
    const reports = await sqlSystem(
      async (tx) =>
        (await tx`SELECT count(*)::int AS n FROM ai_bug_reports
                  WHERE title = 'The link check and the build disagreed about a link'`) as {
          n: number;
        }[],
    );
    // The check saw everything the build rendered: nothing to report.
    expect(reports[0]?.n).toBe(0);
    expect(staged.linkNotice).not.toBeNull();
  }, 120_000);
});

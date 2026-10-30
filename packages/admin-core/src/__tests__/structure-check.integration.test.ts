// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #820 — the core `structure` check end to end, against a real
 * Postgres and a real self-hosted staging build (served to the worker on a
 * loopback port, provider "aws"; Lighthouse is faked clean).
 *
 *   - a step chain pasted into the richtext field of a generic text module
 *     on two pages is `structure/repeated-markup`, an error that blocks
 *     Publish live; the page with prose only is clean;
 *   - the write tool that pastes the third copy gets the markup-guard hint;
 *   - one copy left is a one-off: the next Stage opens the gate.
 *
 * The test also pins what the check relies on: the static build keeps the
 * `data-caelo-module-id` every module root carries.
 *
 * #1027 — sub-modules in `module-list` / `module` fields are module
 * output, not free markup: the same FAQ entry module on several pages
 * keeps the gate open, because the static build stamps each nested root
 * with its own module id.
 *
 * #1256 — a guides hub kept as a `module-list` of card modules (each card
 * a `url` field) is `structure/manual-page-listing`: an error naming the
 * guide it misses, read through the real sources (pages, page types, the
 * default page type); the same hub as a list field bound to a page query
 * is clean.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { setDeployBridge } from "../ops/deploy.js";
import { sampleMetrics } from "../quality/__tests__/fixtures/sample-metrics.js";
import { drainAuditQueue } from "../quality/audit-worker.js";
import { linkSourcesFromOps, referenceSourcesFromOps } from "../quality/checks/links-sources.js";
import { createCoreCheckRegistry } from "../quality/checks/registry.js";
import { structureSourcesFromOps } from "../quality/checks/structure-sources.js";
import type { AuditJob } from "../quality/lighthouse-protocol.js";
import type { AuditJobResult } from "../quality/lighthouse-runner.js";
import { localBuildSource } from "../quality/staged-origin.js";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const OWNER_ID = crypto.randomUUID();
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "sc-820" };
const HUMAN: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "sc-820" };
const AI: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "ai", requestId: "sc-820" };
const PFX = "sc820-";
const RULE = "structure/repeated-markup";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prev: Record<string, string | undefined> = {};
let restoreBase: (() => Promise<void>) | null = null;
let restoreLang: (() => Promise<void>) | null = null;
let templateId: string;
let textModuleId: string;
const pageIds: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };

const chain = (steps: number) =>
  `<div class="chain">${Array.from(
    { length: steps },
    (_, i) => `<div class="step"><span class="n">${i + 1}</span><p>Step ${i + 1}</p></div>`,
  ).join('<span class="arrow"></span>')}</div>`;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    let out: T | undefined;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      out = await fn(tx as unknown as SQL);
    });
    return out as T;
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM quality_pending_actions`;
    await tx`DELETE FROM quality_acceptances`;
    await tx`DELETE FROM quality_baselines`;
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home'`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_types WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM user_roles WHERE user_id = ${OWNER_ID}::uuid`;
    await tx`DELETE FROM users WHERE id = ${OWNER_ID}::uuid`;
  });
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** A clean Lighthouse: the first Stage of a site always runs it. */
const cleanLighthouse = async (job: AuditJob): Promise<AuditJobResult> => ({
  ok: true,
  pages: job.pages.map((p) => ({
    pageId: p.pageId,
    url: p.url,
    measurement: {
      scores: { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 },
      failingAudits: [],
      metrics: sampleMetrics(),
    },
    performanceRuns: [100, 100, 100],
  })),
  pageErrors: [],
});

/** Build staging, queue a findings-only audit for it, run the real worker. */
async function stageAndAudit(title: string): Promise<string> {
  const built = await op<{ runId: string }>(SYS, "deploy.trigger", {
    targetName: "staging",
    repoRoot: testRoot,
  });
  const chatSessionId = (
    await op<{ chatSessionId: string }>(HUMAN, "chat.create_session", {
      isolation: "experiment",
      title: `${PFX}${title}`,
    })
  ).chatSessionId;
  await op(HUMAN, "quality_audits.enqueue", {
    deployRunId: built.runId,
    chatSessionId,
    branch: {
      classification: { auditNeeded: false, reasons: [], skipped: ["field values: body"] },
      touchedPageIds: [],
    },
  });
  await drainAuditQueue({
    adapter,
    registry,
    runJob: cleanLighthouse,
    checks: createCoreCheckRegistry({
      lighthouse: cleanLighthouse,
      structure: structureSourcesFromOps(registry, adapter, SYS),
      links: linkSourcesFromOps(registry, adapter, SYS),
      references: referenceSourcesFromOps(registry, adapter, SYS),
    }),
    env: {
      provider: "aws",
      loopbackSource: (run) =>
        localBuildSource(join(testRoot, "output", "staging", "builds", run.deployRunId)),
    },
  });
  return built.runId;
}

interface AuditRead {
  run: { status: string; errorMessage: string | null };
  pages: {
    pageId: string;
    checkFindings: { ruleId: string; severity: string; message: string }[];
  }[];
}

async function gate(): Promise<{ open: boolean; state: string; message: string }> {
  return (
    await op<{ gate: { open: boolean; state: string; message: string } }>(
      HUMAN,
      "quality_audits.gate_status",
      {},
    )
  ).gate;
}

async function buildPage(slug: string, body: string): Promise<string> {
  const value = await op<{ pageId: string; placements: { moduleId: string }[] }>(
    HUMAN,
    "pages.build_page",
    {
      page: { slug, title: slug, templateId },
      modules: [
        textModuleId
          ? {
              blockName: "content",
              moduleId: textModuleId,
              content: { source: "inline", values: { title: slug, body } },
            }
          : {
              blockName: "content",
              displayName: "Text",
              description: "Generic heading + richtext body.",
              kind: "content",
              html: '<section class="prose"><h2>{{title}}</h2><div class="body">{{body}}</div></section>',
              fields: [
                { name: "title", kind: "text", label: "Title" },
                { name: "body", kind: "richtext", label: "Body" },
              ],
              content: { source: "inline", values: { title: slug, body } },
            },
      ],
    },
  );
  textModuleId ||= value.placements[0]?.moduleId ?? "";
  await op(HUMAN, "pages.update", { pageId: value.pageId, status: "published" });
  await op(HUMAN, "pages_seo.set", { pageId: value.pageId, metaDescription: `About ${slug}.` });
  return value.pageId;
}

/** The FAQ entry the #1027 test nests: classed, big enough to be a pattern. */
const FAQ_ENTRY_HTML =
  '<details class="faq-item"><summary class="q">{{question}}</summary><div class="a"><p>{{answer}}</p></div></details>';
const nested = { faqModuleId: "", entryModuleId: "" };

/**
 * A page whose only placement is an FAQ module: a `module-list` of three
 * FAQ entry sub-modules plus one more in a `module` field. The first call
 * mints both modules; later calls reuse them by id with their own entries.
 */
async function buildFaqPage(slug: string): Promise<string> {
  const entries = [0, 1, 2, 3].map((i) => ({
    ref: `e${i}`,
    ...(nested.entryModuleId
      ? { moduleId: nested.entryModuleId }
      : i === 0
        ? {
            displayName: `${PFX}faq-entry`,
            description: "One FAQ question with its answer.",
            kind: "content",
            html: FAQ_ENTRY_HTML,
            fields: [
              { name: "question", kind: "text", label: "Question" },
              { name: "answer", kind: "text", label: "Answer" },
            ],
          }
        : { moduleId: { $ref: "e0" } }),
    content: {
      source: "inline",
      values: { question: `${slug} question ${i}?`, answer: `${slug} answer ${i}.` },
    },
  }));
  const values = {
    items: [{ $ref: "e0" }, { $ref: "e1" }, { $ref: "e2" }],
    featured: { $ref: "e3" },
  };
  const faq = nested.faqModuleId
    ? { blockName: "content", moduleId: nested.faqModuleId, content: { source: "inline", values } }
    : {
        blockName: "content",
        displayName: `${PFX}faq`,
        description: "FAQ section: a list of FAQ entries plus one featured entry.",
        kind: "content",
        html: '<section class="faq"><div class="faq-list">{{#items}}{{/items}}</div><aside class="faq-top">{{>featured}}</aside></section>',
        fields: [
          { name: "items", kind: "module-list", label: "Entries" },
          { name: "featured", kind: "module", label: "Featured entry" },
        ],
        content: { source: "inline", values },
      };
  const value = await op<{
    pageId: string;
    placements: { moduleId: string }[];
    detached: { moduleId: string }[];
  }>(HUMAN, "pages.build_page", {
    page: { slug, title: slug, templateId },
    modules: [...entries, faq],
  });
  nested.faqModuleId ||= value.placements[0]?.moduleId ?? "";
  nested.entryModuleId ||= value.detached[0]?.moduleId ?? "";
  await op(HUMAN, "pages.update", { pageId: value.pageId, status: "published" });
  await op(HUMAN, "pages_seo.set", { pageId: value.pageId, metaDescription: `About ${slug}.` });
  return value.pageId;
}

/** Every HTML file of a staged build, concatenated. */
async function builtHtml(runId: string): Promise<string> {
  const dir = join(testRoot, "output", "staging", "builds", runId);
  const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".html"));
  return (await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))).join("\n");
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await wipe();
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 'sc owner')
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
  });
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLang = await pinSiteLanguage(ADMIN_URL as string, "en");
  testRoot = await mkdtemp(join(tmpdir(), "caelo-structure-check-"));
  prev = {
    CAELO_SKIP_STAGING_SERVE_CHECK: process.env.CAELO_SKIP_STAGING_SERVE_CHECK,
    CAELO_OUTPUT_ROOT: process.env.CAELO_OUTPUT_ROOT,
  };
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  process.env.CAELO_OUTPUT_ROOT = testRoot;

  templateId = (
    await op<{ templateId: string }>(HUMAN, "templates.create", {
      slug: `${PFX}tpl`,
      displayName: "T",
      html: `<!doctype html><html lang="en"><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
  await op(HUMAN, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  textModuleId = "";
  pageIds.a = await buildPage("home", `<p>Intro</p>${chain(3)}`);
  pageIds.b = await buildPage(`${PFX}b`, chain(5));
  pageIds.c = await buildPage(`${PFX}c`, "<p>Only prose here.</p>");
});

afterAll(async () => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await wipe();
  await restoreBase?.();
  await restoreLang?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("the core structure check (#820)", () => {
  it("free markup repeated on two pages blocks Publish live; prose stays clean", async () => {
    const runId = await stageAndAudit("repeat");
    const got = await op<AuditRead>(AI, "quality_audits.get", { deployRunId: runId });
    expect(got.run.errorMessage).toBeNull();
    expect(got.run.status).toBe("problems");
    // Only this check's rules: the fixture pages link nowhere, so the core
    // links check (#849) reports them as orphans — warnings, not this test.
    const findingsOf = (id: string) =>
      got.pages
        .find((p) => p.pageId === id)
        ?.checkFindings.filter((f) => f.ruleId.startsWith("structure/"))
        .map((f) => [f.ruleId, f.severity]) ?? [];
    expect(findingsOf(pageIds.a)).toEqual([[RULE, "error"]]);
    expect(findingsOf(pageIds.b)).toEqual([[RULE, "error"]]);
    expect(findingsOf(pageIds.c)).toEqual([]);
    const message = got.pages
      .find((p) => p.pageId === pageIds.a)
      ?.checkFindings.find((f) => f.ruleId === RULE)?.message;
    expect(message).toContain("`div.chain`");
    expect(message).toContain('in "Text"');
    const g = await gate();
    expect(g).toMatchObject({ open: false, state: "problems" });
  });

  it("the write that pastes the next copy carries the markup-guard hint", async () => {
    // The registered tool, so the guard wiring itself is under test.
    const r = await createDefaultToolRegistry().dispatch(
      "set_page_module_content_many",
      {
        items: [
          {
            pageId: pageIds.c,
            blockName: "content",
            position: 0,
            contentValues: { title: "c", body: chain(2) },
          },
        ],
      },
      AI,
      { registry, adapter } as ToolContext,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("markup-guard: field `body` carries the pattern `div.chain`");
    expect(r.content).toContain("free HTML in 3 placements");
  });

  it("with one copy left it is a one-off, and the gate opens", async () => {
    for (const id of [pageIds.b, pageIds.c]) {
      await op(HUMAN, "page_module_content.set", {
        pageId: id,
        blockName: "content",
        position: 0,
        contentValues: { title: "x", body: "<p>Prose again.</p>" },
      });
    }
    const runId = await stageAndAudit("fixed");
    const got = await op<AuditRead>(AI, "quality_audits.get", { deployRunId: runId });
    expect(got.run.status).toBe("passed");
    expect(
      got.pages.flatMap((p) => p.checkFindings).filter((f) => f.ruleId.startsWith("structure/")),
    ).toEqual([]);
    expect(await gate()).toMatchObject({ open: true, state: "clean" });
  });

  it("sub-modules (module-list + module) on several pages are not free markup (#1027)", async () => {
    await buildFaqPage(`${PFX}faq-a`);
    await buildFaqPage(`${PFX}faq-b`);
    await buildFaqPage(`${PFX}faq-c`);
    const runId = await stageAndAudit("nested");
    const got = await op<AuditRead>(AI, "quality_audits.get", { deployRunId: runId });
    expect(
      got.pages
        .flatMap((p) => p.checkFindings)
        .filter((f) => f.ruleId.startsWith("structure/"))
        .map((f) => f.message),
    ).toEqual([]);
    expect(await gate()).toMatchObject({ open: true, state: "clean" });
    // What the check relies on: every nested root carries its own id in
    // the static build (4 entries x 3 pages).
    const tagged = `<details class="faq-item" data-caelo-module-id="${nested.entryModuleId}">`;
    expect((await builtHtml(runId)).split(tagged).length - 1).toBe(12);
  });

  it("a hub of hand-kept guide cards is a manual page listing; a page query is clean (#1256)", async () => {
    const guideType = `${PFX}guide`;
    // The hubs are ordinary pages: the site's default page type (exempt).
    const plain = (
      await op<{ defaults: { defaultPageTypeSlug: string } }>(HUMAN, "site_defaults.get", {})
    ).defaults.defaultPageTypeSlug;
    await op(HUMAN, "page_types.upsert_many", {
      pageTypes: [
        {
          slug: guideType,
          name: "Guide",
          purpose: "How-to guides, listed on the guides hub.",
          templates: [templateId],
          defaultTemplate: templateId,
        },
      ],
    });
    const guides: string[] = [];
    for (const i of [0, 1, 2, 3]) {
      const built = await op<{ pageId: string }>(HUMAN, "pages.build_page", {
        page: { slug: `${PFX}guide-${i}`, title: `Guide ${i}`, templateId, pageType: guideType },
        modules: [],
      });
      await op(HUMAN, "pages.update", { pageId: built.pageId, status: "published" });
      await op(HUMAN, "pages_seo.set", { pageId: built.pageId, metaDescription: `Guide ${i}.` });
      guides.push(built.pageId);
    }
    const cards = [0, 1, 2].map((i) => ({
      ref: `card${i}`,
      ...(i === 0
        ? {
            displayName: `${PFX}guide-card`,
            description: "One guide as a card: title and a link to the guide.",
            kind: "content",
            html: '<article class="guide-card"><h3 class="gc-title">{{title}}</h3><a class="gc-more" href="{{href}}">Read</a></article>',
            fields: [
              { name: "title", kind: "text", label: "Title" },
              { name: "href", kind: "url", label: "Link" },
            ],
          }
        : { moduleId: { $ref: "card0" } }),
      content: { source: "inline", values: { title: `Guide ${i}`, href: `/${PFX}guide-${i}` } },
    }));
    const hub = await op<{ pageId: string; placements: { moduleId: string }[] }>(
      HUMAN,
      "pages.build_page",
      {
        page: { slug: `${PFX}guides`, title: "Guides", templateId, pageType: plain },
        modules: [
          ...cards,
          {
            blockName: "content",
            displayName: `${PFX}card-grid`,
            description: "A grid of cards.",
            kind: "content",
            html: '<section class="card-grid"><div class="cg-cards">{{#cards}}{{/cards}}</div></section>',
            fields: [{ name: "cards", kind: "module-list", label: "Cards" }],
            content: {
              source: "inline",
              values: { cards: [{ $ref: "card0" }, { $ref: "card1" }, { $ref: "card2" }] },
            },
          },
        ],
      },
    );
    await op(HUMAN, "pages.update", { pageId: hub.pageId, status: "published" });
    await op(HUMAN, "pages_seo.set", { pageId: hub.pageId, metaDescription: "All guides." });

    const runId = await stageAndAudit("listing");
    const got = await op<AuditRead>(AI, "quality_audits.get", { deployRunId: runId });
    const listing = got.pages
      .flatMap((p) => p.checkFindings.map((f) => ({ ...f, pageId: p.pageId })))
      .filter((f) => f.ruleId === "structure/manual-page-listing");
    expect(listing.map((f) => [f.pageId, f.severity])).toEqual([[hub.pageId, "error"]]);
    expect(listing[0]?.message).toContain('3 of 4 published pages of type "Guide"');
    expect(listing[0]?.message).toContain(`"Guide 3" (/${PFX}guide-3)`);
    expect((await gate()).open).toBe(false);

    // The right way: one list field bound to a page query of the type.
    await op(HUMAN, "pages.update", { pageId: hub.pageId, status: "draft" });
    const queryHub = await op<{ pageId: string }>(HUMAN, "pages.build_page", {
      page: { slug: `${PFX}guides-index`, title: "Guide index", templateId, pageType: plain },
      modules: [
        {
          blockName: "content",
          displayName: `${PFX}guide-index`,
          description: "Every published guide, newest title order.",
          kind: "content",
          html: '<section class="guide-index">{{#guides}}<a class="gi-item" href="{{link}}">{{title}}</a>{{/guides}}</section>',
          fields: [
            {
              name: "guides",
              kind: "list",
              label: "Guides",
              listType: "links",
              bind: "source",
              source: {
                kind: "query",
                editable: [],
                defaults: { page_type: guideType, order: "title_asc", limit: 50 },
              },
            },
          ],
          content: { source: "inline", values: {} },
        },
      ],
    });
    await op(HUMAN, "pages.update", { pageId: queryHub.pageId, status: "published" });
    await op(HUMAN, "pages_seo.set", { pageId: queryHub.pageId, metaDescription: "Guides." });
    const cleanRun = await stageAndAudit("listing-query");
    const clean = await op<AuditRead>(AI, "quality_audits.get", { deployRunId: cleanRun });
    expect(await builtHtml(cleanRun)).toContain(`class="gi-item" href="/${PFX}guide-3/"`);
    expect(
      clean.pages
        .flatMap((p) => p.checkFindings)
        .filter((f) => f.ruleId === "structure/manual-page-listing"),
    ).toEqual([]);
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #849 — the core `links` check end to end, against a real Postgres
 * and a real staged build (written by the static generator, served to the
 * worker on a loopback port, provider "aws"; Lighthouse is faked clean).
 *
 *   - a link to a path the build does not contain is
 *     `links/broken-internal`, an error that blocks Publish live, and the
 *     finding names the page, the href and the tool;
 *   - #846 regressions: an image that exists in the build and a path
 *     printed as text are never flagged;
 *   - a link through the redirect table is a `links/redirect-chain`
 *     warning; a page nothing links to is a `links/orphan-page` warning;
 *   - fixing the link opens the gate on the next Stage.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
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
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "lc-849" };
const HUMAN: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "lc-849" };
const AI: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "ai", requestId: "lc-849" };
const PFX = "lc849-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prev: Record<string, string | undefined> = {};
let restoreBase: (() => Promise<void>) | null = null;
let restoreLang: (() => Promise<void>) | null = null;
let templateId: string;
let textModuleId: string;
const pageIds: Record<"home" | "about" | "lonely", string> = { home: "", about: "", lonely: "" };

/** A media file the staged build really contains (see `addMediaFile`). */
const IMAGE = "/media/lc849-hero.webp";

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
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`/${PFX}%`}`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home')`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`} OR slug = 'home'`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM user_roles WHERE user_id = ${OWNER_ID}::uuid`;
    await tx`DELETE FROM users WHERE id = ${OWNER_ID}::uuid`;
  });
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

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
  const buildDir = join(testRoot, "output", "staging", "builds", built.runId);
  // The media pass writes variants of library media; this fixture puts one
  // file where the build serves media, so the probe finds a real file.
  await mkdir(join(buildDir, "media"), { recursive: true });
  await writeFile(join(buildDir, IMAGE.slice(1)), "RIFF0000WEBP");
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
    checkFindings: {
      ruleId: string;
      severity: string;
      message: string;
      fix?: { tool: string; hint: string };
    }[];
  }[];
}

async function gate(): Promise<{ open: boolean; state: string }> {
  return (
    await op<{ gate: { open: boolean; state: string } }>(HUMAN, "quality_audits.gate_status", {})
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

async function setBody(pageId: string, body: string): Promise<void> {
  await op(HUMAN, "page_module_content.set", {
    pageId,
    blockName: "content",
    position: 0,
    contentValues: { title: "x", body },
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await wipe();
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 'lc owner')
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
  });
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLang = await pinSiteLanguage(ADMIN_URL as string, "en");
  testRoot = await mkdtemp(join(tmpdir(), "caelo-links-check-"));
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
  await op(HUMAN, "redirects.create", {
    fromPath: `/${PFX}old-about`,
    toPath: `/${PFX}about`,
    statusCode: 301,
  });
  textModuleId = "";
  pageIds.home = await buildPage("home", "<p>Home.</p>");
  pageIds.about = await buildPage(`${PFX}about`, "<p>About.</p>");
  pageIds.lonely = await buildPage(`${PFX}lonely`, "<p>Nobody links here.</p>");
  // Since #724 the write ops refuse an internal link to no page and store a
  // link through a 301 as a reference to the page it lands on, so a broken
  // link or a redirect hop in a build comes from content written before
  // (literal paths). Seed exactly that, underneath the ops.
  await legacyBody(
    pageIds.home,
    [
      `<p>Read <a href="https://example.com/${PFX}about/">about us</a>`,
      ` or the <a href="/${PFX}old-about">old about page</a>.</p>`,
      `<p><img src="${IMAGE}" alt="Hero"></p>`,
      `<p>Our shop lives at /${PFX}shop/xyz — just text.</p>`,
    ].join(""),
  );
  await legacyBody(
    pageIds.about,
    `<p>See <a href="/${PFX}pricng">pricing</a> and <a href="/">home</a>.</p>`,
  );
});

/** Write a page's `body` value directly — pre-#724 literal content. */
async function legacyBody(pageId: string, body: string): Promise<void> {
  await withSql(
    (tx) => tx`UPDATE content_instances
               SET "values" = jsonb_set("values", '{body}', to_jsonb(${body}::text))
               WHERE id IN (SELECT content_instance_id FROM page_modules WHERE page_id = ${pageId}::uuid)`,
  );
}

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

describe("the core links check (#849)", () => {
  it("a broken internal link blocks Publish live; existing images and path-like text never count", async () => {
    const runId = await stageAndAudit("broken");
    const got = await op<AuditRead>(AI, "quality_audits.get", { deployRunId: runId });
    expect(got.run.errorMessage).toBeNull();
    expect(got.run.status).toBe("problems");
    const findingsOf = (id: string) => got.pages.find((p) => p.pageId === id)?.checkFindings ?? [];

    const about = findingsOf(pageIds.about).filter((f) => f.ruleId.startsWith("links/"));
    expect(about.map((f) => [f.ruleId, f.severity])).toEqual([["links/broken-internal", "error"]]);
    expect(about[0]?.message).toContain(`a[href] "/${PFX}pricng"`);
    expect(about[0]?.message).toContain('module "Text"');
    expect(about[0]?.fix?.tool).toBe("set_page_module_content");

    // #846: the image exists in the build and the shop path is only text.
    const home = findingsOf(pageIds.home).filter((f) => f.ruleId.startsWith("links/"));
    expect(home.map((f) => [f.ruleId, f.severity])).toEqual([["links/redirect-chain", "warning"]]);
    expect(home[0]?.message).toContain(`/${PFX}old-about → /${PFX}about (301)`);
    expect(JSON.stringify(got)).not.toContain(`${PFX}shop`);
    expect(JSON.stringify(got)).not.toContain("lc849-hero");

    const lonely = findingsOf(pageIds.lonely).map((f) => [f.ruleId, f.severity]);
    expect(lonely).toEqual([["links/orphan-page", "warning"]]);

    expect(await gate()).toMatchObject({ open: false, state: "problems" });
  });

  it("fixing the link opens the gate on the next Stage", async () => {
    await setBody(
      pageIds.about,
      `<p>See <a href="/${PFX}lonely/">the quiet page</a> and <a href="/">home</a>.</p>`,
    );
    const runId = await stageAndAudit("fixed");
    const got = await op<AuditRead>(AI, "quality_audits.get", { deployRunId: runId });
    expect(got.run.status).toBe("passed");
    const errors = got.pages.flatMap((p) => p.checkFindings).filter((f) => f.severity === "error");
    expect(errors).toEqual([]);
    expect(
      got.pages.flatMap((p) => p.checkFindings).filter((f) => f.ruleId === "links/orphan-page"),
    ).toEqual([]);
    expect(await gate()).toMatchObject({ open: true, state: "clean" });
  });
});

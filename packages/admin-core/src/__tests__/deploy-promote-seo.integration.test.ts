// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: "Publish live" (deploy.promote) shipped staging's SEO
 * semantics to production. Staging builds baked the staging target's
 * `noindex` into every page's `<meta name="robots">` and skipped
 * sitemap.xml; promote copies the staging build verbatim and only
 * patched robots.txt — so production dropped out of search engines.
 *
 * Pins, end to end on the self-hosted publisher (real generator, real
 * Postgres):
 *   - a staging build carries no env-level noindex meta, ships a
 *     sitemap.xml, and keeps staging non-indexable via robots.txt
 *     (`Disallow: /`, no `Sitemap:` line) — the staging vhost's
 *     `X-Robots-Tag` is pinned in packages/provisioning tests;
 *   - after promote, production pages carry only their OWN robots
 *     setting (a page-level noindex survives), sitemap.xml is live
 *     and robots.txt allows crawling with a `Sitemap:` line;
 *   - page HTML is byte-identical between staging and production;
 *   - a legacy staging build (manifest without `envNoindexInHtml:
 *     false`) is refused with a "Stage again" next step.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prevSkipServeCheck: string | undefined;
let restoreSiteBaseUrl: (() => Promise<void>) | null = null;
let restoreSiteLanguage: (() => Promise<void>) | null = null;

// #551 — site_base_url has no default; promote reads it for the
// production robots.txt `Sitemap:` line, so the test pins it.
const SITE_BASE_URL = "https://example.com";

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "promote-seo-test",
};

const TPL_SLUG = "promote-seo-tpl";
const MOD_SLUG = "promote-seo-mod";
const PAGE_SLUG = "promote-seo-about";
const HIDDEN_SLUG = "promote-seo-hidden";
// issue #302 — staging/production builds need a page at the site root.
const HOME_SLUG = "home";
const SLUGS = [PAGE_SLUG, HIDDEN_SLUG, HOME_SLUG];

const ROBOTS_META = /<meta name="robots"[^>]*>/;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM deploy_runs`;
      await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug IN (${PAGE_SLUG}, ${HIDDEN_SLUG}, ${HOME_SLUG}))`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug IN (${PAGE_SLUG}, ${HIDDEN_SLUG}, ${HOME_SLUG}))`;
      await tx`DELETE FROM pages WHERE slug IN (${PAGE_SLUG}, ${HIDDEN_SLUG}, ${HOME_SLUG})`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

/**
 * #553 — Publish live is gated on the staged build's quality audit; this
 * suite is about SEO semantics, so it records a passed audit directly.
 */
async function markAudited(deployRunId: string): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`
        INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
        VALUES (${deployRunId}::uuid, ${HUMAN.actorId}::uuid, 'passed',
                '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())`;
    });
  } finally {
    await sql.end();
  }
}

async function ok<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, HUMAN, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function seedSite(): Promise<void> {
  const { templateId } = await ok<{ templateId: string }>("templates.create", {
    slug: TPL_SLUG,
    displayName: "T",
    html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  await ok("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { moduleId } = await ok<{ moduleId: string }>("modules.create", {
    slug: MOD_SLUG,
    displayName: "M",
    html: "<p>promote seo</p>",
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  for (const slug of SLUGS) {
    const { pageId } = await ok<{ pageId: string }>("pages.create", {
      slug,
      title: slug,
      templateId,
    });
    await ok("pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    await ok("pages.update", { pageId, status: "published" });
    // The operator's own per-page choice — must survive promote.
    if (slug === HIDDEN_SLUG) await ok("pages_seo.set", { pageId, noindex: true });
  }
}

beforeAll(async () => {
  await wipe();
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL!, SITE_BASE_URL);
  restoreSiteLanguage = await pinSiteLanguage(ADMIN_URL!, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-promote-seo-"));
  // No staging vhost in this harness — see deploy.trigger's serve check.
  prevSkipServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  await seedSite();
});

afterAll(async () => {
  if (prevSkipServeCheck === undefined) delete process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  else process.env.CAELO_SKIP_STAGING_SERVE_CHECK = prevSkipServeCheck;
  await wipe();
  await restoreSiteBaseUrl?.();
  await restoreSiteLanguage?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("deploy.promote ships production SEO semantics", () => {
  it("staging build → Publish live: no env noindex, sitemap + Sitemap line, per-page noindex kept", async () => {
    const staged = await ok<{ buildId: string; runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await markAudited(staged.runId);
    const staging = join(testRoot, "output", "staging", "current");
    const production = join(testRoot, "output", "production", "current");

    // Staging: content renders env-independently; staging stays
    // non-indexable through robots.txt (and the serving-layer header).
    const stagedAbout = await readFile(join(staging, PAGE_SLUG, "index.html"), "utf8");
    expect(stagedAbout).not.toMatch(ROBOTS_META);
    expect(existsSync(join(staging, "sitemap.xml"))).toBe(true);
    const stagingRobots = await readFile(join(staging, "robots.txt"), "utf8");
    expect(stagingRobots).toContain("Disallow: /");
    expect(stagingRobots).not.toContain("Sitemap:");

    await ok("deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });

    const liveAbout = await readFile(join(production, PAGE_SLUG, "index.html"), "utf8");
    expect(liveAbout).not.toMatch(ROBOTS_META);
    // What staging shows is what production gets.
    expect(liveAbout).toBe(stagedAbout);
    const liveHome = await readFile(join(production, "index.html"), "utf8");
    expect(liveHome).not.toMatch(ROBOTS_META);
    // Page-level noindex is the operator's choice, not the env's.
    const liveHidden = await readFile(join(production, HIDDEN_SLUG, "index.html"), "utf8");
    expect(liveHidden).toContain('<meta name="robots" content="noindex" />');

    const sitemap = await readFile(join(production, "sitemap.xml"), "utf8");
    expect(sitemap).toContain(PAGE_SLUG);
    expect(sitemap).not.toContain(HIDDEN_SLUG);

    const liveRobots = await readFile(join(production, "robots.txt"), "utf8");
    expect(liveRobots).toContain("Allow: /");
    expect(liveRobots).not.toContain("Disallow: /");
    expect(liveRobots).toContain(`Sitemap: ${SITE_BASE_URL}/sitemap.xml`);

    const manifest = JSON.parse(
      await readFile(join(production, "routing-manifest.json"), "utf8"),
    ) as { env: string; runId: string };
    expect(manifest.env).toBe("production");
    expect(manifest.runId).toBe(staged.buildId);
  });

  it("refuses to promote a legacy staging build whose pages carry staging's noindex", async () => {
    const staged = await ok<{ buildId: string; runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await markAudited(staged.runId);
    // Simulate a build from before the env-independent SEO pass: its
    // manifest lacks the `envNoindexInHtml: false` flag.
    const manifestPath = join(
      testRoot,
      "output",
      "staging",
      "builds",
      staged.buildId,
      "routing-manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.envNoindexInHtml;
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const r = await execute(registry, adapter, HUMAN, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.error)).toContain("run Stage again");
  });
});

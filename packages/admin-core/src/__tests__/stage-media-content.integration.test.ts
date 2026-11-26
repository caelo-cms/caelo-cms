// SPDX-License-Identifier: MPL-2.0

/**
 * #1719 — the media pass's content refusals no longer stop a Stage.
 *
 * A reference image on a page (#531) and a share image (og:image) that was
 * deleted or has no image file are the site's content (CLAUDE.md §2,
 * #1604): the Stage completes, ships the spot as the editor preview shows
 * it, records it with the run, and Publish live refuses the build. A stored
 * file missing from the media store is no content edit's to repair: it
 * still stops the Stage, as a Caelo fault (no refusal flag, so the bug
 * intake files it).
 *
 * End to end: real generator, real Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { digestBytes, pageOutputPath } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import type { RenderReport } from "../deploy/render-failures.js";
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
  requestId: "t1719",
};
const OWNER_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t1719-owner" };
const PFX = "t1719";
const SHA_PREFIX = "17190000";
const FILE_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46]);

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let mediaRoot: string;
let prevSkipServeCheck: string | undefined;
let prevOutputRoot: string | undefined;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;
let homeId = "";
let figure = { assetId: "", slug: "", sha: "" };
let noVariants = { assetId: "", slug: "", sha: "" };
let deleted = { assetId: "", slug: "", sha: "" };

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
    await tx.unsafe(
      `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${PFX}-%'`);
    await tx`DELETE FROM media_assets WHERE sha256 LIKE ${`${SHA_PREFIX}%`}`;
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

/** A library image with its stored files where the generator's media pass reads them. */
async function image(
  name: string,
  n: string,
): Promise<{ assetId: string; slug: string; sha: string }> {
  const sha = `${SHA_PREFIX}${n.repeat(56)}`;
  const digest = await digestBytes(FILE_BYTES);
  const variants = [
    { variant: "orig", format: "png", width: 1200, file: "orig.png" },
    { variant: "webp-400", format: "webp", width: 400, file: "webp-400.webp" },
  ];
  const up = await sysOp<{ assetId: string; slug: string }>("media.upload", {
    sha256: sha,
    originalName: `${name}.png`,
    name: `${PFX} ${name}`,
    mime: "image/png",
    sizeBytes: FILE_BYTES.byteLength,
    width: 1200,
    height: 630,
    alt: name,
    storageKey: `${sha}/orig.png`,
    variants: variants.map((v) => ({
      variant: v.variant,
      format: v.format,
      width: v.width,
      height: null,
      sizeBytes: FILE_BYTES.byteLength,
      storageKey: `${sha}/${v.file}`,
      digest,
    })),
  });
  await mkdir(join(mediaRoot, sha), { recursive: true });
  for (const v of variants) await writeFile(join(mediaRoot, sha, v.file), FILE_BYTES);
  return { ...up, sha };
}

const setVisibility = (assetId: string, visibility: "library" | "reference") =>
  sysOp("media.set_visibility_many", { items: [{ assetId, visibility }] });

/** The page's own share image, as an older write (or a later delete) left it. */
const setPageShareImage = (assetId: string | null) =>
  sqlSystem(
    (tx) =>
      tx`UPDATE pages_seo SET og_image_asset_id = ${assetId}::uuid WHERE page_id = ${homeId}::uuid`,
  );

async function stage(title: string) {
  return stageChatSessions({ registry, adapter }, OWNER, [await openChat(title)]);
}

async function stagedHome(runId: string): Promise<string> {
  const target = await sqlSystem(
    async (tx) =>
      (await tx`SELECT out_dir FROM deploy_targets WHERE name = 'staging'`) as {
        out_dir: string;
      }[],
  );
  return readFile(
    join(testRoot, target[0]?.out_dir ?? "", "builds", runId, pageOutputPath("/")),
    "utf8",
  );
}

/** Publish live after a passed audit: the render record alone keeps it shut. */
async function expectPublishLiveRefused(runId: string): Promise<void> {
  await sqlSystem(async (tx) => {
    await tx`UPDATE quality_audit_runs SET status = 'passed', gate_rules = 2, finished_at = now()
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
}

beforeAll(async () => {
  await cleanup();
  restoreBase = await pinSiteBaseUrl(ADMIN_URL, "https://example.com");
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-t1719-"));
  mediaRoot = resolve(testRoot, process.env.MEDIA_ROOT_DIR ?? "data/media");
  prevSkipServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  prevOutputRoot = process.env.CAELO_OUTPUT_ROOT;
  process.env.CAELO_OUTPUT_ROOT = testRoot;
  await sqlSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 't1719 owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
  });

  figure = await image("figure", "a");
  noVariants = await image("share-no-files", "b");
  deleted = await image("share-deleted", "c");

  const { layoutId } = await sysOp<{ layoutId: string }>("layouts.create", {
    slug: `${PFX}-layout`,
    displayName: "T1719 layout",
    html: '<body><caelo-slot name="content"></caelo-slot></body>',
    css: "",
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { templateId } = await sysOp<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "T1719",
    html: '<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
    css: "",
    layoutId,
  });
  await sysOp("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  homeId = (
    await sysOp<{ pageId: string }>("pages.build_page", {
      page: { slug: "home", title: "Brand guide", templateId, status: "draft" },
      modules: [
        {
          blockName: "content",
          displayName: `${PFX} figure`,
          description: "A figure on the brand page.",
          kind: "content",
          html: `<figure><img src="/_caelo/media/${figure.slug}/webp-400" alt="Figure"></figure>`,
          fields: [],
          content: { source: "inline", values: {} },
        },
      ],
    })
  ).pageId;
  await sysOp("pages.set_status", { pageId: homeId, status: "published" });
  await sysOp("pages_seo.autofill", { pageId: homeId, metaDescription: "A test page." });
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

describe("#1719 — a Stage with media the build cannot publish", () => {
  it("completes with a reference image on a page, reports it, and Publish live refuses the build", async () => {
    await setVisibility(figure.assetId, "reference");
    try {
      const staged = await stage("t1719 reference");
      if (!staged.ok) throw new Error(staged.error.message);
      const { runId, renderReport } = staged.value;
      const marker = `media-reference:${figure.slug}/webp-400`;
      expect(renderReport?.failures.map((f) => f.reason)).toEqual([marker]);
      expect(renderReport?.operatorText).toContain(
        "An image is a reference image (a guide for making images), which is never published — on Brand guide (/)",
      );
      expect(renderReport?.operatorText).not.toMatch(/media-reference|find_media|t1719/);
      // As the editor preview shows it: the URL stays, no file of it ships.
      const html = await stagedHome(runId);
      expect(html).toContain(`src="/_caelo/media/${figure.slug}/webp-400"`);
      expect(html).not.toContain(`/_assets/${figure.slug}`);

      const queued = await sqlSystem(
        async (tx) =>
          (await tx`SELECT id::text AS id FROM quality_audit_runs
                    WHERE deploy_run_id = ${runId}::uuid AND status = 'queued'`) as {
            id: string;
          }[],
      );
      const claimed = await sysOp<{ run: ClaimedAuditRun | null }>("quality_audits.claim", {
        auditRunId: queued[0]?.id,
      });
      const run = claimed.run as ClaimedAuditRun;
      const findings = await createRenderCheck(claimedRenderSources(run)).run({
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
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        ruleId: "render/media-reference",
        pageId: homeId,
        fix: { tool: "find_media" },
      });
      expect(findings[0]?.fix?.hint).toContain("set_media_visibility_many");
      await expectPublishLiveRefused(runId);
    } finally {
      await setVisibility(figure.assetId, "library");
    }
  }, 120_000);

  it("completes with a share image that has no image file, ships the page without og:image and blocks Publish live", async () => {
    await sqlSystem(
      (tx) => tx`DELETE FROM media_variants WHERE asset_id = ${noVariants.assetId}::uuid`,
    );
    await setPageShareImage(noVariants.assetId);
    const staged = await stage("t1719 no files");
    if (!staged.ok) throw new Error(staged.error.message);
    const report: RenderReport | null = staged.value.renderReport;
    expect(report?.failures.map((f) => f.reason)).toEqual([
      `og-image-missing:page/${noVariants.assetId}`,
    ]);
    expect(report?.operatorText).toContain(
      "The image shown when the page is shared was deleted or has no image file — on Brand guide (/)",
    );
    expect(report?.aiText).toContain("set_page_seo_many");
    expect(await stagedHome(staged.value.runId)).not.toContain("og:image");
    await expectPublishLiveRefused(staged.value.runId);
  }, 120_000);

  it("completes with a deleted share image the same way", async () => {
    await sqlSystem(
      (tx) => tx`UPDATE media_assets SET deleted_at = now() WHERE id = ${deleted.assetId}::uuid`,
    );
    await setPageShareImage(deleted.assetId);
    const staged = await stage("t1719 deleted");
    if (!staged.ok) throw new Error(staged.error.message);
    expect(staged.value.renderReport?.failures.map((f) => f.reason)).toEqual([
      `og-image-missing:page/${deleted.assetId}`,
    ]);
    expect(await stagedHome(staged.value.runId)).not.toContain("og:image");
    await expectPublishLiveRefused(staged.value.runId);
  }, 120_000);

  it("still stops on a stored file missing from the media store, as a Caelo fault", async () => {
    await setPageShareImage(null);
    const dir = join(mediaRoot, figure.sha);
    await rename(dir, `${dir}.gone`);
    try {
      const staged = await stage("t1719 lost file");
      expect(staged.ok).toBe(false);
      if (staged.ok) return;
      expect(staged.error.message).toContain("are missing from");
      // No refusal flag: the bug intake files it as Caelo's (#1484).
      expect((staged.error.error as { refusal?: boolean }).refusal).toBeUndefined();
    } finally {
      await rename(`${dir}.gone`, dir);
    }
  }, 120_000);

  it("repaired, the next Stage records nothing", async () => {
    const staged = await stage("t1719 repaired");
    if (!staged.ok) throw new Error(staged.error.message);
    expect(staged.value.renderReport).toBeNull();
    expect(await stagedHome(staged.value.runId)).toContain(`/_assets/${figure.slug}/webp-400.`);
  }, 120_000);
});

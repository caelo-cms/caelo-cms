// SPDX-License-Identifier: MPL-2.0

/**
 * #1600 — a media reference the build cannot publish no longer stops a Stage.
 *
 * Reported from an install on 0.12.4: a figure referenced the `webp-800` of a
 * 760 px source, which the pipeline never makes (no upscaling). The write was
 * accepted, and every Stage then stopped in the generator's media pass on that
 * one image. The write refuses such a reference now; content an older release
 * stored keeps it, and the build must handle it the #1604 way.
 *
 * End to end (real generator, real Postgres): the Stage succeeds, staging
 * keeps the reference as the editor preview shows it, the run records it, the
 * Stage's audit reports it on the page with the URL to write instead, Publish
 * live refuses the build, and a production build of the same content is
 * refused. Repaired and staged again, the record is gone.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1600",
};
const OWNER_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t1600-owner" };
const PFX = "t1600";
const SHA = `16000000${"c".repeat(56)}`;
const FILE_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46]);

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prevSkipServeCheck: string | undefined;
let prevOutputRoot: string | undefined;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;
let homeId = "";
let moduleId = "";
let assetId = "";
let slug = "";

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
    await tx`DELETE FROM media_assets WHERE sha256 = ${SHA}`;
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

/** Point the stored module at `variant`, as content an older release wrote. */
async function storeFigureVariant(variant: string): Promise<void> {
  await sqlSystem(
    (tx) =>
      tx`UPDATE modules SET html = ${`<figure><img src="caelo:media/${assetId}/${variant}" alt="URL history"></figure>`}
         WHERE id = ${moduleId}::uuid`,
  );
}

beforeAll(async () => {
  await cleanup();
  restoreBase = await pinSiteBaseUrl(ADMIN_URL, "https://example.com");
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-t1600-"));
  prevSkipServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  prevOutputRoot = process.env.CAELO_OUTPUT_ROOT;
  process.env.CAELO_OUTPUT_ROOT = testRoot;
  await sqlSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 't1600 owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
  });

  // A 760 px source: the pipeline made webp-400 and kept the original. The
  // files sit where the generator's media pass reads them.
  const digest = await digestBytes(FILE_BYTES);
  const variants = [
    { variant: "orig", format: "png", width: 760, file: "orig.png" },
    { variant: "webp-400", format: "webp", width: 400, file: "webp-400.webp" },
  ];
  const upload = await sysOp<{ assetId: string; slug: string }>("media.upload", {
    sha256: SHA,
    originalName: "url-history.png",
    name: `${PFX} url history`,
    mime: "image/png",
    sizeBytes: FILE_BYTES.byteLength,
    width: 760,
    height: 291,
    alt: "URL history",
    storageKey: `${SHA}/orig.png`,
    variants: variants.map((v) => ({
      variant: v.variant,
      format: v.format,
      width: v.width,
      height: null,
      sizeBytes: FILE_BYTES.byteLength,
      storageKey: `${SHA}/${v.file}`,
      digest,
    })),
  });
  assetId = upload.assetId;
  slug = upload.slug;
  const mediaRoot = resolve(testRoot, process.env.MEDIA_ROOT_DIR ?? "data/media");
  await mkdir(join(mediaRoot, SHA), { recursive: true });
  for (const v of variants) await writeFile(join(mediaRoot, SHA, v.file), FILE_BYTES);

  const { layoutId } = await sysOp<{ layoutId: string }>("layouts.create", {
    slug: `${PFX}-layout`,
    displayName: "T1600 layout",
    html: '<body><caelo-slot name="content"></caelo-slot></body>',
    css: "",
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { templateId } = await sysOp<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "T1600",
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
      page: { slug: "home", title: "Getting started", templateId, status: "draft" },
      modules: [
        {
          blockName: "content",
          displayName: `${PFX} figure`,
          description: "A figure in a help article.",
          kind: "content",
          html: `<figure><img src="/_caelo/media/${slug}/webp-400" alt="URL history"></figure>`,
          fields: [],
          content: { source: "inline", values: {} },
        },
      ],
    })
  ).pageId;
  const placed = await sqlSystem(
    async (tx) =>
      (await tx`SELECT module_id::text AS id FROM page_modules WHERE page_id = ${homeId}::uuid`) as {
        id: string;
      }[],
  );
  moduleId = placed[0]?.id as string;
  // The write tools refuse a size the image does not have since #1600; a
  // module stored by an older release still names one.
  await storeFigureVariant("webp-800");
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

describe("#1600 — a Stage with an image size the media library does not have", () => {
  let runId = "";
  let report: RenderReport | null = null;
  const marker = () => `media-variant-missing:${slug}/webp-800:orig,webp-400`;

  it("succeeds, ships the reference as the preview shows it and records it", async () => {
    const staged = await stageChatSessions({ registry, adapter }, OWNER, [
      await openChat("t1600 stage"),
    ]);
    if (!staged.ok) throw new Error(staged.error.message);
    runId = staged.value.runId;
    report = staged.value.renderReport;
    expect(report?.total).toBe(1);
    expect(report?.failures[0]).toMatchObject({ pageId: homeId, reason: marker() });
    expect(report?.operatorText).toStartWith("Staged, but 1 spot could not be rendered");
    expect(report?.operatorText).toContain(
      "An image points at a size or file the media library does not have — on Getting started (/)",
    );
    expect(report?.operatorText).not.toMatch(/media-variant-missing|set_content_instance|t1600/);
    expect(report?.aiText).toContain(`/_caelo/media/${slug}/webp-800 names size "webp-800"`);
    expect(report?.aiText).toContain(`/_caelo/media/${slug}/webp-400`);

    const target = await sqlSystem(
      async (tx) =>
        (await tx`SELECT out_dir FROM deploy_targets WHERE name = 'staging'`) as {
          out_dir: string;
        }[],
    );
    const html = await readFile(
      join(testRoot, target[0]?.out_dir ?? "", "builds", runId, pageOutputPath("/")),
      "utf8",
    );
    expect(html).toContain(`src="/_caelo/media/${slug}/webp-800"`);

    const stored = await sqlSystem(
      async (tx) =>
        (await tx`SELECT status, render_report FROM deploy_runs WHERE id = ${runId}::uuid`) as {
          status: string;
          render_report: RenderReport | null;
        }[],
    );
    expect(stored[0]?.status).toBe("succeeded");
    expect(stored[0]?.render_report?.failures[0]?.reason).toBe(marker());
  }, 120_000);

  it("its audit reports the image on the page with the URL to write instead", async () => {
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
      ruleId: "render/media-variant-missing",
      severity: "error",
      pageId: homeId,
      fix: { tool: "set_content_instance_values_many" },
    });
    expect(findings[0]?.fix?.hint).toContain(
      `write /_caelo/media/${slug}/webp-400 or /_caelo/media/${slug} instead`,
    );
  });

  it("Publish live refuses it", async () => {
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
  });

  it("a production build of the same content is refused", async () => {
    const refused = await execute(registry, adapter, OWNER, "deploy.trigger", {
      targetName: "production",
      repoRoot: testRoot,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect((refused.error as { message: string }).message).toContain(
        "An image points at a size or file the media library does not have",
      );
    }
  }, 120_000);

  it("repaired and staged again, the run records nothing", async () => {
    await storeFigureVariant("webp-400");
    const staged = await stageChatSessions({ registry, adapter }, OWNER, [
      await openChat("t1600 repaired"),
    ]);
    if (!staged.ok) throw new Error(staged.error.message);
    expect(staged.value.renderReport).toBeNull();
  }, 120_000);
});

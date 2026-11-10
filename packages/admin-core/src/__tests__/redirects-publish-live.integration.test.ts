// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — what goes live with Publish live, end to end on the self-hosted
 * publisher (real generator, real Postgres):
 *
 *   - a Stage of a live page's rename leaves the live redirects as they are
 *     (#1521); its 301 is an automatic Staged change that goes live with the
 *     Publish live that ships the rename;
 *   - Publish live applies exactly the changes its confirmation listed: a
 *     change saved after it (a new revision) waits for the next one;
 *   - a Staged change whose target the build going live does not serve
 *     stays Staged; a Draft survives every Publish live;
 *   - a rollback restores the live redirects the rolled-back release
 *     replaced and makes its changes Staged again, while a change that went
 *     live with Go live now stays live;
 *   - the scheduler tick's redirect retry never applies a pending change.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import type { RedirectReleasePlan } from "../ops/redirects_release.js";
import { retryRedirectSync } from "../redirect-sync-worker.js";
import { registerAdminOps } from "../register.js";
import { liveRedirects, pendingRedirects, wipeRedirects } from "./fixtures/redirects.js";
import { ensureRoleUser } from "./fixtures/role-user.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const OWNER_ID = "15500000-0000-4000-8000-0000000000a1";
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t1550-pl" };
const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1550-pl-sys",
};

const TPL = "t1550pl-tpl";
const MOD = "t1550pl-mod";
const HOME = "home";
const A = "t1550pg-a";
const TARGET = "t1550pg-target";
const LATER = "t1550pg-later";
const SLUGS = [HOME, A, `${A}-renamed`, TARGET, LATER];
const P = "/t1550pl";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let root: string;
let templateId = "";
let moduleId = "";
let pageA = "";
let pageLater = "";
let prevSkip: string | undefined;
let prevOutputRoot: string | undefined;
let restoreBaseUrl: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function wipe(): Promise<void> {
  await wipeRedirects(ADMIN_URL as string, P);
  await wipeRedirects(ADMIN_URL as string, "/t1550pg-");
  await asSystem(async (tx) => {
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug IN ${tx(SLUGS)})`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug IN ${tx(SLUGS)})`;
    await tx`DELETE FROM pages WHERE slug IN ${tx(SLUGS)}`;
    await tx`DELETE FROM modules WHERE slug = ${MOD}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL})`;
    await tx`DELETE FROM templates WHERE slug = ${TPL}`;
  });
}

async function page(slug: string, status: "published" | "draft"): Promise<string> {
  const { pageId } = await op<{ pageId: string }>(OWNER, "pages.create", {
    slug,
    title: slug,
    templateId,
  });
  await op(OWNER, "pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [moduleId] }],
  });
  await op(OWNER, "pages_seo.autofill", { pageId, metaDescription: `The ${slug} page.` });
  if (status === "published") await op(OWNER, "pages.update", { pageId, status: "published" });
  return pageId;
}

/** Stage (as the toolbar's Stage outside a chat does) and record a passed audit. */
async function stage(): Promise<string> {
  const { runId } = await op<{ runId: string }>(OWNER, "deploy.trigger", {
    targetName: "staging",
    repoRoot: root,
  });
  await asSystem(async (tx) => {
    await tx`
      INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
      VALUES (${runId}::uuid, ${OWNER_ID}::uuid, 'passed',
              '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())`;
  });
  return runId;
}

async function publishLive(
  redirectChanges?: { id: string; revision: number }[],
): Promise<{ toRunId: string; redirects: { wentLive: number; waiting: number } }> {
  return op(OWNER, "deploy.promote", {
    fromTarget: "staging",
    toTarget: "production",
    repoRoot: root,
    ...(redirectChanges ? { redirectChanges } : {}),
  });
}

const liveSnippet = () =>
  readFile(join(root, "output", "production", "current", "_redirects.caddy"), "utf8");

beforeAll(async () => {
  await wipe();
  restoreBaseUrl = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLanguage = await pinSiteLanguage(ADMIN_URL as string, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await ensureRoleUser(ADMIN_URL as string, OWNER_ID, "owner");
  root = await mkdtemp(join(tmpdir(), "caelo-1550-publish-"));
  prevSkip = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  // The release plan, the retry and Go live now read the builds where the
  // deploy ops write them.
  prevOutputRoot = process.env.CAELO_OUTPUT_ROOT;
  process.env.CAELO_OUTPUT_ROOT = root;
  ({ templateId } = await op<{ templateId: string }>(OWNER, "templates.create", {
    pageType: "home",
    slug: TPL,
    displayName: "T",
    html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  }));
  await op(OWNER, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  ({ moduleId } = await op<{ moduleId: string }>(OWNER, "modules.create", {
    slug: MOD,
    displayName: "M",
    html: "<p>t1550</p>",
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  }));
  await page(HOME, "published");
  pageA = await page(A, "published");
  await page(TARGET, "published");
  pageLater = await page(LATER, "draft");
});

afterAll(async () => {
  if (prevSkip === undefined) delete process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  else process.env.CAELO_SKIP_STAGING_SERVE_CHECK = prevSkip;
  if (prevOutputRoot === undefined) delete process.env.CAELO_OUTPUT_ROOT;
  else process.env.CAELO_OUTPUT_ROOT = prevOutputRoot;
  await wipe();
  await restoreBaseUrl?.();
  await restoreLanguage?.();
  await adapter.close();
  await rm(root, { recursive: true, force: true });
});

describe("redirects go live with Publish live (#1550)", () => {
  let firstRelease = "";

  it("a live page's rename stages its 301; the Stage leaves the live redirects as they are (#1521)", async () => {
    // The page is live first.
    await stage();
    firstRelease = (await publishLive()).toRunId;
    const liveBefore = await liveRedirects(ADMIN_URL as string, "/");
    await op(OWNER, "pages.update", { pageId: pageA, slug: `${A}-renamed` });
    expect(await liveRedirects(ADMIN_URL as string, "/")).toEqual(liveBefore);
    expect(await pendingRedirects(ADMIN_URL as string, `/${A}`)).toEqual([
      expect.objectContaining({
        fromPath: `/${A}`,
        toPath: `/${A}-renamed`,
        state: "staged",
        origin: "page_move",
      }),
    ]);
    await stage();
    expect(await liveRedirects(ADMIN_URL as string, "/")).toEqual(liveBefore);
    expect(await liveSnippet()).not.toContain(`/${A}`);
  });

  it("Publish live ships exactly the confirmed changes; a later revision, a waiting target and a Draft stay", async () => {
    // Manual changes: one that goes live, one to a draft page (waits), a Draft.
    await op(OWNER, "redirects.create_many", {
      redirects: [
        { fromPath: `${P}-go`, toPath: `/${TARGET}` },
        { fromPath: `${P}-wait`, toPath: `/${LATER}` },
        { fromPath: `${P}-bumped`, toPath: `/${TARGET}` },
      ],
    });
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-draft`, toPath: `/${TARGET}` }],
      goLive: "later",
    });
    const confirmation = await op<RedirectReleasePlan>(OWNER, "redirects.release_plan", {});
    expect(confirmation.problem).toBeNull();
    expect(confirmation.goingLive.map((c) => c.fromPath).sort()).toEqual([
      `/${A}`,
      `${P}-bumped`,
      `${P}-go`,
    ]);
    expect(confirmation.waiting.map((c) => [c.fromPath, c.reason])).toEqual([
      [`${P}-wait`, "target"],
    ]);
    expect(confirmation.draft.map((c) => c.fromPath)).toEqual([`${P}-draft`]);
    // Saved again after the confirmation: a new revision, not the one confirmed.
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-bumped`, toPath: "/", statusCode: 302 }],
      upsert: true,
    });
    const published = await publishLive(
      [...confirmation.goingLive, ...confirmation.waiting].map((c) => ({
        id: c.id,
        revision: c.revision,
      })),
    );
    expect(published.redirects.wentLive).toBe(2);
    expect(await liveRedirects(ADMIN_URL as string, `/${A}`)).toEqual([
      { fromPath: `/${A}`, toPath: `/${A}-renamed`, statusCode: 301 },
    ]);
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([
      { fromPath: `${P}-go`, toPath: `/${TARGET}`, statusCode: 301 },
    ]);
    expect(
      (await pendingRedirects(ADMIN_URL as string, P)).map((c) => [c.fromPath, c.state]),
    ).toEqual([
      [`${P}-bumped`, "staged"],
      [`${P}-draft`, "draft"],
      [`${P}-wait`, "staged"],
    ]);
    // The live hosting serves the live view, pushed after the release.
    const snippet = await liveSnippet();
    expect(snippet).toContain(`${P}-go`);
    expect(snippet).not.toContain(`${P}-wait`);
    expect(snippet).not.toContain(`${P}-draft`);
  });

  it("the scheduler tick's retry pushes the live table and applies no pending change", async () => {
    const before = await pendingRedirects(ADMIN_URL as string, P);
    await retryRedirectSync({ adapter, registry });
    expect(await pendingRedirects(ADMIN_URL as string, P)).toEqual(before);
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([
      { fromPath: `${P}-go`, toPath: `/${TARGET}`, statusCode: 301 },
    ]);
  });

  it("the waiting change goes live with the Publish live that ships its target", async () => {
    await op(OWNER, "pages.update", { pageId: pageLater, status: "published" });
    await stage();
    const published = await publishLive();
    expect(published.redirects.wentLive).toBe(2);
    expect((await liveRedirects(ADMIN_URL as string, P)).map((r) => r.fromPath)).toEqual([
      `${P}-bumped`,
      `${P}-go`,
      `${P}-wait`,
    ]);
    expect((await pendingRedirects(ADMIN_URL as string, P)).map((c) => c.fromPath)).toEqual([
      `${P}-draft`,
    ]);
  });

  it("a rollback restores what the rolled-back releases replaced, re-stages their changes and keeps Go live now's", async () => {
    await op(OWNER, "redirects.create_many", {
      redirects: [{ fromPath: `${P}-urgent`, toPath: `/${TARGET}` }],
    });
    await op(OWNER, "redirects.go_live_now", { fromPaths: [`${P}-urgent`], repoRoot: root });
    const back = await op<{
      redirects: { restored: number; restaged: number; skipped: unknown[] };
    }>(OWNER, "deploy.rollback", { targetName: "production", runId: firstRelease, repoRoot: root });
    expect(back.redirects.skipped).toEqual([]);
    expect(await liveRedirects(ADMIN_URL as string, P)).toEqual([
      { fromPath: `${P}-urgent`, toPath: `/${TARGET}`, statusCode: 301 },
    ]);
    expect(await liveRedirects(ADMIN_URL as string, `/${A}`)).toEqual([]);
    expect(
      (await pendingRedirects(ADMIN_URL as string, P)).map((c) => [c.fromPath, c.state]),
    ).toEqual([
      [`${P}-bumped`, "staged"],
      [`${P}-draft`, "draft"],
      [`${P}-go`, "staged"],
      [`${P}-wait`, "staged"],
    ]);
    expect(await pendingRedirects(ADMIN_URL as string, `/${A}`)).toEqual([
      expect.objectContaining({ fromPath: `/${A}`, state: "staged", origin: "page_move" }),
    ]);
  });
});

describe("Publish live refuses a release it cannot serve (#1550)", () => {
  it("names the loop and publishes nothing", async () => {
    await op(OWNER, "redirects.create_many", {
      redirects: [
        { fromPath: `${P}-loop-a`, toPath: `${P}-loop-b` },
        { fromPath: `${P}-loop-b`, toPath: `${P}-loop-a` },
      ],
    });
    await stage();
    const r = await execute(registry, adapter, OWNER, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: root,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("loop");
    await op(SYS, "redirects.set_changes_state", {
      fromPaths: [`${P}-loop-a`, `${P}-loop-b`],
      action: "discard",
    });
  });
});

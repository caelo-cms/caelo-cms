// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — plugin data reaches the static HTML without publishing anything
 * else. End to end on the self-hosted publisher: real generator, real
 * Postgres (both databases), real plugin host, a fixture plugin that bakes
 * guestbook entries and declares `bakedData`.
 *
 *   - an approval marks the page; the tick bakes it into the LIVE build:
 *     the region carries the entry, its `data-baked-at` (the delta feed's
 *     `since`) moves past it;
 *   - adversarial: main meanwhile holds an unpublished module edit, a new
 *     published page, an SEO change and a redirect — the plugin-data build
 *     carries none of them; every file but the page's is byte-identical to
 *     the published build, and that page is identical outside its region;
 *     a bake marker an editor wrote into module HTML is never rewritten;
 *   - many approvals in one tick produce one build; a tick with nothing
 *     pending records nothing;
 *   - forged visitor hints (an undeclared operation, an unknown page)
 *     schedule nothing; a declared visitor trigger does;
 *   - Publish live of a Stage older than a plugin-data build makes its
 *     bakes pending again, and re-baking data the HTML already carries
 *     publishes nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  resetPluginHost,
  resetPluginHostSync,
  runPluginOperation,
  syncPluginHost,
} from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { CADDY_REDIRECTS_FILE, type ExecutionContext } from "@caelo-cms/shared";
import { findBakeRegions, replaceBakeRegions } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import { PLUGIN_DATA_ARCHIVES_KEPT } from "../plugin-data/build.js";
import { runPluginDataBuildIfDue } from "../plugin-data/worker.js";
import { publishProjectionOnce } from "../public-projection.js";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const HUMAN: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "human",
  requestId: "t1155-plugin-data",
};
const PLUGIN = "t1155-guestbook";
const TPL_SLUG = "t1155-tpl";
const MOD_TEXT = "t1155-text";
const MOD_WIDGET = "t1155-widget";
const HOME_SLUG = "home";
const ABOUT_SLUG = "t1155-about";
const SECRET_SLUG = "t1155-unpublished";
const UNKNOWN_PAGE = "11550000-0000-4000-8000-000000000001";
const GHOST = "t1155-ghost";

/** What the fixture plugin bakes; the test appends as "approvals" happen. */
const entries: string[] = ["first entry"];

const guestbook = definePlugin({
  slug: PLUGIN,
  version: "0.1.0",
  tier: 1,
  schema: {},
  publicOperations: ["vote", "noop"],
  operations: {
    approve: async (_ctx, args) => {
      const a = args as { pageId: string; text: string };
      entries.push(a.text);
      return { pageId: a.pageId };
    },
    vote: async (_ctx, args) => ({ pageId: (args as { pageId: string }).pageId }),
    noop: async (_ctx, args) => ({ pageId: (args as { pageId: string }).pageId }),
  },
  staticRender: async () => entries.map((e) => `<p class="entry">${e}</p>`).join(""),
  // The build's bake cache key: without it a Stage would reuse its first bake.
  metaSignature: async () => String(entries.length),
  bakedData: {
    description: "Approved guestbook entries, baked into their page.",
    triggers: [
      { operation: "approve", pageIds: { from: "result", key: "pageId" } },
      { operation: "vote", pageIds: { from: "args", key: "pageId" } },
    ],
  },
});

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let homeId = "";
let textModuleId = "";
let pluginId = "";
let prevSkipServeCheck: string | undefined;
let prevOutputRoot: string | undefined;
let restoreSiteBaseUrl: (() => Promise<void>) | null = null;
let restoreSiteLanguage: (() => Promise<void>) | null = null;

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

/** Insert visitor op events the way the gateway does (public_role, no read back). */
async function asGateway(fn: (tx: Bun.SQL) => Promise<unknown>): Promise<void> {
  const sql = new SQL(PUBLIC_URL as string);
  try {
    await sql.begin(async (tx) => {
      await fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  resetPluginHost();
  resetPluginHostSync();
  const slugs = [HOME_SLUG, ABOUT_SLUG, SECRET_SLUG];
  await sqlSystem(async (tx) => {
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM plugin_data_stale_pages`;
    await tx`UPDATE plugin_data_build_state SET visitor_event_watermark = 0, last_tick_at = NULL, last_outcome = NULL, last_message = NULL WHERE id = 1`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM redirects WHERE from_path = '/t1155-old'`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug IN ${tx(slugs)})`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug IN ${tx(slugs)})`;
    await tx`DELETE FROM pages WHERE slug IN ${tx(slugs)}`;
    await tx`DELETE FROM modules WHERE slug IN (${MOD_TEXT}, ${MOD_WIDGET})`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
    await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    await tx`DELETE FROM plugin_runtime WHERE plugin_slug = ${PLUGIN}`;
    await tx`DELETE FROM plugin_errors WHERE plugin_slug = ${PLUGIN}`;
    await tx`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN})`;
    await tx`DELETE FROM plugins WHERE slug IN (${PLUGIN}, ${GHOST})`;
  });
}

async function ok<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, HUMAN, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function markAudited(deployRunId: string): Promise<void> {
  await sqlSystem(async (tx) => {
    await tx`
      INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
      VALUES (${deployRunId}::uuid, ${SYSTEM_ACTOR_ID}::uuid, 'passed',
              '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())`;
  });
}

/** Stage, pass its audit, Publish live. Returns the production run. */
async function stageAndPublish(): Promise<{ id: string; buildId: string }> {
  const staged = await ok<{ runId: string }>("deploy.trigger", {
    targetName: "staging",
    repoRoot: testRoot,
  });
  await markAudited(staged.runId);
  const promoted = await ok<{ toRunId: string; buildId: string }>("deploy.promote", {
    fromTarget: "staging",
    toTarget: "production",
    repoRoot: testRoot,
  });
  const rows = await sqlSystem(
    async (tx) =>
      (await tx`SELECT build_id FROM deploy_runs WHERE id = ${promoted.toRunId}::uuid`) as {
        build_id: string;
      }[],
  );
  return { id: promoted.toRunId, buildId: rows[0]?.build_id ?? "" };
}

async function tick() {
  return runPluginDataBuildIfDue({ adapter, registry, minIntervalSeconds: 0, repoRoot: testRoot });
}

async function approve(text: string): Promise<void> {
  const r = await runPluginOperation({
    pluginSlug: PLUGIN,
    operationName: "approve",
    args: { pageId: homeId, text },
    invocation: { origin: "owner-panel", actorId: SYSTEM_ACTOR_ID },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
}

async function filesUnder(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (rel: string): Promise<void> => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child);
      else out.set(child, await readFile(join(dir, child)));
    }
  };
  await walk("");
  return out;
}

const productionDir = () => join(testRoot, "output", "production");

async function homeOutputPath(buildDir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(buildDir, "routing-manifest.json"), "utf8")) as {
    pages: { pageId?: string; outputPath: string }[];
  };
  const page = manifest.pages.find((p) => p.pageId === homeId);
  if (!page) throw new Error("home is not in the routing manifest");
  return page.outputPath;
}

async function pluginDataRuns() {
  return sqlSystem(
    async (tx) =>
      (await tx`
        SELECT id::text AS id, status, build_kind, base_run_id::text AS base_run_id, build_id,
               page_count, file_count, plugin_data
        FROM deploy_runs WHERE build_kind = 'plugin_data' ORDER BY started_at
      `) as {
        id: string;
        status: string;
        build_kind: string;
        base_run_id: string;
        build_id: string;
        page_count: number;
        file_count: number;
      }[],
  );
}

async function pendingMarks(): Promise<number> {
  const rows = await sqlSystem(
    async (tx) =>
      (await tx`
        SELECT count(*)::int AS n FROM plugin_data_stale_pages
        WHERE baked_through IS NULL OR last_marked_at > baked_through
      `) as { n: number }[],
  );
  return rows[0]?.n ?? -1;
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
  const home = await ok<{ pageId: string }>("pages.create", {
    slug: HOME_SLUG,
    title: "Home",
    templateId,
  });
  homeId = home.pageId;
  // A bake marker an editor (or the AI) typed into module HTML: it must
  // never open a region a plugin-data build rewrites.
  const text = await ok<{ moduleId: string }>("modules.create", {
    slug: MOD_TEXT,
    displayName: "Text",
    html: `<p>published text</p><!--caelo-bake:${PLUGIN}:${homeId}:0.1.0-->EDITOR TEXT<!--/caelo-bake:${PLUGIN}:${homeId}-->`,
    fields: [],
  });
  textModuleId = text.moduleId;
  const widget = await ok<{ moduleId: string }>("modules.create", {
    slug: MOD_WIDGET,
    displayName: "Guestbook",
    html: `<section><div data-caelo-plugin="${PLUGIN}" data-page-id="${homeId}"></div></section>`,
    fields: [],
  });
  await ok("pages.set_modules", {
    pageId: homeId,
    blocks: [{ blockName: "content", moduleIds: [text.moduleId, widget.moduleId] }],
  });
  await ok("pages.update", { pageId: homeId, status: "published" });
  await ok("pages_seo.autofill", { pageId: homeId, metaDescription: "The published home page." });
  const about = await ok<{ pageId: string }>("pages.create", {
    slug: ABOUT_SLUG,
    title: "About",
    templateId,
  });
  await ok("pages.set_modules", {
    pageId: about.pageId,
    blocks: [{ blockName: "content", moduleIds: [text.moduleId] }],
  });
  await ok("pages.update", { pageId: about.pageId, status: "published" });
  await ok("pages_seo.autofill", { pageId: about.pageId, metaDescription: "About us." });
}

beforeAll(async () => {
  await wipe();
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreSiteLanguage = await pinSiteLanguage(ADMIN_URL as string, "en");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-t1155-"));
  prevSkipServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  prevOutputRoot = process.env.CAELO_OUTPUT_ROOT;
  process.env.CAELO_OUTPUT_ROOT = testRoot;
  await seedSite();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: guestbook }],
  });
  expect(report.failed).toEqual([]);
  await syncPluginHost(true);
  const rows = await sqlSystem(
    async (tx) =>
      (await tx`SELECT id::text AS id FROM plugins WHERE slug = ${PLUGIN}`) as { id: string }[],
  );
  pluginId = rows[0]?.id ?? "";
  // The gateway may record op events only for a plugin the admin published.
  await publishProjectionOnce(adapter, { declarations: new Map() });
});

afterAll(async () => {
  if (prevSkipServeCheck === undefined) delete process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  else process.env.CAELO_SKIP_STAGING_SERVE_CHECK = prevSkipServeCheck;
  if (prevOutputRoot === undefined) delete process.env.CAELO_OUTPUT_ROOT;
  else process.env.CAELO_OUTPUT_ROOT = prevOutputRoot;
  await wipe();
  await restoreSiteBaseUrl?.();
  await restoreSiteLanguage?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("#1155 — plugin data reaches the HTML without publishing anything else", () => {
  let published = { id: "", buildId: "" };
  let firstPluginRun = "";

  it("nothing is pending before an approval", async () => {
    published = await stageAndPublish();
    const r = await tick();
    expect(r.outcome).toBe("nothing_pending");
    expect(await pluginDataRuns()).toEqual([]);
  });

  it("an approval marks its page as stale", async () => {
    await approve("second entry");
    const rows = await sqlSystem(
      async (tx) =>
        (await tx`
          SELECT page_id::text AS page_id, last_source, baked_through
          FROM plugin_data_stale_pages WHERE plugin_id = ${pluginId}::uuid
        `) as { page_id: string; last_source: string; baked_through: unknown }[],
    );
    expect(rows).toEqual([{ page_id: homeId, last_source: "operation", baked_through: null }]);
  });

  it("bakes the approval into the live build and carries no unpublished change", async () => {
    // main moves on without a Publish live: a module edit, a new published
    // page, an SEO change and a redirect.
    await ok("modules.update", {
      moduleId: textModuleId,
      html: `<p>UNPUBLISHED EDIT</p><!--caelo-bake:${PLUGIN}:${homeId}:0.1.0-->EDITOR TEXT<!--/caelo-bake:${PLUGIN}:${homeId}-->`,
    });
    const { templateId } = (
      await sqlSystem(
        async (tx) =>
          (await tx`SELECT id::text AS "templateId" FROM templates WHERE slug = ${TPL_SLUG}`) as {
            templateId: string;
          }[],
      )
    )[0] as { templateId: string };
    const secret = await ok<{ pageId: string }>("pages.create", {
      slug: SECRET_SLUG,
      title: "Not published",
      templateId,
    });
    await ok("pages.update", { pageId: secret.pageId, status: "published" });
    await ok("pages_seo.autofill", { pageId: secret.pageId, metaDescription: "Secret." });
    await ok("pages_seo.set", { pageId: homeId, metaDescription: "UNPUBLISHED SEO" });
    await ok("redirects.create_many", {
      redirects: [{ fromPath: "/t1155-old", toPath: "/", statusCode: 301 }],
    });

    const base = await filesUnder(join(productionDir(), "builds", published.buildId));
    const homePath = await homeOutputPath(join(productionDir(), "builds", published.buildId));
    const baseHome = base.get(homePath)?.toString("utf8") ?? "";
    const baseRegion = findBakeRegions(baseHome).find((r) => r.slug === PLUGIN);
    expect(baseHome).toContain("first entry");
    expect(baseHome).not.toContain("second entry");

    const r = await tick();
    expect(r.outcome).toBe("built");
    expect(r.runIds).toHaveLength(1);
    firstPluginRun = r.runIds[0] ?? "";

    const [run] = await pluginDataRuns();
    expect(run).toMatchObject({
      id: firstPluginRun,
      status: "succeeded",
      build_kind: "plugin_data",
      base_run_id: published.id,
      build_id: firstPluginRun,
      page_count: 1,
      file_count: 1,
    });

    const live = await filesUnder(join(productionDir(), "current"));
    // A saved redirect is not draft state (#1157): it is live on save, so
    // the release re-syncs the redirect files over the build's own copy.
    const redirectFiles = new Set(["_redirects", "_redirects.cloudflare", CADDY_REDIRECTS_FILE]);
    expect(live.get(CADDY_REDIRECTS_FILE)?.toString("utf8")).toContain("/t1155-old");
    // Same files as the published build: no new page …
    expect([...live.keys()].sort()).toEqual([...base.keys()].sort());
    for (const [path, body] of base) {
      if (path === homePath || redirectFiles.has(path)) continue;
      expect({ path, same: live.get(path)?.equals(body) }).toEqual({ path, same: true });
    }
    // … and the page differs only inside the plugin's region.
    const liveHome = live.get(homePath)?.toString("utf8") ?? "";
    const strip = (html: string) => replaceBakeRegions(html, () => "");
    expect(strip(liveHome)).toBe(strip(baseHome));
    expect(liveHome).toContain("second entry");
    for (const unpublished of ["UNPUBLISHED EDIT", "UNPUBLISHED SEO", SECRET_SLUG, "t1155-old"]) {
      expect(liveHome).not.toContain(unpublished);
    }
    expect(
      [...live.entries()].some(
        ([path, b]) => !redirectFiles.has(path) && b.toString("utf8").includes("t1155-old"),
      ),
    ).toBe(false);
    // The marker an editor typed stays text, untouched.
    expect(liveHome).toContain("EDITOR TEXT");
    // The delta feed's `since` moved past the approval.
    const liveRegion = findBakeRegions(liveHome).find((x) => x.slug === PLUGIN);
    expect(liveRegion?.version).toBe("0.1.0");
    expect(Date.parse(liveRegion?.bakedAt ?? "")).toBeGreaterThan(
      Date.parse(baseRegion?.bakedAt ?? ""),
    );
  });

  it("the run lists as a plugin-data build and is audited", async () => {
    const { runs } = await ok<{ runs: { id: string; buildKind: string }[] }>("deploy.list_runs", {
      limit: 10,
    });
    expect(runs.find((x) => x.id === firstPluginRun)?.buildKind).toBe("plugin_data");
    const audit = await sqlSystem(
      async (tx) =>
        (await tx`
          SELECT result_summary FROM audit_events
          WHERE operation = 'deploy.build_plugin_data' AND entity_id = ${firstPluginRun}::uuid
        `) as { result_summary: string }[],
    );
    expect(audit.map((a) => a.result_summary)).toEqual(["built"]);
  });

  it("a tick with nothing pending publishes nothing", async () => {
    const r = await tick();
    expect(r.outcome).toBe("nothing_pending");
    expect(await pluginDataRuns()).toHaveLength(1);
  });

  it("many approvals in one tick produce one build", async () => {
    await approve("third entry");
    await approve("fourth entry");
    await approve("fifth entry");
    const r = await tick();
    expect(r.outcome).toBe("built");
    expect(r.runIds).toHaveLength(1);
    const runs = await pluginDataRuns();
    expect(runs).toHaveLength(2);
    // Built on the previous plugin-data build, the one that was live.
    expect(runs[1]?.base_run_id).toBe(firstPluginRun);
    const home = (await filesUnder(join(productionDir(), "current"))).get(
      await homeOutputPath(join(productionDir(), "current")),
    );
    for (const e of ["third entry", "fourth entry", "fifth entry"]) {
      expect(home?.toString("utf8")).toContain(e);
    }
  });

  it("forged visitor hints schedule nothing", async () => {
    await asGateway(async (tx) => {
      // An operation the plugin does not declare as a trigger …
      await tx`INSERT INTO gateway_plugin_op_events (plugin_id, operation, input_hash, succeeded, page_id)
               VALUES (${pluginId}::uuid, ${`${PLUGIN}.noop`}, ${"a".repeat(64)}, true, ${homeId}::uuid)`;
      // … and the declared one naming a page that does not exist.
      await tx`INSERT INTO gateway_plugin_op_events (plugin_id, operation, input_hash, succeeded, page_id)
               VALUES (${pluginId}::uuid, ${`${PLUGIN}.vote`}, ${"b".repeat(64)}, true, ${UNKNOWN_PAGE}::uuid)`;
    });
    entries.push("visitor entry");
    const r = await tick();
    expect(r.hintedPages).toBe(0);
    expect(r.outcome).toBe("nothing_pending");
    expect(await pluginDataRuns()).toHaveLength(2);
  });

  it("a declared visitor trigger naming a real page schedules a build", async () => {
    await asGateway(async (tx) => {
      await tx`INSERT INTO gateway_plugin_op_events (plugin_id, operation, input_hash, succeeded, page_id)
               VALUES (${pluginId}::uuid, ${`${PLUGIN}.vote`}, ${"c".repeat(64)}, true, ${homeId}::uuid)`;
    });
    const r = await tick();
    expect(r.hintedPages).toBe(1);
    expect(r.outcome).toBe("built");
    const rows = await sqlSystem(
      async (tx) =>
        (await tx`SELECT last_source FROM plugin_data_stale_pages WHERE page_id = ${homeId}::uuid`) as {
          last_source: string;
        }[],
    );
    expect(rows[0]?.last_source).toBe("visitor");
  });

  it("a Stage built before a plugin-data build and published after it gets the data re-baked", async () => {
    const staged = await ok<{ runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await markAudited(staged.runId);
    await approve("sixth entry");
    expect((await tick()).outcome).toBe("built");
    // Publish live of the older Stage: its HTML lacks the sixth entry.
    await ok("deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    const livePath = await homeOutputPath(join(productionDir(), "current"));
    const homeAfterPromote = (await filesUnder(join(productionDir(), "current"))).get(livePath);
    expect(homeAfterPromote?.toString("utf8")).not.toContain("sixth entry");
    expect(await pendingMarks()).toBe(1);
    expect((await tick()).outcome).toBe("built");
    const home = (await filesUnder(join(productionDir(), "current"))).get(livePath);
    expect(home?.toString("utf8")).toContain("sixth entry");
  });

  it("re-baking data the HTML already carries publishes nothing", async () => {
    await approve("seventh entry");
    // A human publishes after the approval: the Stage baked it already.
    await stageAndPublish();
    expect(await pendingMarks()).toBe(1);
    const before = (await pluginDataRuns()).length;
    const r = await tick();
    expect(r.outcome).toBe("unchanged");
    expect(await pluginDataRuns()).toHaveLength(before);
    expect(await pendingMarks()).toBe(0);
  });

  it("a live build another Caelo release rendered waits for the next Publish live", async () => {
    await approve("eighth entry");
    const live = await sqlSystem(
      async (tx) =>
        (await tx`
          SELECT r.id::text AS id, r.caelo_version FROM deploy_runs r
          JOIN deploy_targets t ON t.id = r.target_id
          WHERE t.env = 'production' AND r.status = 'succeeded'
          ORDER BY r.finished_at DESC LIMIT 1
        `) as { id: string; caelo_version: string }[],
    );
    const run = live[0] as { id: string; caelo_version: string };
    await sqlSystem(
      (tx) => tx`UPDATE deploy_runs SET caelo_version = '0.0.1-old' WHERE id = ${run.id}::uuid`,
    );
    const blocked = await tick();
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.message).toContain("next Publish live");
    expect(await pendingMarks()).toBe(1);
    await sqlSystem(
      (tx) =>
        tx`UPDATE deploy_runs SET caelo_version = ${run.caelo_version} WHERE id = ${run.id}::uuid`,
    );
    expect((await tick()).outcome).toBe("built");
  });

  it("a plugin that is not running keeps its marks until it runs again (#1008)", async () => {
    await approve("ninth entry");
    // Active, and failing to load on another live server.
    await sqlSystem(async (tx) => {
      const [e] = (await tx`
        INSERT INTO plugin_errors (plugin_slug, plugin_id, fingerprint, phase, error_class, message, last_instance)
        VALUES (${PLUGIN}, ${pluginId}::uuid, ${"e".repeat(64)}, 'register', 'plugin', 'boom', 'other-1')
        RETURNING id::text AS id`) as { id: string }[];
      await tx`
        INSERT INTO plugin_runtime (instance_id, plugin_slug, state, error_id)
        VALUES ('other-1', ${PLUGIN}, 'error', ${e?.id ?? ""}::uuid)`;
    });
    try {
      const blocked = await tick();
      expect(blocked.outcome).toBe("blocked");
      expect(blocked.message).toContain(`Waiting for "${PLUGIN}"`);
      expect(await pendingMarks()).toBe(1);
    } finally {
      await sqlSystem(async (tx) => {
        await tx`DELETE FROM plugin_runtime WHERE instance_id = 'other-1'`;
        await tx`DELETE FROM plugin_errors WHERE last_instance = 'other-1'`;
      });
    }
    expect((await tick()).outcome).toBe("built");
  });

  it("a region another plugin version rendered is left for the next Publish live", async () => {
    await approve("tenth entry");
    // Rewrite the live page as if version 0.0.9 had rendered its region.
    const current = join(productionDir(), "current");
    const path = await homeOutputPath(current);
    const liveRow = (
      await sqlSystem(
        async (tx) =>
          (await tx`
            SELECT build_id FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
            WHERE t.env = 'production' AND r.status = 'succeeded'
            ORDER BY r.finished_at DESC LIMIT 1
          `) as { build_id: string }[],
      )
    )[0] as { build_id: string };
    const archived = join(productionDir(), "builds", liveRow.build_id, path);
    const html = await readFile(archived, "utf8");
    const old = html.replace(
      `<!--caelo-bake:${PLUGIN}:${homeId}:0.1.0-->`,
      `<!--caelo-bake:${PLUGIN}:${homeId}:0.0.9-->`,
    );
    expect(old).not.toBe(html);
    await writeFile(archived, old, "utf8");
    const r = await tick();
    expect(r.outcome).toBe("unchanged");
    expect(r.message).toContain(`${PLUGIN}@0.0.9`);
    const after = await readFile(archived, "utf8");
    expect(after).not.toContain("tenth entry");
    // Back to the running version's region; the next tick bakes the entry.
    await writeFile(archived, html, "utf8");
    await approve("tenth entry, again");
    expect((await tick()).outcome).toBe("built");
  });

  it("a plugin that cannot render does not take the batch from one that can (review #1170)", async () => {
    // An active plugin this host does not run, with the OLDEST stale mark.
    await sqlSystem(async (tx) => {
      const [g] = (await tx`
        INSERT INTO plugins (slug, version, tier, status, manifest_json, manifest_signature, submitted_by, activated_at)
        VALUES (${GHOST}, '0.1.0', 1, 'active', '{}'::jsonb, 'sig', ${SYSTEM_ACTOR_ID}::uuid, now())
        RETURNING id::text AS id`) as { id: string }[];
      await tx`
        INSERT INTO plugin_data_stale_pages (plugin_id, page_id, first_marked_at, last_marked_at, last_source)
        VALUES (${g?.id ?? ""}::uuid, ${homeId}::uuid, now() - interval '1 day', now() - interval '1 day', 'operation')`;
    });
    try {
      await approve("eleventh entry");
      // A batch of one: before the fix it was always the ghost's mark.
      const r = await runPluginDataBuildIfDue({
        adapter,
        registry,
        minIntervalSeconds: 0,
        maxMarks: 1,
        repoRoot: testRoot,
      });
      expect(r.outcome).toBe("built");
      expect(r.message).toContain("Waiting for");
      const home = (await filesUnder(join(productionDir(), "current"))).get(
        await homeOutputPath(join(productionDir(), "current")),
      );
      expect(home?.toString("utf8")).toContain("eleventh entry");
    } finally {
      await sqlSystem((tx) => tx`DELETE FROM plugins WHERE slug = ${GHOST}`);
    }
  });

  it("keeps a bounded number of plugin-data archives (review #1170)", async () => {
    for (let i = 0; i < PLUGIN_DATA_ARCHIVES_KEPT + 2; i += 1) {
      await approve(`retention entry ${i}`);
      expect((await tick()).outcome).toBe("built");
    }
    const runs = await pluginDataRuns();
    expect(runs.length).toBeGreaterThan(PLUGIN_DATA_ARCHIVES_KEPT + 2);
    const dirs = new Set(await readdir(join(productionDir(), "builds")));
    const archived = runs.filter((r) => dirs.has(r.build_id));
    // The live one, the newest and the kept older ones — nothing more.
    expect(archived.length).toBeLessThanOrEqual(PLUGIN_DATA_ARCHIVES_KEPT + 2);
    expect(dirs.has(runs.at(-1)?.build_id ?? "")).toBe(true);
  });

  it("publication history is not crowded out by plugin-data builds (review #1170)", async () => {
    const all = await ok<{ runs: { buildKind: string }[] }>("deploy.list_runs", { limit: 1 });
    expect(all.runs[0]?.buildKind).toBe("plugin_data");
    const site = await ok<{ runs: { buildKind: string; targetName: string }[] }>(
      "deploy.list_runs",
      { limit: 2, buildKind: "site" },
    );
    expect(site.runs.map((r) => r.buildKind)).toEqual(["site", "site"]);
  });

  it("after a rollback, plugin data keeps reaching the HTML (review #1170)", async () => {
    await ok("deploy.rollback", {
      targetName: "production",
      runId: published.id,
      repoRoot: testRoot,
    });
    // The rollback run carries the restored build's Caelo version …
    const rows = await sqlSystem(
      async (tx) =>
        (await tx`
          SELECT r.caelo_version FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
          WHERE t.env = 'production' AND r.status = 'succeeded'
          ORDER BY r.finished_at DESC LIMIT 1
        `) as { caelo_version: string | null }[],
    );
    expect(rows[0]?.caelo_version).not.toBeNull();
    // … so the next tick re-bakes on top of it instead of blocking.
    const r = await tick();
    expect(r.outcome).toBe("built");
    const home = (await filesUnder(join(productionDir(), "current"))).get(
      await homeOutputPath(join(productionDir(), "current")),
    );
    expect(home?.toString("utf8")).toContain("eleventh entry");
  });

  it("#1220 a tick skips while another run releases the live site, and bakes on the next one", async () => {
    await approve("twelfth entry");
    // A Publish live (or another plugin-data build) holds the live-release
    // lease as its run, with no transaction open: the tick does not wait.
    const holder = crypto.randomUUID();
    await sqlSystem(async (tx) => {
      await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, lease_expires_at)
               SELECT ${holder}::uuid, id, ${SYSTEM_ACTOR_ID}::uuid, 'running',
                      clock_timestamp() + interval '10 minutes'
               FROM deploy_targets WHERE env = 'production' LIMIT 1`;
      await tx`INSERT INTO deploy_leases (name, holder_run_id, acquired_at, expires_at)
               VALUES ('live-release', ${holder}::uuid, clock_timestamp(),
                       clock_timestamp() + interval '10 minutes')
               ON CONFLICT (name) DO UPDATE SET holder_run_id = EXCLUDED.holder_run_id,
                 acquired_at = EXCLUDED.acquired_at, expires_at = EXCLUDED.expires_at`;
    });
    const before = await pluginDataRuns();
    try {
      const busy = await tick();
      expect(busy.outcome).toBe("busy");
      expect(busy.message).toContain(holder);
      expect(busy.runIds).toEqual([]);
      // Nothing recorded, the mark still pending.
      expect(await pluginDataRuns()).toHaveLength(before.length);
      const pending = await sqlSystem(
        async (tx) =>
          (await tx`SELECT count(*)::int AS n FROM plugin_data_stale_pages
                    WHERE baked_through IS NULL OR last_marked_at > baked_through`) as {
            n: number;
          }[],
      );
      expect(pending[0]?.n).toBeGreaterThan(0);
    } finally {
      await sqlSystem(async (tx) => {
        await tx`UPDATE deploy_leases SET holder_run_id = NULL, acquired_at = NULL, expires_at = NULL
                 WHERE holder_run_id = ${holder}::uuid`;
        await tx`DELETE FROM deploy_runs WHERE id = ${holder}::uuid`;
      });
    }
    const built = await tick();
    expect(built.outcome).toBe("built");
    expect(await pluginDataRuns()).toHaveLength(before.length + 1);
    const home = (await filesUnder(join(productionDir(), "current"))).get(
      await homeOutputPath(join(productionDir(), "current")),
    );
    expect(home?.toString("utf8")).toContain("twelfth entry");
    const lease = await sqlSystem(
      async (tx) =>
        (await tx`SELECT holder_run_id FROM deploy_leases WHERE name = 'live-release'`) as {
          holder_run_id: string | null;
        }[],
    );
    expect(lease[0]?.holder_run_id ?? null).toBeNull();
  });
});

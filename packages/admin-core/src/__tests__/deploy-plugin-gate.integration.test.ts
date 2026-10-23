// SPDX-License-Identifier: MPL-2.0

/**
 * #1008 — the site never goes live without an active plugin.
 *
 * A plugin that fails to load stays active and editing keeps working, but
 * a build made without it lacks its output. End to end on the self-hosted
 * publisher (real generator, real Postgres, real plugin host):
 *   - a Stage with an active plugin not running succeeds, reports it, and
 *     records it on the run;
 *   - Publish live is refused while the plugin is not running;
 *   - after the plugin recovered (plugins.reload), Publish live of THAT
 *     Stage is still refused — it was built without the plugin — with a
 *     "Stage again" next step;
 *   - a new Stage publishes;
 *   - a direct production build is refused while a plugin is not running,
 *     and the refusal is recorded as a failed run;
 *   - the editor preview carries a `plugin-not-running:<slug>` marker.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  resetPluginHost,
  resetPluginHostSync,
  syncPluginHost,
} from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
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

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const HUMAN: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1008-deploy-gate",
};
const PLUGIN = "t1008g-links";
const TPL_SLUG = "t1008g-tpl";
const MOD_SLUG = "t1008g-mod";
const HOME_SLUG = "home";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let homeId = "";
let pluginHealthy = false;
let prevSkipServeCheck: string | undefined;
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

async function wipe(): Promise<void> {
  resetPluginHost();
  resetPluginHostSync();
  await sqlSystem(async (tx) => {
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug = ${HOME_SLUG})`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${HOME_SLUG})`;
    await tx`DELETE FROM pages WHERE slug = ${HOME_SLUG}`;
    await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
    await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    await tx`DELETE FROM plugin_runtime WHERE plugin_slug = ${PLUGIN}`;
    await tx`DELETE FROM plugin_errors WHERE plugin_slug = ${PLUGIN}`;
    await tx`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN})`;
    await tx`DELETE FROM plugins WHERE slug = ${PLUGIN}`;
  });
}

async function markAudited(deployRunId: string): Promise<void> {
  await sqlSystem(async (tx) => {
    await tx`
      INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
      VALUES (${deployRunId}::uuid, ${SYSTEM_ACTOR_ID}::uuid, 'passed',
              '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())`;
  });
}

async function ok<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, HUMAN, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function refusal(op: string, input: unknown): Promise<string> {
  const r = await execute(registry, adapter, HUMAN, op, input);
  if (r.ok) throw new Error(`${op} unexpectedly succeeded`);
  return "message" in r.error ? String(r.error.message) : r.error.kind;
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
    html: "<p>gate</p>",
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  const { pageId } = await ok<{ pageId: string }>("pages.create", {
    slug: HOME_SLUG,
    title: "Home",
    templateId,
  });
  homeId = pageId;
  await ok("pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [moduleId] }],
  });
  await ok("pages.update", { pageId, status: "published" });
  await ok("pages_seo.autofill", { pageId, metaDescription: "The home page." });
}

beforeAll(async () => {
  await wipe();
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreSiteLanguage = await pinSiteLanguage(ADMIN_URL as string, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-t1008-gate-"));
  prevSkipServeCheck = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  await seedSite();
  // An active plugin whose onActivate fails until the test says otherwise.
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [
      {
        definition: definePlugin({
          slug: PLUGIN,
          version: "0.1.0",
          tier: 1,
          schema: {},
          operations: { noop: async () => ({}) },
          onActivate: async () => {
            if (!pluginHealthy) throw new Error("link service unreachable");
          },
        }),
      },
    ],
  });
  expect(report.failed.map((f) => f.slug)).toEqual([PLUGIN]);
  await syncPluginHost(true);
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

describe("#1008 — Publish live never ships without an active plugin", () => {
  let staleStageRunId = "";

  it("the editor preview says the plugin is not running", async () => {
    const rendered = await ok<{ missingSlots: string[] }>("pages.render_preview", {
      pageId: homeId,
    });
    expect(rendered.missingSlots).toContain(`plugin-not-running:${PLUGIN}`);
  });

  it("a Stage succeeds, reports the plugin and records it on the run", async () => {
    const staged = await ok<{ runId: string; pluginProblems: { slug: string }[] }>(
      "deploy.trigger",
      { targetName: "staging", repoRoot: testRoot },
    );
    expect(staged.pluginProblems.map((p) => p.slug)).toEqual([PLUGIN]);
    staleStageRunId = staged.runId;
    await markAudited(staged.runId);
    const recorded = await sqlSystem(
      async (tx) =>
        (await tx`SELECT plugin_problems FROM deploy_runs WHERE id = ${staged.runId}::uuid`) as {
          plugin_problems: { slug: string }[];
        }[],
    );
    expect(recorded[0]?.plugin_problems.map((p) => p.slug)).toEqual([PLUGIN]);
  });

  it("Publish live is refused while the plugin is not running", async () => {
    const message = await refusal("deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    // The Stage itself already lacks the plugin, so that is the first reason.
    expect(message).toContain(`"${PLUGIN}"`);
    expect(message).toContain("Stage again");
  });

  it("a direct production build is refused and recorded as a failed run", async () => {
    const message = await refusal("deploy.trigger", {
      targetName: "production",
      repoRoot: testRoot,
    });
    expect(message).toContain("Publish live is blocked");
    expect(message).toContain("reload_plugin");
    const failed = await sqlSystem(
      async (tx) =>
        (await tx`
          SELECT r.error_message FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
          WHERE t.env = 'production' AND r.status = 'failed' ORDER BY r.started_at DESC LIMIT 1
        `) as { error_message: string }[],
    );
    expect(failed[0]?.error_message).toContain("Blocked, plugins not running");
  });

  it("after a reload, the stale Stage is still refused; a new Stage publishes", async () => {
    pluginHealthy = true;
    await ok("plugins.reload", { slug: PLUGIN });
    const stale = await refusal("deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    expect(stale).toContain("This Stage was built while");
    expect(staleStageRunId).not.toBe("");

    const fresh = await ok<{ runId: string; pluginProblems: unknown[] }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    expect(fresh.pluginProblems).toEqual([]);
    await markAudited(fresh.runId);
    await ok("deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });

    const rendered = await ok<{ missingSlots: string[] }>("pages.render_preview", {
      pageId: homeId,
    });
    expect(rendered.missingSlots).not.toContain(`plugin-not-running:${PLUGIN}`);
  });
});

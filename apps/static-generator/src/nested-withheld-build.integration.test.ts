// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1708 — a module a plugin withholds (a consent-gated video) inside
 * another module's `module` field.
 *
 * Only a module placed on the page directly can be parked behind the
 * plugin's gate, so the nested one cannot render. The composer used to
 * throw on it, which stopped every Stage of the site ("generator failed:
 * … where it cannot be gated"), although a Stage never stops on content
 * it cannot render (CLAUDE.md §2, #1604). Pinned here, through the real
 * plugin host and generator against a throwaway Postgres:
 *
 *   - a full staging build ships the page without the nested module (no
 *     markup, CSS or JS of it, so the embed loads nowhere) and reports it
 *     as `nested-module-withheld` with the page, the module and the field;
 *   - every other build stops on it, naming it (Publish live refuses the
 *     Stage through its render report, deploy/render-failures.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { bootstrap, localBuildPluginServices, resetPluginHost } from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { type DeployTarget, generateSite, pageOutputPath } from "./generate.js";
import { RenderFailureError } from "./nested-modules-pass.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYSTEM: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "nested-withheld-build-test",
};

const PFX = `nwb-${Date.now().toString(36)}`;
const GATE = "t1708-gate";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";
let videoModuleId = "";
let baseBefore: string | null = null;
let languageBefore: string | null = null;

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  resetPluginHost();
  await asSystem(async (tx) => {
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${GATE}'))`);
    await tx.unsafe(
      `DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${GATE}')`,
    );
    await tx.unsafe(`DELETE FROM plugins WHERE slug = '${GATE}'`);
  });
}

/** A consent plugin as the build sees it: it withholds the video module. */
const gate = definePlugin({
  slug: GATE,
  version: "0.1.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["client_assets"],
  deferralsOperation: "deferrals",
  deferralPlaceholders: {
    allow: {
      html: "<div data-t1708-placeholder><p>Loads with consent to {{label}}.</p></div>",
      css: "",
    },
  },
  operations: {
    deferrals: async (_ctx, args) => {
      const { moduleIds } = args as { moduleIds: string[] };
      return {
        deferrals: moduleIds.includes(videoModuleId)
          ? {
              [videoModuleId]: {
                reason: "marketing",
                placeholderModuleSlug: `${PFX}-no-such-placeholder`,
                placeholder: { name: "allow", values: { label: "Marketing" } },
              },
            }
          : {},
      };
    },
  },
});

function target(env: "staging" | "production"): DeployTarget {
  return {
    id: "00000000-0000-0000-0000-0000000017a8",
    name: env,
    env,
    outDir: "out",
    baseUrl: "https://withheld.example",
    robotsDefault: env === "staging" ? "noindex" : "index",
    pageUrlStyle: "directory",
  };
}

const root = mkdtempSync(join(tmpdir(), "caelo-nested-withheld-build-"));

/**
 * A full build (every page), as a Stage builds. On a pool of its own, as in
 * production: there the generator holds its build transaction in its own
 * process while the plugins answer on the admin's pool, and on one shared
 * pool every plugin read would be a nested checkout the pool guard refuses.
 */
async function build(env: "staging" | "production", runId: string) {
  const buildAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_URL,
  });
  try {
    return await buildAdapter.withAdminTransaction(
      SYSTEM,
      (tx) =>
        generateSite({
          publishAt: new Date().toISOString(),
          tx,
          plugins: localBuildPluginServices,
          target: target(env),
          runId,
          repoRoot: root,
        }),
      // The generator CLI's holder (pool-guard.ts long-transaction allowlist).
      { holder: "static-generator.build" },
    );
  } finally {
    await buildAdapter.close();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  const row = await asSystem(
    (tx) => tx`SELECT site_base_url, site_language FROM site_defaults WHERE id = 1`,
  );
  const settings = row[0] as { site_base_url: string | null; site_language: string | null };
  baseBefore = settings.site_base_url;
  languageBefore = settings.site_language;
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = 'https://withheld.example', site_language = 'en' WHERE id = 1`,
  );
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: `${PFX} TPL`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  const templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const page = await execute(registry, adapter, SYSTEM, "pages.build_page", {
    page: { slug: `${PFX}-tool`, title: `${PFX} Tool`, templateId, status: "published" },
    modules: [
      {
        ref: "video",
        displayName: `${PFX} Tool video`,
        description: "The tool's demo video.",
        kind: "content",
        html: '<iframe class="tool-video" src="https://www.youtube.com/embed/{{video_id}}"></iframe>',
        css: ".tool-video{aspect-ratio:16/9}",
        js: "document.querySelector('.tool-video')?.setAttribute('data-ready','1');",
        fields: [{ name: "video_id", kind: "text", label: "Video id" }],
        content: { source: "inline", values: { video_id: "abc123" } },
      },
      {
        blockName: "content",
        displayName: `${PFX} Tool section`,
        description: "The tool's introduction with its demo video.",
        kind: "content",
        html: '<section class="tool"><h2>{{heading}}</h2>{{>demo}}</section>',
        fields: [
          { name: "heading", kind: "text", label: "Heading" },
          { name: "demo", kind: "module", label: "Demo video" },
        ],
        content: {
          source: "inline",
          values: { heading: "Check your hreflang", demo: { $ref: "video" } },
        },
      },
    ],
  });
  if (!page.ok) throw new Error(`build_page failed: ${JSON.stringify(page.error)}`);
  const built = page.value as {
    pageId: string;
    detached: { ref: string; moduleId: string }[];
  };
  pageId = built.pageId;
  const video = built.detached.find((d) => d.ref === "video");
  if (!video) throw new Error("the nested video was not minted");
  videoModuleId = video.moduleId;
  // A full build needs a page at the site root.
  const home = await execute(registry, adapter, SYSTEM, "pages.set_home_page", { pageId });
  if (!home.ok) throw new Error(`set_home_page failed: ${JSON.stringify(home.error)}`);

  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: gate }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterAll(async () => {
  await wipe();
  await asSystem(
    (tx) =>
      tx`UPDATE site_defaults SET site_base_url = ${baseBefore}, site_language = ${languageBefore} WHERE id = 1`,
  );
  await adapter.close();
});

describe("a withheld module nested inside another module (#1708)", () => {
  it("a full staging build ships the page without it and reports it", async () => {
    const runId = `${PFX}-stage`;
    const result = await build("staging", runId);
    const marker = `nested-module-withheld:${videoModuleId}/${GATE}/marketing`;
    const ours = result.renderFailures.filter((f) => f.pageId === pageId);
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({
      pagePath: "/",
      blockName: "content",
      field: "demo",
      reason: marker,
    });
    expect(ours[0]?.line).toContain(marker);

    const html = await readFile(join(root, "out", "builds", runId, pageOutputPath("/")), "utf8");
    // The section ships; the embed, its CSS and its JS ship nowhere.
    expect(html).toContain("Check your hreflang");
    expect(html).not.toContain("youtube.com");
    expect(html).not.toContain("tool-video");
    expect(html).not.toContain("data-t1708-placeholder");
  });

  it("every other build stops on it, naming the module and the field", async () => {
    const run = build("production", `${PFX}-prod`);
    await expect(run).rejects.toBeInstanceOf(RenderFailureError);
    await expect(build("production", `${PFX}-prod-2`)).rejects.toThrow(
      `field "demo": nested-module-withheld:${videoModuleId}/${GATE}/marketing`,
    );
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * #1087 — a plugin that fails while the editor preview renders must not
 * abort the preview.
 *
 * On 2026-10-22 an active international-site whose operations refused on
 * one server ("plugin_storage.list: the plugin is not active") made EVERY
 * page preview fail with `render_preview failed: link-resolve: …`. The rule
 * (CLAUDE.md §2, #1008) is that a plugin's errors block Publish live, not
 * the editor's work. Against the real host and Postgres:
 *   - a loaded plugin whose link-resolve, data-list and head-contribution
 *     operations all throw leaves render_preview OK, the page rendered
 *     without its contribution, flagged `plugin-render-failed:<slug>` and
 *     listed in `pluginFailures` with each failing point's reason;
 *   - inspect_page_render tells the AI what that marker means;
 *   - the build path (MAIN_RENDER, no failure sink) still throws.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  collectContributions,
  MAIN_RENDER,
  resetPluginHost,
  resetPluginHostSync,
  resolveDataLists,
  resolveLinkVariants,
} from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { ToolRegistry } from "../ai/tools/dispatch.js";
import { inspectPageRenderTool } from "../ai/tools/inspect-page-render.js";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYSTEM: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1087-preview",
};
const PLUGIN = "t1087-intl";
const TPL_SLUG = "t1087-tpl";
const MOD_SLUG = "t1087-mod";
const PAGE_SLUG = "t1087-page";
const REFUSAL = "plugin_storage.list: the plugin is not active";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";
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
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
    await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
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

async function ok<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYSTEM, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

beforeAll(async () => {
  await wipe();
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreSiteLanguage = await pinSiteLanguage(ADMIN_URL as string, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

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
    html: "<p>still renders</p>",
    fields: [{ name: "body", kind: "text", label: "Body" } as never],
  });
  pageId = (
    await ok<{ pageId: string }>("pages.create", { slug: PAGE_SLUG, title: "Page", templateId })
  ).pageId;
  await ok("pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [moduleId] }],
  });

  // Loaded and active, but every render-time call refuses — the shape of
  // the 2026-10-22 incident.
  const refuse = async (): Promise<never> => {
    throw new Error(REFUSAL);
  };
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
          requestedCapabilities: ["link_resolve", "head_contributions"],
          linkResolveOperation: "link_resolve",
          dataLists: [
            {
              name: "language_links",
              description: "test list",
              itemFields: ["href", "label"],
            },
          ],
          dataListsOperation: "language_links",
          contributes: ["head"],
          contributionsOperation: "head_contributions",
          operations: {
            link_resolve: refuse,
            language_links: refuse,
            head_contributions: refuse,
          },
        }),
      },
    ],
  });
  expect(report.failed).toEqual([]);
});

afterAll(async () => {
  await wipe();
  await restoreSiteBaseUrl?.();
  await restoreSiteLanguage?.();
  await adapter.close();
});

describe("#1087 — a failing plugin degrades the preview instead of aborting it", () => {
  it("render_preview renders the page and flags the plugin with every failing point", async () => {
    const rendered = await ok<{
      html: string;
      missingSlots: string[];
      pluginFailures: { slug: string; reason: string }[];
    }>("pages.render_preview", { pageId });
    expect(rendered.html).toContain("still renders");
    expect(rendered.missingSlots.filter((m) => m === `plugin-render-failed:${PLUGIN}`)).toEqual([
      `plugin-render-failed:${PLUGIN}`,
    ]);
    expect(rendered.pluginFailures.every((f) => f.slug === PLUGIN)).toBe(true);
    const reasons = rendered.pluginFailures.map((f) => f.reason).join("\n");
    expect(reasons).toContain(`link-resolve: ${PLUGIN}.link_resolve failed`);
    expect(reasons).toContain(`data-lists: ${PLUGIN}.language_links failed`);
    expect(reasons).toContain(`head-composition: ${PLUGIN}.head_contributions failed`);
    expect(reasons).toContain(REFUSAL);
  });

  it("inspect_page_render explains the marker to the AI with the reason", async () => {
    const tools = new ToolRegistry();
    tools.register(inspectPageRenderTool);
    const ai: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "t1087-inspect",
    };
    const res = await tools.dispatch("inspect_page_render", { pageId }, ai, { adapter, registry });
    expect(res.ok).toBe(true);
    const summary = JSON.parse(res.content) as {
      slots: { missing: string[]; nextSteps?: Record<string, string> };
    };
    const step = summary.slots.nextSteps?.[`plugin-render-failed:${PLUGIN}`] ?? "";
    expect(step).toContain(`"${PLUGIN}" runs on this server but its call failed`);
    expect(step).toContain(REFUSAL);
    expect(step).toContain("Publish live");
  });

  it("builds (no failure sink) still fail loudly on the same plugin", async () => {
    const pages = [pageId];
    await expect(resolveLinkVariants(pages, MAIN_RENDER)).rejects.toThrow(/link_resolve failed/);
    await expect(resolveDataLists(pages, MAIN_RENDER, "directory")).rejects.toThrow(
      /language_links failed/,
    );
    await expect(
      collectContributions(pages, {
        ...MAIN_RENDER,
        siteBaseUrl: "https://example.com",
        pageUrlStyle: "directory",
      }),
    ).rejects.toThrow(/head_contributions failed/);
  });
});

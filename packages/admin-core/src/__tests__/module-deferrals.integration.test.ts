// SPDX-License-Identifier: MPL-2.0

/**
 * #450 — a plugin withholds a module, end to end through the real
 * preview op.
 *
 * The failure modes here are the interesting part. Every branch that
 * could quietly render the withheld module instead throws, because
 * "the gate did not apply" is indistinguishable from "there was no
 * gate" in the output — and the difference is a third-party request
 * that has already left the browser by the time anyone notices.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bootstrap, resetPluginHost, resolveModuleDeferrals } from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t450",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";
let videoModuleId = "";

/** What the fixture plugin currently withholds. Mutated per test. */
let verdicts: Record<string, { reason: string; placeholderModuleSlug: string }> = {};

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
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
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't450-%')
    )`);
    await tx.unsafe(
      "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't450-%')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't450-%'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't450-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't450-%'");
    await tx.unsafe("DELETE FROM modules WHERE slug LIKE 't450-%'");
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();

  const tpl = await execute(registry, adapter, SYS_CTX, "templates.create", {
    slug: "t450-tpl",
    displayName: "T450",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(JSON.stringify(tpl.error));
  const templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYS_CTX, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const page = await execute(registry, adapter, SYS_CTX, "pages.create", {
    slug: "t450-page",
    title: "Gated",
    templateId,
  });
  if (!page.ok) throw new Error(JSON.stringify(page.error));
  pageId = (page.value as { pageId: string }).pageId;

  const video = await execute(registry, adapter, SYS_CTX, "modules.create", {
    slug: "t450-video",
    displayName: "Video",
    html: '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
    css: "",
    js: "",
    fields: [],
  });
  if (!video.ok) throw new Error(JSON.stringify(video.error));
  videoModuleId = (video.value as { moduleId: string }).moduleId;

  const placeholder = await execute(registry, adapter, SYS_CTX, "modules.create", {
    slug: "t450-placeholder",
    displayName: "Consent placeholder",
    html: '<div class="ph"><p>{{notice}}</p><button data-consent-accept>OK</button></div>',
    css: ".ph{border:1px dashed}",
    js: "",
    fields: [{ name: "notice", kind: "text", label: "Notice", default: "Please allow cookies" }],
  });
  if (!placeholder.ok) throw new Error(JSON.stringify(placeholder.error));

  const set = await execute(registry, adapter, SYS_CTX, "pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [videoModuleId] }],
  });
  if (!set.ok) throw new Error(JSON.stringify(set.error));

  const gate = definePlugin({
    slug: "t450-gate",
    version: "0.1.0",
    tier: 1,
    schema: {},
    deferralsOperation: "deferrals",
    operations: {
      deferrals: async (_ctx, args) => {
        const { moduleIds } = args as { moduleIds: string[] };
        const out: Record<string, unknown> = {};
        for (const id of moduleIds) {
          const v = verdicts[id];
          if (v) out[id] = v;
        }
        return { deferrals: out };
      },
    },
  });
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: gate }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

async function renderPage(): Promise<string> {
  const r = await execute(registry, adapter, SYS_CTX, "pages.render_preview", { pageId });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { html: string }).html;
}

describe("#450 — module deferrals through the preview op", () => {
  it("renders the module normally when the plugin withholds nothing", async () => {
    verdicts = {};
    const html = await renderPage();
    expect(html).toContain("youtube.com");
    expect(html).not.toContain("data-caelo-deferred");
  });

  it("swaps in the placeholder and parks the embed in a template", async () => {
    verdicts = {
      [videoModuleId]: { reason: "marketing", placeholderModuleSlug: "t450-placeholder" },
    };
    const html = await renderPage();

    expect(html).toContain('data-caelo-deferred="t450-gate"');
    expect(html).toContain('data-reason="marketing"');
    // The placeholder rendered from its own field default, like the
    // ordinary module it is.
    expect(html).toContain("Please allow cookies");
    expect(html).toContain(".ph{border:1px dashed}");
    // The embed survives only inside the inert template.
    expect(html.indexOf("youtube.com")).toBeGreaterThan(
      html.indexOf("<template data-caelo-deferred-content>"),
    );
  });

  it("fails LOUDLY when the placeholder module does not exist", async () => {
    // Falling back to the real module would issue exactly the request
    // the gate exists to prevent — the least acceptable silent recovery
    // in this codebase (CLAUDE.md §2).
    verdicts = { [videoModuleId]: { reason: "marketing", placeholderModuleSlug: "t450-nope" } };
    expect(resolveModuleDeferrals([videoModuleId])).rejects.toThrow(/does not exist/);
  });

  it("rejects a verdict whose reason is not a plain key", async () => {
    verdicts = {
      [videoModuleId]: { reason: "Marketing Cookies!", placeholderModuleSlug: "t450-placeholder" },
    };
    expect(resolveModuleDeferrals([videoModuleId])).rejects.toThrow(/invalid verdict/);
  });

  it("costs nothing when no plugin declares deferrals", async () => {
    verdicts = {
      [videoModuleId]: { reason: "marketing", placeholderModuleSlug: "t450-placeholder" },
    };
    resetPluginHost();
    expect(await resolveModuleDeferrals([videoModuleId])).toEqual(new Map());
  });
});

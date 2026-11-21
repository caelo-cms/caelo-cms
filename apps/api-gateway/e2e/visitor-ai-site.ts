// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1654) — a site with a visitor conversation, for browser
 * tests of a site assistant (#1655) against a mock model: the real gateway
 * on its own database identity (public_role), a collection release in a
 * live store, the visitor-AI settings and the plugin's released
 * configuration published as the admin's projection does, a key file, and
 * the AI SDK's mock model behind the provider seam
 * (`setVisitorAiModelFactoryForTests`). Never a real key.
 *
 * Run as a script, it serves a built-in assistant plugin (`e2e-assistant`,
 * operation `ask`) over two pages and prints `READY <port>`. A browser test
 * of another plugin imports {@link startVisitorAiSite} with its own
 * definition, pages, page HTML and model script.
 *
 * Environment: the integration DB URLs (ADMIN_DATABASE_URL,
 * PUBLIC_ADMIN_DATABASE_URL, PUBLIC_DATABASE_URL,
 * PUBLIC_STAGING_ADMIN_DATABASE_URL), CAELO_TRUSTED_PROXY_HOPS=0.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drainProjectionOnce,
  releaseProjectionForTests,
  stagingPublicAdapter,
} from "@caelo-cms/admin-core";
import { buildRelease, directoryStore, scopedStore } from "@caelo-cms/collection-index";
import { bootstrap, bootstrapDispatchOnly, resetPluginHost } from "@caelo-cms/plugin-host";
import { definePlugin, type PluginDefinition } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import {
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
  handleRequest,
  invalidateGatewaySettings,
  setGatewayAdapter,
} from "../src/server.js";
import {
  setVisitorAiModelFactoryForTests,
  VISITOR_AI_KEY_FILE_ENV,
} from "../src/visitor-ai/provider.js";
import { type Script, scriptedVisitorModel } from "../src/visitor-ai/scripted-model.js";

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const TEST_KEY = "sk-ant-e2e-fixture-not-a-real-key-000";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function onDb<T>(url: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const conn = new SQL(url);
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await conn.end();
  }
}

/** A page of the fixture site: its document in the collection, and its HTML. */
export interface FixturePage {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly sections: readonly { anchor: string; heading: string; text: string }[];
}

export interface VisitorAiSiteOptions {
  /** The plugin with the conversation; its collection `pages` holds the documents. */
  readonly definition: PluginDefinition;
  /** The collection the documents go into (default `pages`). */
  readonly collection?: string;
  readonly pages: readonly FixturePage[];
  /** The whole page for a path, or null for a 404 (the widget's runtime goes in here). */
  readonly html: (pathname: string, origin: string) => string | null;
  readonly script?: Script;
}

/** Start the site; resolves with its origin and a stop function. */
export async function startVisitorAiSite(
  options: VisitorAiSiteOptions,
): Promise<{ origin: string; stop: () => Promise<void> }> {
  const ADMIN_URL = required("ADMIN_DATABASE_URL");
  const PUBLIC_ADMIN_URL = required("PUBLIC_ADMIN_DATABASE_URL");
  const PUBLIC_URL = required("PUBLIC_DATABASE_URL");
  const staging = stagingPublicAdapter(required("PUBLIC_STAGING_ADMIN_DATABASE_URL"));
  const slug = options.definition.slug;
  const collection = options.collection ?? "pages";
  const root = await mkdtemp(join(tmpdir(), "caelo-e2e-1654-"));
  const keyFile = join(root, "key.json");
  await writeFile(keyFile, JSON.stringify({ provider: "anthropic", apiKey: TEST_KEY }));
  process.env.CAELO_COLLECTIONS_LIVE_STORE = `file://${root}/live`;
  process.env.CAELO_GATEWAY_ENVIRONMENT = "live";
  process.env[VISITOR_AI_KEY_FILE_ENV] = keyFile;
  const saved = await onDb(
    ADMIN_URL,
    async (tx) =>
      ((await tx`SELECT * FROM visitor_ai_settings WHERE id = 1`) as Record<string, unknown>[])[0],
  );
  const savedPrefix = await onDb(ADMIN_URL, async (tx) => {
    const [row] = (await tx`SELECT captcha_pow_target_prefix AS p FROM site_settings`) as {
      p: string;
    }[];
    // A cheap proof of work, so the browser test does not spend seconds on it.
    await tx`UPDATE site_settings SET captcha_pow_target_prefix = '00'`;
    await tx`UPDATE visitor_ai_settings SET enabled = true, provider = 'anthropic',
               model = 'claude-haiku-5-5', live_key_provider = 'anthropic', live_key_set_at = now()`;
    return row?.p ?? "000fff";
  });

  const admin = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  const report = await bootstrap({
    infra: { adapter: admin, registry: new OperationRegistry(), stagingAdapter: staging },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: options.definition }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  const pluginId = await onDb(
    ADMIN_URL,
    async (tx) =>
      ((await tx`SELECT id::text AS id FROM plugins WHERE slug = ${slug}`) as { id: string }[])[0]
        ?.id as string,
  );
  // Where the site is served: the published live origin pages post from.
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => {
      const { pathname } = new URL(req.url);
      if (pathname.startsWith("/api/"))
        return handleRequest(req, { peerAddress: srv.requestIP(req)?.address ?? null });
      const html = options.html(pathname, `http://127.0.0.1:${srv.port}`);
      return html === null
        ? new Response("not found", { status: 404 })
        : new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const savedBaseUrl = await onDb(ADMIN_URL, async (tx) => {
    const [row] = (await tx`SELECT site_base_url AS u FROM site_defaults WHERE id = 1`) as {
      u: string | null;
    }[];
    await tx`UPDATE site_defaults SET site_base_url = ${origin} WHERE id = 1`;
    return row?.u ?? null;
  });
  await drainProjectionOnce(admin, staging);
  await releaseProjectionForTests(admin, staging, undefined, "as-loaded");
  resetPluginHost();
  await admin.close();

  const live = scopedStore(directoryStore(join(root, "live")), `${slug}/${collection}`);
  const writes: Promise<void>[] = [];
  const built = await buildRelease(
    options.pages.map((p) => ({
      id: p.id,
      lang: "de",
      values: { title: p.title, sections: p.sections, url: p.path },
    })),
    {
      schema: { fields: options.definition.collections?.[collection]?.fields as never },
      sink: (name, data) => void writes.push(live.write(name, data, { immutable: true })),
      profile: {
        weights: { title: 3, "sections.heading": 2, "sections.text": 1 },
        boosts: [],
        synonyms: {},
        bestBets: {},
        protectedTerms: [],
        typos: true,
        compounds: true,
        prefix: true,
        crossLanguage: false,
        semantic: null,
        suggestions: {},
      },
    },
  );
  await Promise.all(writes);
  await onDb(PUBLIC_ADMIN_URL, async (tx) => {
    await tx`DELETE FROM published_collections WHERE plugin_id = ${pluginId}::uuid`;
    await tx`INSERT INTO published_collections (plugin_id, collection, release_key)
             VALUES (${pluginId}::uuid, ${collection}, ${built.file})`;
  });

  const urls = gatewayDatabaseUrls({
    PUBLIC_DATABASE_URL: PUBLIC_URL,
    CAELO_GATEWAY_ENVIRONMENT: "live",
  });
  const gateway = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: urls.public,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
  await gateway.verifyRoles();
  setGatewayAdapter(gateway);
  invalidateGatewaySettings();
  const gw = await bootstrapDispatchOnly({
    infra: { adapter: gateway, registry: new OperationRegistry() },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: options.definition }],
  });
  if (gw.loaded.length !== 1)
    throw new Error(`the gateway did not attach ${slug}: ${JSON.stringify(gw)}`);
  const scripted = scriptedVisitorModel(options.script);
  setVisitorAiModelFactoryForTests(() => scripted.model);

  return {
    origin,
    stop: async () => {
      server.stop(true);
      setVisitorAiModelFactoryForTests(null);
      await gateway.close();
      await onDb(ADMIN_URL, async (tx) => {
        await tx`UPDATE site_settings SET captcha_pow_target_prefix = ${savedPrefix}`;
        await tx`UPDATE site_defaults SET site_base_url = ${savedBaseUrl} WHERE id = 1`;
        if (saved)
          await tx`UPDATE visitor_ai_settings SET enabled = ${saved.enabled as boolean},
                     live_key_provider = ${(saved.live_key_provider as string | null) ?? null}`;
        await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${slug})`;
        await tx`DELETE FROM plugins WHERE slug = ${slug}`;
      });
      await onDb(PUBLIC_ADMIN_URL, async (tx) => {
        await tx`DELETE FROM published_collections WHERE plugin_id = ${pluginId}::uuid`;
        await tx`TRUNCATE visitor_ai_calls`;
      });
      await staging.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The built-in assistant: a conversation over its own collection. */
const ASSISTANT = definePlugin({
  slug: "e2e-assistant",
  version: "1.0.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["collections", "visitor_ai"],
  requires: ["visitor-ai"],
  collections: {
    pages: {
      description: "The site's pages.",
      fields: {
        title: { kind: "text", prefix: true },
        sections: { kind: "passages" },
        url: { kind: "keyword" },
      },
      maxDocuments: 100,
      maxDocumentBytes: 100_000,
    },
  },
  config: {
    instructions: {
      type: "string",
      label: "Instructions",
      description: "What the assistant is for.",
      effect: "query",
      maxLength: 2000,
      default: "Beantworte Fragen zu dieser Website.",
      visitorVisible: true,
    },
  },
  collectionOperations: [
    {
      name: "search",
      kind: "search",
      collection: "pages",
      description: "Search the pages.",
      returns: ["url", "title"],
      snippet: "sections",
    },
  ],
  aiChatOperations: [
    {
      name: "ask",
      kind: "ai-chat",
      description: "Answer visitors' questions.",
      prompt: { fields: ["instructions"] },
      tools: [{ plugin: "e2e-assistant", operation: "search" }],
    },
  ],
  operations: { noop: async () => ({}) },
});

if (import.meta.main) {
  const site = await startVisitorAiSite({
    definition: ASSISTANT,
    pages: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        path: "/preise/",
        title: "Preise",
        sections: [
          {
            anchor: "pakete",
            heading: "Pakete",
            text: "Das Starter-Paket kostet 49 Euro im Monat.",
          },
        ],
      },
    ],
    html: (pathname) =>
      pathname === "/" || pathname === "/preise/"
        ? `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Fixture</title></head><body><main><h1>Start</h1></main></body></html>`
        : null,
  });
  const stop = async () => {
    await site.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  console.log(`READY ${new URL(site.origin).port}`);
}

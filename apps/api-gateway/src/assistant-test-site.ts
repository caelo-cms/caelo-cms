// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1655) — a site with the site assistant, for the gateway's
 * integration test and the browser fixture (`e2e/assistant-site.ts`): the
 * admin activates site-search and site-assistant (approving this build of
 * each, as the Owner does), publishes a release, the visitor AI is on with
 * a key file and budgets, site-search's index is a release in the live
 * store, and the gateway runs on its own database identity. The model is
 * whatever the caller installs behind `setVisitorAiModelFactoryForTests`;
 * no real key or provider is ever used.
 *
 * Test support only: imported by tests and the e2e fixture, never by the
 * gateway's server code.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drainProjectionOnce,
  registerAdminOps,
  releaseProjectionForTests,
  stagingPublicAdapter,
} from "@caelo-cms/admin-core";
import { buildRelease, directoryStore, scopedStore } from "@caelo-cms/collection-index";
import {
  bootstrap,
  bootstrapDispatchOnly,
  releaseManifestDigest,
  resetDispatchOnlyHost,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { manifestFromDefinition } from "@caelo-cms/plugin-sdk";
import siteAssistant from "@caelo-cms/plugin-site-assistant";
import siteSearch from "@caelo-cms/plugin-site-search";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { dropPublishedState } from "./published-changes.js";
import {
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
  invalidateGatewaySettings,
  setGatewayAdapter,
} from "./server.js";
import { registerTestLiveOrigin } from "./test-support.js";
import { VISITOR_AI_KEY_FILE_ENV } from "./visitor-ai/provider.js";
import { resetVisitorAiCacheForTests } from "./visitor-ai/published.js";

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYSTEM = { actorId: SYSTEM_ACTOR_ID, actorKind: "system" as const, requestId: "t1655-site" };
const PLUGINS = [siteSearch, siteAssistant] as const;

/** The pages the site-search index holds. */
export const ASSISTANT_SITE_PAGES = [
  {
    id: "11111111-1111-4111-8111-111111111655",
    path: "/preise/",
    title: "Preise",
    sections: [
      { anchor: "pakete", heading: "Pakete", text: "Das Starter-Paket kostet 49 Euro im Monat." },
      {
        anchor: "versand",
        heading: "Versand",
        text: "Wir liefern in die Schweiz und nach Österreich.",
      },
    ],
  },
  {
    id: "22222222-2222-4222-8222-222222221655",
    path: "/kontakt/",
    title: "Kontakt",
    sections: [
      { anchor: "schreiben", heading: "Schreiben Sie uns", text: "Wir antworten am selben Tag." },
    ],
  },
] as const;

/** The settings row that turns the visitor AI on with room in every budget. */
const VISITOR_AI_ON = {
  enabled: true,
  provider: "anthropic",
  model: "claude-haiku-5-5",
  live_key_provider: "anthropic",
  daily_budget_microcents: 500_000_000,
  monthly_budget_microcents: 5_000_000_000,
  conversation_budget_microcents: 25_000_000,
  max_concurrent: 20,
};

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

/** The running assistant site. */
export interface AssistantSite {
  readonly pluginIds: { readonly search: string; readonly assistant: string };
  /** Turns the kept feedback on or off and releases it (a Stage plus Publish live). */
  setFeedback(on: boolean): Promise<void>;
  /** Visitors' ratings the gateway stored. */
  feedback(): Promise<{ kind: string; question: string | null; note: string | null }[]>;
  /** Puts back what the site changed. */
  restore(): Promise<void>;
}

/** Builds the site; `urls` are the database URLs of the test environment. */
export async function prepareAssistantSite(urls: {
  readonly admin: string;
  readonly publicAdmin: string;
  readonly publicGateway: string;
  readonly stagingAdmin: string;
}): Promise<AssistantSite> {
  const staging = stagingPublicAdapter(urls.stagingAdmin);
  const root = await mkdtemp(join(tmpdir(), "caelo-t1655-"));
  const keyFile = join(root, "visitor-ai-key.json");
  await writeFile(
    keyFile,
    JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-t1655-0123456789abcdefghij" }),
  );
  const envBefore: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({
    CAELO_COLLECTIONS_LIVE_STORE: `file://${root}/live`,
    CAELO_GATEWAY_ENVIRONMENT: "live",
    [VISITOR_AI_KEY_FILE_ENV]: keyFile,
  })) {
    envBefore[k] = process.env[k];
    process.env[k] = v;
  }

  // What this site changes, to put back.
  const saved = await onDb(urls.admin, async (tx) => {
    const rows = (await tx`SELECT slug, status, approved_capabilities, approved_manifest_digest
        FROM plugins WHERE slug IN ('site-search', 'site-assistant')`) as {
      slug: string;
      status: string;
      approved_capabilities: string[] | null;
      approved_manifest_digest: string | null;
    }[];
    // The Owner activates this build of each and approves what it asks for.
    for (const p of PLUGINS) {
      const m = manifestFromDefinition(p);
      await tx`UPDATE plugins SET status = 'active',
        approved_capabilities = ARRAY(SELECT jsonb_array_elements_text(
          (${JSON.stringify(m.requestedCapabilities ?? [])}::text)::jsonb)),
        approved_manifest_digest = ${releaseManifestDigest(m)}
        WHERE slug = ${p.slug}`;
    }
    const [settings] = (await tx`SELECT * FROM visitor_ai_settings WHERE id = 1`) as Record<
      string,
      unknown
    >[];
    const [captcha] =
      (await tx`SELECT captcha_pow_target_prefix AS p FROM site_settings WHERE id = 1`) as {
        p: string;
      }[];
    await tx`UPDATE site_settings SET captcha_pow_target_prefix = '0' WHERE id = 1`;
    const sets = Object.entries(VISITOR_AI_ON).map(
      ([k, v]) => `${k} = ${typeof v === "string" ? `'${v}'` : String(v)}`,
    );
    await tx.unsafe(`UPDATE visitor_ai_settings SET ${sets.join(", ")} WHERE id = 1`);
    // Orphaned list types a crashed run left behind.
    await tx`DELETE FROM list_types WHERE (slug LIKE 'site-search-%' OR slug LIKE 'site-assistant-%')
             AND (plugin_id IS NULL OR plugin_id NOT IN (SELECT id FROM plugins))`;
    return { rows, settings: settings ?? null, captcha: captcha?.p ?? "000fff" };
  });

  const adminAdapter = new DatabaseAdapter({
    adminDatabaseUrl: urls.admin,
    publicDatabaseUrl: urls.publicAdmin,
  });
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  const report = await bootstrap({
    infra: { adapter: adminAdapter, registry, stagingAdapter: staging },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: PLUGINS.map((definition) => ({ definition })),
  });
  if (report.failed.length > 0)
    throw new Error(`plugins did not load: ${JSON.stringify(report.failed)}`);
  const ids = await onDb(
    urls.admin,
    async (tx) =>
      (await tx`SELECT slug, id::text AS id FROM plugins WHERE slug IN ('site-search', 'site-assistant')`) as {
        slug: string;
        id: string;
      }[],
  );
  const idOf = (slug: string) => ids.find((r) => r.slug === slug)?.id ?? "";
  await registerTestLiveOrigin(urls.admin);
  await drainProjectionOnce(adminAdapter, staging);

  // A release republishes the plugins' section, the index pointer with it:
  // this site's index has no Stage run, so it is published again after each.
  let indexKey: string | null = null;
  const publishIndex = async () => {
    if (!indexKey) return;
    await onDb(urls.publicAdmin, async (tx) => {
      await tx`DELETE FROM published_collections`;
      await tx`INSERT INTO published_collections (plugin_id, collection, release_key) VALUES (${idOf("site-search")}::uuid, 'pages', ${indexKey})`;
    });
  };
  const release = async () => {
    await releaseProjectionForTests(adminAdapter, staging, undefined, "as-loaded");
    await publishIndex();
    // What the admin's publish notification does to the gateway's caches.
    dropPublishedState();
    resetVisitorAiCacheForTests();
    invalidateGatewaySettings();
  };
  await release();

  // site-search's index, as a Stage built it and Publish live copied it.
  const live = scopedStore(directoryStore(join(root, "live")), "site-search/pages");
  const writes: Promise<void>[] = [];
  const built = await buildRelease(
    ASSISTANT_SITE_PAGES.map((p) => ({
      id: p.id,
      lang: "de",
      values: {
        title: p.title,
        short_title: "",
        description: "",
        breadcrumb: "",
        sections: p.sections.map((s) => ({ ...s })),
        reduced: [],
        url: p.path,
        page_type: "",
        terms: [],
      },
    })),
    {
      schema: { fields: siteSearch.collections?.pages?.fields as never },
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
  indexKey = built.file;
  await publishIndex();

  const gw = gatewayDatabaseUrls({
    PUBLIC_DATABASE_URL: urls.publicGateway,
    CAELO_GATEWAY_ENVIRONMENT: "live",
  });
  const gatewayAdapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: gw.public,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
  await gatewayAdapter.verifyRoles();
  setGatewayAdapter(gatewayAdapter);
  invalidateGatewaySettings();
  const attached = await bootstrapDispatchOnly({
    infra: { adapter: gatewayAdapter, registry: new OperationRegistry() },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: PLUGINS.map((definition) => ({ definition })),
  });
  if (attached.loaded.length !== PLUGINS.length)
    throw new Error(`the gateway did not attach both plugins: ${JSON.stringify(attached)}`);

  const assistantId = idOf("site-assistant");
  const schema = "plugin_site_assistant";
  return {
    pluginIds: { search: idOf("site-search"), assistant: assistantId },
    async setFeedback(on: boolean) {
      // feedback.enabled is approval-gated: proposed, then approved, on the main line.
      const proposed = await execute(
        registry,
        adminAdapter,
        SYSTEM,
        "plugin_config.propose_update",
        {
          pluginSlug: "site-assistant",
          patch: { feedback: { enabled: on } },
          reason: "The test site turns visitors' feedback on or off.",
        },
      );
      if (!proposed.ok)
        throw new Error(`plugin_config.propose_update: ${JSON.stringify(proposed.error)}`);
      const { proposalId } = proposed.value as { proposalId: string };
      const applied = await execute(
        registry,
        adminAdapter,
        SYSTEM,
        "plugin_config.execute_proposal",
        {
          proposalId,
        },
      );
      if (!applied.ok)
        throw new Error(`plugin_config.execute_proposal: ${JSON.stringify(applied.error)}`);
      await release();
    },
    async feedback() {
      return onDb(urls.publicAdmin, async (tx) => {
        await tx`SELECT set_config('caelo.plugin_id', ${assistantId}, true)`;
        return (await tx.unsafe(
          `SELECT kind, question, note FROM ${schema}.feedback ORDER BY created_at`,
        )) as { kind: string; question: string | null; note: string | null }[];
      });
    },
    async restore() {
      await onDb(urls.publicAdmin, async (tx) => {
        await tx`SELECT set_config('caelo.plugin_id', ${assistantId}, true)`;
        await tx.unsafe(`DELETE FROM ${schema}.feedback`);
      });
      await onDb(urls.publicAdmin, async (tx) => {
        await tx`DELETE FROM published_collections`;
        await tx`TRUNCATE visitor_ai_calls`;
      });
      await onDb(urls.admin, async (tx) => {
        await tx`UPDATE site_settings SET captcha_pow_target_prefix = ${saved.captcha} WHERE id = 1`;
        const s = saved.settings;
        if (s)
          await tx`UPDATE visitor_ai_settings SET enabled = ${s.enabled as boolean}, provider = ${s.provider as string}, model = ${s.model as string},
            daily_budget_microcents = ${String(s.daily_budget_microcents)}::bigint, monthly_budget_microcents = ${String(s.monthly_budget_microcents)}::bigint,
            conversation_budget_microcents = ${String(s.conversation_budget_microcents)}::bigint, max_concurrent = ${s.max_concurrent as number},
            live_key_provider = ${(s.live_key_provider as string | null) ?? null}, staging_key_provider = ${(s.staging_key_provider as string | null) ?? null}
            WHERE id = 1`;
        for (const p of PLUGINS) {
          const before = saved.rows.find((r) => r.slug === p.slug);
          if (before) {
            const approved = JSON.stringify(before.approved_capabilities);
            await tx`UPDATE plugins SET status = ${before.status},
              approved_capabilities = CASE WHEN (${approved}::text)::jsonb = 'null'::jsonb THEN NULL
                ELSE ARRAY(SELECT jsonb_array_elements_text((${approved}::text)::jsonb)) END,
              approved_manifest_digest = ${before.approved_manifest_digest}
              WHERE slug = ${p.slug}`;
          } else {
            await tx`DELETE FROM site_snapshots WHERE actor_id IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${p.slug}))`;
            await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${p.slug})`;
            await tx`DELETE FROM list_types WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${p.slug})`;
            await tx`DELETE FROM plugins WHERE slug = ${p.slug}`;
          }
        }
      });
      await drainProjectionOnce(adminAdapter, staging);
      resetDispatchOnlyHost();
      resetPluginHost();
      for (const [k, v] of Object.entries(envBefore)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await gatewayAdapter.close();
      await adminAdapter.close();
      await staging.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

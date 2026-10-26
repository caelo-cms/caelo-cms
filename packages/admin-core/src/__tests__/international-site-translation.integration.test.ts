// SPDX-License-Identifier: MPL-2.0

/**
 * #397 — the context-aware translation flow end-to-end against a real
 * Postgres with a SCRIPTED AIProvider (fixture-driven per CLAUDE.md §6:
 * the prompt the plugin builds and the apply path are asserted; only
 * the model itself is substituted).
 *
 * Covers: full-mode translation of a fresh variant (values + title
 * applied, status flipped), glossary/style-guide injection into the
 * prompt, structural-lock refusal of a drifting response, the
 * staleness worker consuming the domain-event outbox, and the bulk
 * pass's pause-on-overage contract.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bootstrap, resetPluginHost, runPluginOperation } from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoDefaultPageType } from "./_template-page-type.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t397",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

/** Scripted provider: each queued responder answers ONE structured
 *  (`generateObject`) call — the page translation's install-side path
 *  (CLAUDE.md §12); prompts + the schema sent are recorded for fixture
 *  assertions. The text path is not used by page translation. */
const aiCalls: Array<{
  system: string;
  user: string;
  purpose?: string;
  jsonSchema: { properties: Record<string, unknown>; required: string[] };
}> = [];
const aiScript: Array<() => unknown> = [];
const scriptedProvider = {
  complete: async () => {
    throw new Error("scripted provider: page translation must use generateObject");
  },
  generateObject: async (opts: {
    system: string;
    messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
    jsonSchema: Record<string, unknown>;
    purpose?: string;
  }) => {
    aiCalls.push({
      system: opts.system,
      user: opts.messages[0]?.content ?? "",
      jsonSchema: opts.jsonSchema as { properties: Record<string, unknown>; required: string[] },
      ...(opts.purpose ? { purpose: opts.purpose } : {}),
    });
    const next = aiScript.shift();
    if (!next) throw new Error("scripted provider: no responder queued");
    return {
      object: next(),
      inputTokens: 10,
      outputTokens: 10,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      provider: "anthropic",
      model: "scripted-model",
    };
  },
};

/** One slot's translated fields in the contract's `[{field, value}]` shape. */
const fields = (values: Record<string, string>) =>
  Object.entries(values).map(([field, value]) => ({ field, value }));

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

/** Plugin-schema rows are RLS-scoped to `caelo.plugin_id` (FORCE'd for
 *  owners too) — test-side verification reads impersonate the plugin. */
async function sqlAsPlugin<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const row = (await tx.unsafe(
        "SELECT id::text AS id FROM plugins WHERE slug = 'international-site'",
      )) as { id: string }[];
      const pluginId = row[0]?.id;
      if (!pluginId) throw new Error("plugin row missing");
      await tx.unsafe(`SET LOCAL caelo.plugin_id = '${pluginId}'`);
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe(
      "DELETE FROM redirects WHERE from_path LIKE '/t397-%' OR from_path LIKE '/de/t397-%'",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't397-%'");
    await tx.unsafe("DELETE FROM modules WHERE slug LIKE 't397-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't397-%'");
    await tx.unsafe("DELETE FROM layouts WHERE slug LIKE 't397-%'");
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  const report = await bootstrap({
    infra: { adapter, registry, aiProvider: scriptedProvider },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

async function op<T>(operationName: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

/** Seed a page whose single placement carries translatable values. */
async function seedSourcePage(tag = ""): Promise<string> {
  const templateId = await sqlSystem(async (tx) => {
    const lay = (await tx.unsafe(
      `INSERT INTO layouts (slug, display_name, html, css) VALUES ('t397${tag}-lay', 'L', '<html></html>', '') RETURNING id::text AS id`,
    )) as { id: string }[];
    const tpl = (await tx.unsafe(
      `INSERT INTO templates (slug, display_name, html, css, layout_id) VALUES ('t397${tag}-tpl', 'T', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
    )) as { id: string }[];
    await adoptTemplateIntoDefaultPageType(tx, tpl[0]?.id ?? "");
    const id = tpl[0]?.id;
    if (!id) throw new Error("seed failed");
    return id;
  });
  const created = await execute(registry, adapter, SYS_CTX, "pages.create", {
    slug: `t397${tag}-pricing`,
    title: "Pricing",
    templateId,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const pageId = (created.value as { pageId: string }).pageId;
  await sqlSystem(async (tx) => {
    const mod = (await tx.unsafe(
      `INSERT INTO modules (slug, display_name, type, kind, html)
       VALUES ('t397${tag}-hero', 'Hero', 't397${tag}-hero', 'hero', '<h1>{{headline}}</h1><div>{{body_html}}</div>')
       RETURNING id::text AS id`,
    )) as { id: string }[];
    const ci = (await tx.unsafe(
      `INSERT INTO content_instances (module_id, slug, display_name, "values")
       VALUES ('${mod[0]?.id}', 't397${tag}-hero-src', 'Hero src', '{"headline": "Welcome", "body_html": "<p>Hello <b>world</b></p>"}')
       RETURNING id::text AS id`,
    )) as { id: string }[];
    await tx.unsafe(
      `INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
       VALUES ('${pageId}', 'main', 0, '${mod[0]?.id}', '${ci[0]?.id}', 'unsynced')`,
    );
  });
  return pageId;
}

describe("#397 — context-aware translation", () => {
  it("translates a fresh variant in full mode, honours glossary + style guide, marks staleness from the outbox, and pauses on cap overage", async () => {
    const sourceId = await seedSourcePage();
    await op("set_locales", {
      locales: [
        { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
        { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
      ],
    });
    await op("set_glossary_term", {
      term: "world",
      localeCode: "de",
      translation: "Welt",
      context: "greeting",
    });
    await op("set_style_guide", { localeCode: "de", body: "Use informal du." });

    const variant = await op<{ pageId: string }>("create_variant", {
      sourcePageId: sourceId,
      localeCode: "de",
      slug: "t397-preise",
    });

    // --- Structural-lock refusal: a response inventing a slot never lands.
    aiScript.push(() => ({
      title: "Preise",
      slots: [
        { slot: "s0", values: fields({ headline: "Willkommen" }) },
        // An id that was never offered — the module slug is what a
        // live run actually returned here. (The real decoder is held to
        // the schema's slot enum; the lock is the defense in depth.)
        { slot: "t397-hero", values: fields({ headline: "X" }) },
      ],
    }));
    const refused = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "international-site",
      operationName: "translate_variant",
      args: { variantPageId: variant.pageId },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("structural lock");

    // --- Full-mode translation.
    aiScript.push(() => ({
      title: "Preise",
      slots: [
        {
          slot: "s0",
          values: fields({ headline: "Willkommen", body_html: "<p>Hallo <b>Welt</b></p>" }),
        },
      ],
    }));
    const result = await op<{ mode: string; slotsApplied: number; titleApplied: boolean }>(
      "translate_variant",
      { variantPageId: variant.pageId },
    );
    expect(result.mode).toBe("full");
    expect(result.slotsApplied).toBe(1);
    expect(result.titleApplied).toBe(true);

    // Prompt fixture: whole page, glossary, style guide, structural lock.
    const prompt = aiCalls.at(-1);
    expect(prompt?.system).toContain("STRUCTURAL LOCK");
    expect(prompt?.system).toContain('"world" → "Welt" (greeting)');
    expect(prompt?.system).toContain("Use informal du.");
    expect(prompt?.user).toContain("Title: Pricing");
    expect(prompt?.user).toContain("<p>Hello <b>world</b></p>");
    // The source has no meta description, so the request neither asks
    // for one nor lets the model return one — the live failures were the
    // model answering an invented description, or "" for "none".
    expect(Object.keys(prompt?.jsonSchema.properties ?? {})).toEqual(["title", "slots"]);
    expect(prompt?.system).not.toMatch(/meta ?description/i);
    expect(prompt?.user).not.toMatch(/meta ?description/i);
    // #593 — declared as a translation call, so the host can route it to
    // the Owner's translation model; the call is billed to the plugin on
    // the model it actually ran on.
    expect(prompt?.purpose).toBe("translation");
    const billed = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(
          `SELECT c.model FROM ai_calls c JOIN plugins p ON p.id = c.plugin_id
           WHERE p.slug = 'international-site' ORDER BY c.created_at DESC LIMIT 1`,
        )) as { model: string }[],
    );
    expect(billed[0]?.model).toBe("scripted-model");

    // Applied to the VARIANT's instance only; source untouched; status flipped.
    const applied = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(
          `SELECT p.title, ci."values"->>'headline' AS headline, ci."values"->>'body_html' AS body
           FROM pages p
           JOIN page_modules pm ON pm.page_id = p.id
           JOIN content_instances ci ON ci.id = pm.content_instance_id
           WHERE p.id = '${variant.pageId}'`,
        )) as { title: string; headline: string; body: string }[],
    );
    expect(applied[0]).toEqual({
      title: "Preise",
      headline: "Willkommen",
      body: "<p>Hallo <b>Welt</b></p>",
    });
    const source = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(
          `SELECT ci."values"->>'headline' AS headline
           FROM page_modules pm JOIN content_instances ci ON ci.id = pm.content_instance_id
           WHERE pm.page_id = '${sourceId}'`,
        )) as { headline: string }[],
    );
    expect(source[0]?.headline).toBe("Welcome");
    const statusRow = await sqlAsPlugin(
      async (tx) =>
        (await tx.unsafe(
          `SELECT translation_status FROM plugin_international_site.page_variants WHERE page_id = '${variant.pageId}'`,
        )) as { translation_status: string }[],
    );
    expect(statusRow[0]?.translation_status).toBe("up_to_date");

    // --- Staleness: drain the outbox backlog, then a live SOURCE edit
    // marks the sibling needs_update (the variant's own translate
    // writes were skipped — its row is not 'source').
    let drained = 0;
    for (;;) {
      const tick = await op<{ scanned: number }>("translation_staleness_tick", {});
      drained += tick.scanned;
      if (tick.scanned === 0) break;
      if (drained > 100_000) throw new Error("outbox never drained");
    }
    const upd = await execute(registry, adapter, SYS_CTX, "pages.update", {
      pageId: sourceId,
      title: "Pricing v2",
    });
    if (!upd.ok) throw new Error(JSON.stringify(upd.error));
    const tick = await op<{ marked: number; scanned: number }>("translation_staleness_tick", {});
    expect(tick.marked).toBe(1);
    const stale = await sqlAsPlugin(
      async (tx) =>
        (await tx.unsafe(
          `SELECT translation_status FROM plugin_international_site.page_variants WHERE page_id = '${variant.pageId}'`,
        )) as { translation_status: string }[],
    );
    expect(stale[0]?.translation_status).toBe("needs_update");

    // --- Bulk pass in UPDATE mode (variant already differs from source).
    aiScript.push(() => ({
      title: "Preise v2",
      slots: [{ slot: "s0", values: fields({ headline: "Willkommen v2" }) }],
    }));
    const bulk = await op<{ translated: number; paused: boolean; remaining: number }>(
      "translate_all_stale",
      {},
    );
    expect(bulk).toMatchObject({ translated: 1, paused: false, remaining: 0 });
    expect(aiCalls.at(-1)?.system).toContain("do NOT include unchanged slots");
    expect(aiCalls.at(-1)?.user).toContain(
      "## Existing translation (preserve unchanged slots verbatim)",
    );
    // Update mode merges: body_html (omitted by the model) survives.
    const merged = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(
          `SELECT ci."values"->>'headline' AS headline, ci."values"->>'body_html' AS body
           FROM page_modules pm JOIN content_instances ci ON ci.id = pm.content_instance_id
           WHERE pm.page_id = '${variant.pageId}'`,
        )) as { headline: string; body: string }[],
    );
    expect(merged[0]).toEqual({ headline: "Willkommen v2", body: "<p>Hallo <b>Welt</b></p>" });

    // --- Pause-on-overage: the cap error stops the pass cleanly.
    await sqlAsPlugin(async (tx) => {
      await tx.unsafe(
        `UPDATE plugin_international_site.page_variants SET translation_status = 'needs_update' WHERE page_id = '${variant.pageId}'`,
      );
    });
    aiScript.push(() => {
      throw new Error(
        "PluginAiCapExceeded: plugin 'international-site' has spent $1.00 of $1.00 cap in the last 24h.",
      );
    });
    const paused = await op<{
      translated: number;
      paused: boolean;
      remaining: number;
      nextStep?: string;
    }>("translate_all_stale", {});
    expect(paused.paused).toBe(true);
    expect(paused.translated).toBe(0);
    expect(paused.remaining).toBe(1);
    expect(paused.nextStep).toContain("propose_set_plugin_ai_cost_cap");
  }, 60_000);

  it("#591 — fills a new variant's meta description; a live variant's SEO is never overwritten, only flagged stale", async () => {
    const sourceId = await seedSourcePage("-seo");
    await op("set_locales", {
      locales: [
        { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
        { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
      ],
    });
    const sourceSeo = await execute(registry, adapter, SYS_CTX, "pages_seo.set", {
      pageId: sourceId,
      metaDescription: "Fair prices for every team.",
    });
    if (!sourceSeo.ok) throw new Error(JSON.stringify(sourceSeo.error));
    const variant = await op<{ pageId: string }>("create_variant", {
      sourcePageId: sourceId,
      localeCode: "de",
      slug: "t397-seo-preise",
    });
    const seoOf = async (pageId: string) => {
      const r = await execute(registry, adapter, SYS_CTX, "pages_seo.get", { pageId });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return (
        r.value as {
          seo: { metaDescription: string; autofilledAt: string | null; optimizedAt: string | null };
        }
      ).seo;
    };
    const translation = (meta: string) => () => ({
      title: "Preise",
      metaDescription: meta,
      slots: [
        { slot: "s0", values: fields({ headline: "Willkommen", body_html: "<p>Hallo</p>" }) },
      ],
    });

    // --- First translation of a new variant: the German description lands.
    aiScript.push(translation("Faire Preise für jedes Team."));
    const first = await op<{ seo: string }>("translate_variant", {
      variantPageId: variant.pageId,
    });
    expect(first.seo).toBe("filled");
    // The source has one, so the contract requires a translated one.
    expect(aiCalls.at(-1)?.jsonSchema.required).toContain("metaDescription");
    expect(aiCalls.at(-1)?.user).toContain(
      "Meta description:\n```\nFair prices for every team.\n```",
    );
    const filled = await seoOf(variant.pageId);
    expect(filled?.metaDescription).toBe("Faire Preise für jedes Team.");
    expect(filled?.autofilledAt).not.toBeNull();
    // The source's own description is untouched.
    expect((await seoOf(sourceId))?.metaDescription).toBe("Fair prices for every team.");

    // --- The variant goes live and its SEO is explicitly optimized.
    const pub = await execute(registry, adapter, SYS_CTX, "pages.set_status", {
      pageId: variant.pageId,
      status: "published",
    });
    if (!pub.ok) throw new Error(JSON.stringify(pub.error));
    const optimized = await execute(registry, adapter, SYS_CTX, "pages_seo.optimize", {
      pageId: variant.pageId,
      metaDescription: "Faire Preise – für Teams jeder Größe.",
    });
    if (!optimized.ok) throw new Error(JSON.stringify(optimized.error));

    // --- Re-translation of the live variant: kept, flagged stale, next step told.
    aiScript.push(translation("Ganz neue Beschreibung."));
    const again = await op<{ seo: string; nextStep?: string }>("translate_variant", {
      variantPageId: variant.pageId,
      mode: "full",
    });
    expect(again.seo).toBe("marked_stale");
    expect(again.nextStep).toContain("bulk_optimize_seo");
    const kept = await seoOf(variant.pageId);
    expect(kept?.metaDescription).toBe("Faire Preise – für Teams jeder Größe.");
    expect(kept?.optimizedAt).toBeNull();
    const staleList = await execute(registry, adapter, SYS_CTX, "pages_seo.list_stale", {
      limit: 200,
    });
    if (!staleList.ok) throw new Error(JSON.stringify(staleList.error));
    expect(
      (staleList.value as { pages: { pageId: string }[] }).pages.some(
        (p) => p.pageId === variant.pageId,
      ),
    ).toBe(true);

    // --- Back in draft (never live with this text): a re-translation fills again.
    const draft = await execute(registry, adapter, SYS_CTX, "pages.set_status", {
      pageId: variant.pageId,
      status: "draft",
    });
    if (!draft.ok) throw new Error(JSON.stringify(draft.error));
    aiScript.push(translation("Entwurfsbeschreibung."));
    const redraft = await op<{ seo: string }>("translate_variant", {
      variantPageId: variant.pageId,
      mode: "full",
    });
    expect(redraft.seo).toBe("filled");
    expect((await seoOf(variant.pageId))?.metaDescription).toBe("Entwurfsbeschreibung.");
  }, 60_000);

  it("#644 — a misnamed argument is refused with the right field name, never reaches SQL, and the correct call translates", async () => {
    const sourceId = await seedSourcePage("-644");
    await op("set_locales", {
      locales: [
        { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
        { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
      ],
    });
    const variant = await op<{ pageId: string; nextStep: string }>("create_variant", {
      sourcePageId: sourceId,
      localeCode: "de",
      slug: "t397-644-preise",
    });
    // The create result names the follow-up call with its exact argument.
    expect(variant.nextStep).toContain(`translate_variant({ variantPageId: "${variant.pageId}" })`);

    const owner = crypto.randomUUID();
    await sqlSystem(async (tx) => {
      await tx.unsafe(
        `INSERT INTO actors (id, kind, display_name) VALUES ('${owner}', 'human', 'owner')`,
      );
      await tx.unsafe(
        `INSERT INTO users (id, email, password_hash) VALUES ('${owner}', '${owner}@t644.test', 'test-only')`,
      );
      await tx.unsafe(
        `INSERT INTO user_roles (user_id, role_id) SELECT '${owner}', id FROM roles WHERE name = 'owner'`,
      );
    });
    const asToolCall = (args: unknown) =>
      runPluginOperation({
        invocation: { origin: "approved", actorId: owner },
        pluginSlug: "international-site",
        operationName: "translate_variant",
        args,
      });

    // The live run's call: the id under the create result's `pageId` key.
    // The tool's own schema refuses it before the handler runs.
    const callsBefore = aiCalls.length;
    const misnamed = await asToolCall({ pageId: variant.pageId });
    expect(misnamed.ok).toBe(false);
    if (!misnamed.ok) {
      expect(misnamed.error.message).toContain("InvalidToolInput");
      expect(misnamed.error.message).toContain("variantPageId (required)");
      expect(misnamed.error.message).not.toContain("Failed query");
    }
    expect(aiCalls.length).toBe(callsBefore);

    // Below the tool boundary, the operation validates its own input (#741)
    // and refuses the misnamed key naming the right field — the value is
    // never bound as an empty SQL fragment.
    const unbound = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "international-site",
      operationName: "translate_variant",
      args: { pageId: variant.pageId },
    });
    expect(unbound.ok).toBe(false);
    if (!unbound.ok) {
      expect(unbound.error.message).toContain("variantPageId");
      expect(unbound.error.message).not.toContain("Failed query");
    }

    // The correctly named call translates the variant.
    aiScript.push(() => ({
      title: "Preise",
      slots: [
        { slot: "s0", values: fields({ headline: "Willkommen", body_html: "<p>Hallo Welt</p>" }) },
      ],
    }));
    const translated = await asToolCall({ variantPageId: variant.pageId });
    if (!translated.ok) throw new Error(translated.error.message);
    expect((translated.value as { slotsApplied: number }).slotsApplied).toBe(1);
  }, 60_000);
});

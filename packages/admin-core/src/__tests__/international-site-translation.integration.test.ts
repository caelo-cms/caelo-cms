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

/** Scripted provider: each queued responder handles ONE complete()
 *  call; prompts are recorded for fixture assertions. */
const aiCalls: Array<{ system: string; user: string }> = [];
const aiScript: Array<() => string> = [];
const scriptedProvider = {
  complete: async (opts: {
    system: string;
    messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  }) => {
    aiCalls.push({ system: opts.system, user: opts.messages[0]?.content ?? "" });
    const next = aiScript.shift();
    if (!next) throw new Error("scripted provider: no responder queued");
    return { text: next(), inputTokens: 10, outputTokens: 10 };
  },
};

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
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

/** Seed a page whose single placement carries translatable values. */
async function seedSourcePage(): Promise<string> {
  const templateId = await sqlSystem(async (tx) => {
    const lay = (await tx.unsafe(
      `INSERT INTO layouts (slug, display_name, html, css) VALUES ('t397-lay', 'L', '<html></html>', '') RETURNING id::text AS id`,
    )) as { id: string }[];
    const tpl = (await tx.unsafe(
      `INSERT INTO templates (slug, display_name, kind, html, css, layout_id) VALUES ('t397-tpl', 'T', 'content', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
    )) as { id: string }[];
    const id = tpl[0]?.id;
    if (!id) throw new Error("seed failed");
    return id;
  });
  const created = await execute(registry, adapter, SYS_CTX, "pages.create", {
    slug: "t397-pricing",
    title: "Pricing",
    templateId,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const pageId = (created.value as { pageId: string }).pageId;
  await sqlSystem(async (tx) => {
    const mod = (await tx.unsafe(
      `INSERT INTO modules (slug, display_name, type, kind, html)
       VALUES ('t397-hero', 'Hero', 't397-hero', 'hero', '<h1>{{headline}}</h1><div>{{body_html}}</div>')
       RETURNING id::text AS id`,
    )) as { id: string }[];
    const ci = (await tx.unsafe(
      `INSERT INTO content_instances (module_id, slug, display_name, "values")
       VALUES ('${mod[0]?.id}', 't397-hero-src', 'Hero src', '{"headline": "Welcome", "body_html": "<p>Hello <b>world</b></p>"}')
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
    aiScript.push(() =>
      JSON.stringify({
        title: "Preise",
        slots: [
          { blockName: "main", position: 0, values: { headline: "Willkommen" } },
          { blockName: "ghost", position: 9, values: { headline: "X" } },
        ],
      }),
    );
    const refused = await runPluginOperation({
      pluginSlug: "international-site",
      operationName: "translate_variant",
      args: { variantPageId: variant.pageId },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("structural lock");

    // --- Full-mode translation (fenced response exercises stripJsonFence).
    aiScript.push(
      () =>
        "```json\n" +
        JSON.stringify({
          title: "Preise",
          slots: [
            {
              blockName: "main",
              position: 0,
              values: { headline: "Willkommen", body_html: "<p>Hallo <b>Welt</b></p>" },
            },
          ],
        }) +
        "\n```",
    );
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
    aiScript.push(() =>
      JSON.stringify({
        title: "Preise v2",
        slots: [{ blockName: "main", position: 0, values: { headline: "Willkommen v2" } }],
      }),
    );
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
    expect(paused.nextStep).toContain("/security/plugins/international-site");
  }, 60_000);
});

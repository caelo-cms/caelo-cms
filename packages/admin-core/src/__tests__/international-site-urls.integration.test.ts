// SPDX-License-Identifier: MPL-2.0

/**
 * #395 — the international-site URL behaviour end to end with the REAL
 * plugin on the REAL engine:
 *
 *   - activation on an existing site is a ZERO-DIFF retrofit (no
 *     Owner click needed — the propose refuses with "no URL changes");
 *   - adding `de` + linking a variant routes the move through the
 *     generic propose_url_migration with redirect fan-out;
 *   - the default locale keeps serving BARE (the "one variant without
 *     prefix" requirement) and the designated home composes to the
 *     prefix root;
 *   - localized slugs stay first-class (linkage is group_id, never
 *     slug-derived);
 *   - deactivation reverses the diff from the MATERIALIZED paths.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  decodePagePath,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
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
  requestId: "t395",
};
const HUMAN_CTX: ExecutionContext = { ...SYS_CTX, actorKind: "human" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pluginId = "";

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

/** Write into the plugin's OWN schema — its RLS policy keys on
 *  caelo.plugin_id, exactly like ctx.adminQuery does. */
async function sqlAsPlugin<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'plugin'");
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
    await tx.unsafe("DELETE FROM url_migration_pending_actions");
    await tx.unsafe(
      "DELETE FROM redirects WHERE from_path LIKE '/t395-%' OR from_path LIKE '/de/t395-%'",
    );
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'international-site')
    )`);
    // create_variant writes through pages.duplicate, so the plugin actor
    // owns snapshots too; children cascade from site_snapshots.
    await tx.unsafe(`DELETE FROM site_snapshots WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'international-site')
    )`);
    await tx.unsafe(
      "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'international-site')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe("UPDATE site_defaults SET home_page_id = NULL WHERE id = 1");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't395-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't395-%'");
    await tx.unsafe("DELETE FROM layouts WHERE slug LIKE 't395-%'");
  });
}

async function bootPlugin(): Promise<void> {
  resetPluginHost();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  const loaded = report.loaded[0];
  if (!loaded) throw new Error("plugin did not load");
  const sql = new SQL(ADMIN_URL);
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx.unsafe(
        `SELECT id::text AS id FROM plugins WHERE slug = 'international-site'`,
      )) as { id: string }[];
    });
    pluginId = rows[0]?.id ?? "";
  } finally {
    await sql.end();
  }
  if (!pluginId) throw new Error("no plugin row");
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

async function seedPage(slug: string): Promise<string> {
  const templateId = await sqlSystem(async (tx) => {
    const lay = (await tx.unsafe(
      `INSERT INTO layouts (slug, display_name, html, css) VALUES ('${slug}-lay', 'L', '<html></html>', '') RETURNING id::text AS id`,
    )) as { id: string }[];
    const tpl = (await tx.unsafe(
      `INSERT INTO templates (slug, display_name, kind, html, css, layout_id) VALUES ('${slug}-tpl', 'T', 'content', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
    )) as { id: string }[];
    const id = tpl[0]?.id;
    if (!id) throw new Error("seed failed");
    return id;
  });
  const created = await execute(registry, adapter, SYS_CTX, "pages.create", {
    slug,
    title: slug,
    templateId,
  });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return (created.value as { pageId: string }).pageId;
}

describe("#395 — international-site URL contributions on the generic engine", () => {
  it("full arc: zero-diff retrofit → add de → gated move → localized slug → home at prefix root → teardown", async () => {
    // Existing single-language site.
    const pricingId = await seedPage("t395-pricing");
    const homeId = await seedPage("t395-home");
    const setHome = await execute(registry, adapter, SYS_CTX, "pages.set_home_page", {
      pageId: homeId,
    });
    if (!setHome.ok) throw new Error(JSON.stringify(setHome.error));

    // 1. ACTIVATE — zero-diff retrofit: no locales yet ⇒ nothing moves.
    await bootPlugin();
    const retrofit = await execute(
      registry,
      adapter,
      SYS_CTX,
      "url_migrations.propose_migrate",
      {},
    );
    expect(retrofit.ok).toBe(false);
    if (!retrofit.ok) expect(JSON.stringify(retrofit.error)).toContain("no URL changes");

    // 2. Register en (default) + de (subdirectory); still zero-diff —
    // every existing page belongs to the bare default.
    await sqlAsPlugin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO "plugin_international_site"."locales" (code, display_name, url_strategy, is_default) VALUES ('en', 'English', 'none', true)`,
      );
      await tx.unsafe(
        `INSERT INTO "plugin_international_site"."locales" (code, display_name, url_strategy, is_default) VALUES ('de', 'Deutsch', 'subdirectory', false)`,
      );
    });
    const stillZero = await execute(
      registry,
      adapter,
      SYS_CTX,
      "url_migrations.propose_migrate",
      {},
    );
    expect(stillZero.ok).toBe(false);

    // 3. A German variant with a LOCALIZED slug, linked by group_id.
    const preiseId = await seedPage("t395-preise");
    await sqlAsPlugin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO "plugin_international_site"."page_variants" (group_id, page_id, locale_code, translation_status)
         VALUES (gen_random_uuid(), '${pricingId}', 'en', 'source')`,
      );
    });
    // Link both variants under ONE group id.
    const groupId = await sqlAsPlugin(async (tx) => {
      const g = (await tx.unsafe(
        `SELECT group_id::text AS group_id FROM "plugin_international_site"."page_variants" WHERE page_id = '${pricingId}'`,
      )) as { group_id: string }[];
      const id = g[0]?.group_id;
      if (!id) throw new Error("no group");
      await tx.unsafe(
        `INSERT INTO "plugin_international_site"."page_variants" (group_id, page_id, locale_code, translation_status)
         VALUES ('${id}', '${preiseId}', 'de', 'up_to_date')`,
      );
      return id;
    });
    expect(groupId).toBeTruthy();

    // 4. The de-variant now composes under /de/ — gated move.
    const proposed = await execute(registry, adapter, SYS_CTX, "url_migrations.propose_migrate", {
      reason: "add German",
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const preview = (proposed.value as { preview: { sample: string[]; pagesMoved: number } })
      .preview;
    expect(preview.pagesMoved).toBe(1);
    expect(preview.sample[0]).toBe("/t395-preise → /de/t395-preise");
    const applied = await execute(registry, adapter, HUMAN_CTX, "url_migrations.execute_proposal", {
      proposalId: (proposed.value as { proposalId: string }).proposalId,
    });
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));

    const paths = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(
          `SELECT slug, current_path FROM pages WHERE slug LIKE 't395-%' ORDER BY slug`,
        )) as { slug: string; current_path: string }[],
    );
    expect(paths).toEqual([
      { slug: "t395-home", current_path: "/" },
      { slug: "t395-preise", current_path: "/de/t395-preise" },
      { slug: "t395-pricing", current_path: "/t395-pricing" },
    ]);

    // 5. Decode inverts the prefix (strict: unknown codes pass through).
    expect(decodePagePath("/de/t395-preise")).toEqual({
      slug: "t395-preise",
      annotations: { locale: "de" },
    });
    expect(decodePagePath("/fr/t395-x").annotations).toEqual({});

    // 6. The German HOME composes to the prefix root "/de", not
    //    "/de/<slug>".
    //
    //    Core designates exactly ONE home; a multilingual site has one
    //    per locale, and core cannot derive the others since it has no
    //    locale concept (epic #380). The variant group is the missing
    //    link, so the plugin annotates its locale roots and the
    //    composer honours it. A live run showed what happens without
    //    this: the AI correctly worked out the German home belongs at
    //    "/de/", reached for the only lever it had — giving the variant
    //    the sentinel slug "home" — and hit the site-wide slug
    //    uniqueness.
    const deHomeId = await seedPage("t395-startseite");
    await sqlAsPlugin(async (tx) => {
      // Grouped WITH the designated home; that grouping is the whole
      // signal. A group of its own would leave it an ordinary page.
      await tx.unsafe(
        `INSERT INTO "plugin_international_site"."page_variants" (group_id, page_id, locale_code, translation_status)
         VALUES (gen_random_uuid(), '${homeId}', 'en', 'source')`,
      );
      const grp = (await tx.unsafe(
        `SELECT group_id::text AS group_id FROM "plugin_international_site"."page_variants" WHERE page_id = '${homeId}'`,
      )) as { group_id: string }[];
      await tx.unsafe(
        `INSERT INTO "plugin_international_site"."page_variants" (group_id, page_id, locale_code, translation_status)
         VALUES ('${grp[0]?.group_id}', '${deHomeId}', 'de', 'up_to_date')`,
      );
    });
    const move2 = await execute(registry, adapter, SYS_CTX, "url_migrations.propose_migrate", {});
    if (!move2.ok) throw new Error(JSON.stringify(move2.error));
    await execute(registry, adapter, HUMAN_CTX, "url_migrations.execute_proposal", {
      proposalId: (move2.value as { proposalId: string }).proposalId,
    });

    const deHomePath = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(`SELECT current_path FROM pages WHERE id = '${deHomeId}'`)) as {
          current_path: string;
        }[],
    );
    expect(deHomePath[0]?.current_path).toBe("/de");
    // The English home keeps "/" — two locale roots, two paths, so the
    // current_path uniqueness the composition rests on still holds.
    const enHomePath = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(`SELECT current_path FROM pages WHERE id = '${homeId}'`)) as {
          current_path: string;
        }[],
    );
    expect(enHomePath[0]?.current_path).toBe("/");

    // 7. TEARDOWN — disable the plugin; contributions go inert; the
    // reverse diff moves everything back from the materialized paths.
    const disabled = await execute(registry, adapter, HUMAN_CTX, "plugins.disable", {
      slug: "international-site",
    });
    if (!disabled.ok) throw new Error(JSON.stringify(disabled.error));
    const back = await execute(registry, adapter, SYS_CTX, "url_migrations.propose_migrate", {
      reason: "deactivate international-site",
    });
    if (!back.ok) throw new Error(JSON.stringify(back.error));
    const backPreview = (back.value as { preview: { sample: string[] } }).preview;
    expect(backPreview.sample).toContain("/de/t395-preise → /t395-preise");
    const backApplied = await execute(
      registry,
      adapter,
      HUMAN_CTX,
      "url_migrations.execute_proposal",
      { proposalId: (back.value as { proposalId: string }).proposalId },
    );
    if (!backApplied.ok) throw new Error(JSON.stringify(backApplied.error));
    const finalPaths = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(`SELECT current_path FROM pages WHERE id = '${preiseId}'`)) as {
          current_path: string;
        }[],
    );
    expect(finalPaths[0]?.current_path).toBe("/t395-preise");
    const redirect = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(`SELECT to_path FROM redirects WHERE from_path = '/de/t395-preise'`)) as {
          to_path: string;
        }[],
    );
    expect(redirect[0]?.to_path).toBe("/t395-preise");
  });

  it("host strategy without url_host fails LOUDLY at composition", async () => {
    // Full reset — the previous arc deliberately left the plugin
    // DISABLED, and #393's persistence would keep it inert.
    await cleanup();
    await bootPlugin();
    const brokenId = await seedPage("t395-broken");
    await sqlAsPlugin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO "plugin_international_site"."locales" (code, display_name, url_strategy, is_default) VALUES ('en', 'English', 'none', true)`,
      );
      await tx.unsafe(
        `INSERT INTO "plugin_international_site"."locales" (code, display_name, url_strategy, url_host, is_default) VALUES ('fr', 'Français', 'subdomain', NULL, false)`,
      );
      await tx.unsafe(
        `INSERT INTO "plugin_international_site"."page_variants" (group_id, page_id, locale_code, translation_status)
         VALUES (gen_random_uuid(), '${brokenId}', 'fr', 'up_to_date')`,
      );
    });
    const proposed = await execute(
      registry,
      adapter,
      SYS_CTX,
      "url_migrations.propose_migrate",
      {},
    );
    expect(proposed.ok).toBe(false);
    if (!proposed.ok) {
      expect(JSON.stringify(proposed.error)).toContain("no url_host configured");
    }
  });
});

/**
 * The counterpart of the composer fix above, one layer earlier. #445
 * taught the URL composer that a variant of the home page is its
 * locale's root ("/de"), but `create_variant` still demanded a slug —
 * and for the home page there is no honest answer to give it. Slugs
 * went site-wide unique with #384, so the AI's natural expression of
 * "this is the German homepage" (reusing "home") collides with the
 * English page, and every rename it then attempts collides too. A live
 * run walked exactly that dead end.
 */
describe("create_variant — the slug the caller cannot invent", () => {
  it("mints the locale root itself and refuses a slug for it", async () => {
    await cleanup();
    const homeId = await seedPage("t395-lr-home");
    const setHome = await execute(registry, adapter, SYS_CTX, "pages.set_home_page", {
      pageId: homeId,
    });
    if (!setHome.ok) throw new Error(JSON.stringify(setHome.error));
    await bootPlugin();
    await sqlAsPlugin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO "plugin_international_site"."locales" (code, display_name, url_strategy, is_default) VALUES ('en', 'English', 'none', true)`,
      );
      await tx.unsafe(
        `INSERT INTO "plugin_international_site"."locales" (code, display_name, url_strategy, is_default) VALUES ('de', 'Deutsch', 'subdirectory', false)`,
      );
    });

    // Passing one is an error rather than a silent drop: the slug would
    // have no effect on the URL, and pretending otherwise is the
    // fallback CLAUDE.md §2 forbids.
    const withSlug = await runPluginOperation({
      pluginSlug: "international-site",
      operationName: "create_variant",
      args: { sourcePageId: homeId, localeCode: "de", slug: "home" },
    });
    expect(withSlug.ok).toBe(false);
    if (!withSlug.ok) {
      expect(withSlug.error.message).toContain("root of that locale");
      expect(withSlug.error.message).toContain("Omit");
    }

    const minted = await runPluginOperation({
      pluginSlug: "international-site",
      operationName: "create_variant",
      args: { sourcePageId: homeId, localeCode: "de", title: "Startseite" },
    });
    if (!minted.ok) throw new Error(JSON.stringify(minted.error));
    const created = minted.value as { pageId: string; slug: string; isLocaleRoot: boolean };
    expect(created.isLocaleRoot).toBe(true);
    expect(created.slug).toBe("t395-lr-home-de");

    const path = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(`SELECT current_path FROM pages WHERE id = '${created.pageId}'`)) as {
          current_path: string;
        }[],
    );
    expect(path[0]?.current_path).toBe("/de");
  });

  it("still requires a localized slug for an ordinary page, and names the clash", async () => {
    const aboutId = await seedPage("t395-lr-about");

    const noSlug = await runPluginOperation({
      pluginSlug: "international-site",
      operationName: "create_variant",
      args: { sourcePageId: aboutId, localeCode: "de" },
    });
    expect(noSlug.ok).toBe(false);
    if (!noSlug.ok) expect(noSlug.error.message).toContain("the slug IS its URL segment");

    // Reusing the source's own slug is the mistake worth explaining:
    // core answers "page already exists", which reads as "you are done"
    // and invites a pointless retry instead of a rename.
    const clash = await runPluginOperation({
      pluginSlug: "international-site",
      operationName: "create_variant",
      args: { sourcePageId: aboutId, localeCode: "de", slug: "t395-lr-about" },
    });
    expect(clash.ok).toBe(false);
    if (!clash.ok) {
      expect(clash.error.message).toContain("unique across the WHOLE site");
      expect(clash.error.message).toContain("t395-lr-about-de");
    }

    const ok = await runPluginOperation({
      pluginSlug: "international-site",
      operationName: "create_variant",
      args: { sourcePageId: aboutId, localeCode: "de", slug: "t395-lr-ueber-uns" },
    });
    if (!ok.ok) throw new Error(JSON.stringify(ok.error));
    expect((ok.value as { isLocaleRoot: boolean }).isLocaleRoot).toBe(false);
  });
});

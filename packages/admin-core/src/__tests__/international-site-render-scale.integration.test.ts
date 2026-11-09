// SPDX-License-Identifier: MPL-2.0

/**
 * #1213 — international-site's render hooks at site scale.
 *
 * Two promises, measured against real Postgres:
 *
 * 1. Completeness. A store read returns at most 1000 rows; the matrix
 *    behind hreflang, sitemap alternates and the language switcher used to
 *    read "the first 1000" variant rows and silently drop the rest, and
 *    other reads threw at 1000. With 1,600 variants every published page
 *    must get its full set, through the same host entry points a build
 *    uses.
 * 2. Cost. One editor preview must not cost more plugin round-trips on a
 *    big site than on a small one: the hooks read the rendered page's own
 *    rows (and its variant group), not the site, and the composition
 *    points of one pass share what they read (`renderId`). Counted as the
 *    Query API operations the adapter runs for the preview's plugin
 *    calls — every plugin store read and every core call is one.
 *
 * Only the preview's own operations count. The plugin host keeps running
 * while a preview renders: international-site's `locale-cache-refresh`
 * worker ticks at every full minute (two store reads) and its
 * `source-hash-backfill` worker at second 30. A counter that took every
 * operation in a time window charged a tick to whichever preview it
 * overlapped (CI run 41608208651: 16 calls instead of 14). The count
 * follows the preview's async context instead, so background work is
 * neither counted nor stopped.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  bootstrap,
  clearLinkResolveCache,
  collectContributions,
  MAIN_RENDER,
  type RenderScope,
  renderInvocation,
  resetPluginHost,
  resolveContentVariants,
  resolveLinkVariants,
  resolveListSources,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoHomePageType } from "./_template-page-type.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1213",
};
const BASE = "https://example.com";
const PFX = "t1213-";
/** 800 groups × 2 languages: past one store read (1000) and one core id batch. */
const BIG_GROUPS = 800;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let pageTypeId = "";
let pluginId = "";
let seoBaseBefore: string | null = null;

/**
 * The operations of the preview being counted. An operation is counted
 * when it runs in the preview's async context, i.e. on behalf of one of
 * its plugin calls; a worker tick started by the host's scheduler runs
 * outside it.
 */
const previewCalls = new AsyncLocalStorage<string[]>();
/** Previews rendering right now. */
let previewsRunning = 0;
/**
 * The operations of a worker tick a test starts itself, each with whether
 * a preview was rendering when it ran.
 */
const tickCalls = new AsyncLocalStorage<{ name: string; duringPreview: boolean }[]>();
/** The inputs of the plugin's private store reads in this context (#1269). */
const storeReads = new AsyncLocalStorage<string[]>();

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

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS_CTX, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function pluginOp<T>(operationName: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}%'`);
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}%'`);
    await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${PFX}%'`);
  });
}

/**
 * `groups` English/German page pairs, published, each pair one variant
 * group — inserted in bulk (creating 1,600 pages through pages.create
 * would test pages.create). Returns the pairs.
 */
async function seedGroups(tag: string, groups: number): Promise<{ en: string; de: string }[]> {
  return sqlSystem(async (tx) => {
    const pairs = (await tx.unsafe(
      `WITH n AS (SELECT generate_series(1, ${groups}) AS i),
            en AS (
              INSERT INTO pages (slug, title, short_title, template_id, page_type_id, page_type_confirmed, current_path, status)
              SELECT '${PFX}${tag}-' || i, 'P' || i, 'P' || i, '${templateId}', '${pageTypeId}', true,
                     '/${PFX}${tag}-' || i, 'published' FROM n
              RETURNING id::text AS id, slug),
            de AS (
              INSERT INTO pages (slug, title, short_title, template_id, page_type_id, page_type_confirmed, current_path, status)
              SELECT '${PFX}${tag}-' || i || '-de', 'P' || i, 'P' || i, '${templateId}', '${pageTypeId}', true,
                     '/de/${PFX}${tag}-' || i || '-de', 'published' FROM n
              RETURNING id::text AS id, slug)
       SELECT en.id AS en, de.id AS de FROM en JOIN de ON de.slug = en.slug || '-de'`,
    )) as { en: string; de: string }[];
    await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${pluginId}', true)`);
    const values = pairs.map((p) => `('${p.en}', '${p.de}', gen_random_uuid())`).join(", ");
    // The source joins first: the order hreflang lists the variants in.
    await tx.unsafe(
      `WITH pairs(en, de, g) AS (VALUES ${values})
       INSERT INTO plugin_international_site.page_variants
         (group_id, page_id, locale_code, translation_status, created_at)
       SELECT g, en::uuid, 'en', 'source', now() - interval '1 second' FROM pairs
       UNION ALL
       SELECT g, de::uuid, 'de', 'up_to_date', now() FROM pairs`,
    );
    return pairs;
  });
}

interface PreviewResult {
  readonly calls: string[];
  readonly hreflang: string[];
  readonly switcher: string[];
}

/**
 * The plugin calls one editor preview of `pageId` makes, in one render
 * pass: URL annotations, the switcher list source, the content variants,
 * the link partition for the pages the page references, and the head
 * contributions (hreflang).
 */
/** A human Owner (unlinking a variant needs content.write); returns its actor id. */
async function seedOwner(): Promise<string> {
  const owner = crypto.randomUUID();
  await sqlSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${owner}::uuid, 'human', 'Owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${owner}::uuid, ${`${owner}@t1269.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${owner}::uuid, id FROM roles WHERE name = 'owner'`;
  });
  return owner;
}

/** The editor toolbar's language place for `pageId`, and the operations it ran (#1255). */
async function languageToolbar(
  pageId: string,
): Promise<{ calls: string[]; items: { label: string; detail?: string }[] }> {
  const calls: string[] = [];
  previewsRunning += 1;
  try {
    return await previewCalls.run(calls, async () => {
      const r = await runPluginOperation({
        invocation: renderInvocation({ chatBranchId: null, renderId: crypto.randomUUID() }),
        pluginSlug: "international-site",
        operationName: "editor_languages",
        args: { pageId },
      });
      if (!r.ok) throw new Error(r.error.message);
      const state = r.value as { items?: { label: string; detail?: string }[] };
      return { calls: [...calls], items: state.items ?? [] };
    });
  } finally {
    previewsRunning -= 1;
  }
}

async function preview(
  pageId: string,
  referenced: string[],
  chatBranchId: string | null = null,
): Promise<PreviewResult> {
  const scope: RenderScope = { chatBranchId, renderId: crypto.randomUUID() };
  const calls: string[] = [];
  // Each preview here measures a cold pass; the kept link-resolve answers
  // (#1269) have their own tests below.
  clearLinkResolveCache();
  previewsRunning += 1;
  return previewCalls
    .run(calls, async () => {
      const annotated = await runPluginOperation({
        invocation: renderInvocation(scope),
        pluginSlug: "international-site",
        operationName: "url_annotations",
        args: { pageIds: [pageId] },
      });
      if (!annotated.ok) throw new Error(annotated.error.message);
      const sources = await resolveListSources([pageId], scope, "directory");
      await resolveContentVariants([{ pageId, placements: [] }], scope);
      await resolveLinkVariants([pageId, ...referenced], scope, { keep: true });
      const contributed = await collectContributions([pageId], {
        ...scope,
        siteBaseUrl: BASE,
        pageUrlStyle: "directory",
      });
      return {
        calls: [...calls],
        hreflang: (contributed.head.get(pageId) ?? []).map((e) =>
          e.kind === "link" ? `${e.hreflang} ${e.href}` : JSON.stringify(e),
        ),
        switcher: (sources.get(pageId)?.language_links ?? []).map((i) => String(i.values.locale)),
      };
    })
    .finally(() => {
      previewsRunning -= 1;
    });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  const runOperation = adapter.runOperation.bind(adapter);
  adapter.runOperation = ((op, ctx, input) => {
    const name = `${ctx.actorKind}:${op.name}`;
    previewCalls.getStore()?.push(name);
    tickCalls.getStore()?.push({ name, duringPreview: previewsRunning > 0 });
    if (op.name === "plugin_storage.list") storeReads.getStore()?.push(JSON.stringify(input));
    return runOperation(op, ctx, input);
  }) as typeof adapter.runOperation;
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  const report = await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  const seo = (await sysOp("site_defaults.get_seo", {})) as { siteBaseUrl: string | null };
  seoBaseBefore = seo.siteBaseUrl;
  await sqlSystem((tx) => tx`UPDATE site_defaults SET site_base_url = ${BASE} WHERE id = 1`);
  const ids = await sqlSystem(async (tx) => {
    const lay = (await tx.unsafe(
      `INSERT INTO layouts (slug, display_name, html, css) VALUES ('${PFX}lay', 'L', '<html></html>', '') RETURNING id::text AS id`,
    )) as { id: string }[];
    const tpl = (await tx.unsafe(
      `INSERT INTO templates (slug, display_name, html, css, layout_id) VALUES ('${PFX}tpl', 'T', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
    )) as { id: string }[];
    await adoptTemplateIntoHomePageType(tx, tpl[0]?.id ?? "");
    const type = (await tx.unsafe(
      `SELECT id::text AS id FROM page_types WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL`,
    )) as { id: string }[];
    const plugin = (await tx.unsafe(
      `SELECT id::text AS id FROM plugins WHERE slug = 'international-site'`,
    )) as { id: string }[];
    return { template: tpl[0]?.id ?? "", pageType: type[0]?.id ?? "", plugin: plugin[0]?.id ?? "" };
  });
  templateId = ids.template;
  pageTypeId = ids.pageType;
  pluginId = ids.plugin;
  if (!templateId || !pageTypeId || !pluginId)
    throw new Error(`seed failed: ${JSON.stringify(ids)}`);
  await pluginOp("set_locales", {
    locales: [
      { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
    ],
  });
});

afterAll(async () => {
  await sqlSystem(
    (tx) => tx`UPDATE site_defaults SET site_base_url = ${seoBaseBefore} WHERE id = 1`,
  );
  await cleanup();
  await adapter.close();
});

describe("#1213 — international-site render hooks at scale", () => {
  let small: { en: string; de: string }[] = [];
  let smallPreview: PreviewResult | null = null;

  it("one preview on a small site: hreflang + switcher, and its plugin calls", async () => {
    small = await seedGroups("s", 3);
    const target = small[0];
    if (!target) throw new Error("seed");
    smallPreview = await preview(target.de, [small[1]?.en ?? "", small[2]?.de ?? ""]);
    expect(smallPreview.hreflang).toEqual([
      `en ${BASE}/${PFX}s-1/`,
      `de ${BASE}/de/${PFX}s-1-de/`,
      `x-default ${BASE}/${PFX}s-1/`,
    ]);
    expect(smallPreview.switcher).toEqual(["en", "de"]);
    // The pass shares its reads: 35 operations before #1213 (the registry
    // and the variant rows re-read by every hook, two whole-site
    // pages.list), 14 since. #1269 adds the host's one journal check of the
    // kept link-resolve answers, and a cold refill reads in a pass of its
    // own (so it is read after the mark it is kept with): 17. A warm pass
    // asks the plugin nothing. A new read in a render hook shows up here.
    expect(smallPreview.calls.length).toBeLessThanOrEqual(17);
    expect(smallPreview.calls).toContain("system:plugin_changes.check_mark");
    expect(smallPreview.calls).not.toContain("plugin:pages.list");
  });

  let smallToolbar: { calls: string[]; items: { label: string; detail?: string }[] } | null = null;

  it("the editor's language place reads the page's variant group, not the site (#1255)", async () => {
    const target = small[0];
    if (!target) throw new Error("previous test did not run");
    smallToolbar = await languageToolbar(target.de);
    expect(smallToolbar.items.map((i) => i.label)).toEqual(["Deutsch", "English"]);
    expect(smallToolbar.calls).not.toContain("plugin:pages.list");
  });

  it("the same preview on a site of 1,600+ variants costs exactly as many calls", async () => {
    await seedGroups("b", BIG_GROUPS);
    const target = small[0];
    if (!target || !smallPreview) throw new Error("previous test did not run");
    const big = await preview(target.de, [small[1]?.en ?? "", small[2]?.de ?? ""]);
    expect(big.hreflang).toEqual(smallPreview.hreflang);
    expect(big.switcher).toEqual(smallPreview.switcher);
    expect(big.calls.length).toBe(smallPreview.calls.length);
    expect([...big.calls].sort()).toEqual([...smallPreview.calls].sort());
    // The language place too: it used to read every variant row (in pages
    // of 1000) and every page of the site on each editor load.
    if (!smallToolbar) throw new Error("toolbar baseline did not run");
    const bigToolbar = await languageToolbar(target.de);
    expect(bigToolbar.items).toEqual(smallToolbar.items);
    expect([...bigToolbar.calls].sort()).toEqual([...smallToolbar.calls].sort());
  });

  it("a worker tick while a preview renders is not the preview's cost", async () => {
    const target = small[0];
    if (!target || !smallPreview) throw new Error("previous test did not run");
    // What the scheduler runs at every full minute, started the way its
    // cron job starts it: outside any render pass, during this one.
    const ran: { name: string; duringPreview: boolean }[] = [];
    const tick = tickCalls.run(ran, () =>
      runPluginOperation({
        invocation: { origin: "worker", actorId: SYSTEM_ACTOR_ID },
        pluginSlug: "international-site",
        operationName: "refresh_locales",
        args: { _trigger: "worker", workerName: "locale-cache-refresh" },
      }),
    );
    const during = await preview(target.de, [small[1]?.en ?? "", small[2]?.de ?? ""]);
    const ticked = await tick;
    if (!ticked.ok) throw new Error(ticked.error.message);
    // The tick's two registry reads (locales, settings) ran while the
    // preview rendered — the overlap CI run 41608208651 hit.
    expect(ran.map((r) => r.name)).toEqual([
      "plugin:plugin_storage.list",
      "plugin:plugin_storage.list",
    ]);
    expect(ran.some((r) => r.duringPreview)).toBe(true);
    expect([...during.calls].sort()).toEqual([...smallPreview.calls].sort());
  });

  it("a later pass reads again: an unpublished variant drops out of hreflang", async () => {
    const target = small[0];
    if (!target) throw new Error("seed");
    await sysOp("pages.set_status", { pageId: target.en, status: "draft" });
    try {
      const after = await preview(target.de, []);
      expect(after.hreflang).toEqual([]);
      expect(after.switcher).toEqual([]);
    } finally {
      await sysOp("pages.set_status", { pageId: target.en, status: "published" });
    }
  });

  it("a build over every page gets every variant's hreflang, switcher and partition", async () => {
    const pages = (await sqlSystem(
      (tx) => tx`SELECT id::text AS id, current_path FROM pages WHERE slug LIKE ${`${PFX}%`}`,
    )) as { id: string; current_path: string }[];
    expect(pages.length).toBeGreaterThanOrEqual(1500);
    const ids = pages.map((p) => p.id);
    const pathOf = new Map(pages.map((p) => [p.id, p.current_path]));

    const contributed = await collectContributions(ids, {
      ...MAIN_RENDER,
      siteBaseUrl: BASE,
      pageUrlStyle: "directory",
    });
    for (const id of ids) {
      const head = contributed.head.get(id) ?? [];
      const langs = head.map((e) => (e.kind === "link" ? e.hreflang : "?"));
      expect(langs).toEqual(["en", "de", "x-default"]);
      const self = head.find((e) => e.kind === "link" && e.href === `${BASE}${pathOf.get(id)}/`);
      expect(self).toBeDefined();
      expect(contributed.sitemap.get(id)?.alternates?.length).toBe(3);
    }

    const sources = await resolveListSources(ids, MAIN_RENDER, "directory");
    for (const id of ids) {
      expect((sources.get(id)?.language_links ?? []).map((i) => i.values.locale)).toEqual([
        "en",
        "de",
      ]);
    }

    const partition = await resolveLinkVariants(ids, MAIN_RENDER);
    expect(partition.size).toBe(ids.length);
    const groups = new Set([...partition.values()].map((v) => v.group));
    expect(groups.size).toBe(ids.length / 2);
  });
  it("a chat's preview sees the chat's pending delete; main does not", async () => {
    const [first, second] = small;
    if (!first || !second) throw new Error("seed");
    const session = await sysOp<{ chatSessionId: string; chatBranchId: string }>(
      "chat.create_session",
      { isolation: "experiment", title: `${PFX}chat` },
    );
    const chatCtx: ExecutionContext = {
      ...SYS_CTX,
      chatBranchId: session.chatBranchId,
      chatTaskId: session.chatSessionId,
    };
    const statuses = async (ctx: ExecutionContext) => {
      const r = await execute(registry, adapter, ctx, "pages.list_statuses", {
        pageIds: [first.en, second.en, second.de],
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value;
    };
    try {
      // A chat's delete stays on its branch until the chat is staged.
      const deleted = await execute(registry, adapter, chatCtx, "pages.delete", {
        pageId: second.en,
      });
      if (!deleted.ok) throw new Error(JSON.stringify(deleted.error));
      expect(await statuses(chatCtx)).toEqual({
        statuses: { [first.en]: "published", [second.de]: "published" },
      });
      expect(await statuses(SYS_CTX)).toEqual({
        statuses: { [first.en]: "published", [second.en]: "published", [second.de]: "published" },
      });
      expect((await preview(second.de, [], session.chatBranchId)).switcher).toEqual([]);
      expect((await preview(first.de, [], session.chatBranchId)).switcher).toEqual(["en", "de"]);
      expect((await preview(second.de, [])).switcher).toEqual(["en", "de"]);
    } finally {
      await sqlSystem(
        (tx) => tx`DELETE FROM chat_sessions WHERE id = ${session.chatSessionId}::uuid`,
      );
    }
  });

  it("keeps the link-resolve answers until a declared column changes (#1269)", async () => {
    const [pair] = await seedGroups("k", 1);
    if (!pair) throw new Error("seed");
    const pass = async (ids: string[]) => {
      const calls: string[] = [];
      const partition = await previewCalls.run(calls, () =>
        resolveLinkVariants(
          ids,
          { chatBranchId: null, renderId: crypto.randomUUID() },
          { keep: true },
        ),
      );
      return { calls, partition };
    };
    const asked = [pair.en, pair.de];
    clearLinkResolveCache();
    // A page asked about twice is one page, kept or not.
    for (const keep of [false, true]) {
      const twice = await resolveLinkVariants(
        [pair.de, pair.de],
        { chatBranchId: null, renderId: crypto.randomUUID() },
        { keep },
      );
      expect(twice.get(pair.de)?.variant).toBe("de");
    }
    clearLinkResolveCache();
    const cold = await pass(asked);
    expect(cold.calls.filter((c) => c.startsWith("plugin:")).length).toBeGreaterThan(0);
    expect(cold.partition.get(pair.de)?.variant).toBe("de");

    // Nothing changed: one journal check, the plugin is not asked.
    const warm = await pass(asked);
    expect(warm.calls).toEqual(["system:plugin_changes.check_mark"]);
    expect([...warm.partition]).toEqual([...cold.partition]);

    // A translation's status is no column the answer reads.
    await sqlSystem(async (tx) => {
      await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${pluginId}', true)`);
      await tx.unsafe(
        `UPDATE plugin_international_site.page_variants SET translation_status = 'needs_update' WHERE page_id = '${pair.de}'`,
      );
    });
    expect((await pass(asked)).calls).toEqual(["system:plugin_changes.check_mark"]);

    // A page not asked about before: the plugin is asked about it alone.
    const more = await pass([...asked, small[1]?.de ?? ""]);
    expect(more.calls.filter((c) => c.startsWith("plugin:")).length).toBeGreaterThan(0);
    expect(more.partition.get(small[1]?.de ?? "")?.variant).toBe("de");

    // The page leaves its group on main, through the storage API (a delete
    // there is an update of the host's caelo_deleted_at): asked again, and
    // the answer follows.
    const owner = await seedOwner();
    const unlinked = await runPluginOperation({
      invocation: { origin: "owner-panel", actorId: owner },
      pluginSlug: "international-site",
      operationName: "unlink_page_variants",
      args: { pageId: pair.de },
    });
    if (!unlinked.ok) throw new Error(`${unlinked.error.kind}: ${unlinked.error.message}`);
    const after = await pass(asked);
    expect(after.calls.filter((c) => c.startsWith("plugin:")).length).toBeGreaterThan(0);
    expect(after.partition.get(pair.de)?.group ?? null).toBeNull();
  });

  it("a chat's pending variant change re-asks in that chat only; main keeps its answers (#1269)", async () => {
    const [pair] = await seedGroups("kb", 1);
    if (!pair) throw new Error("seed");
    const session = await sysOp<{ chatSessionId: string; chatBranchId: string }>(
      "chat.create_session",
      { isolation: "experiment", title: `${PFX}kb-chat` },
    );
    const pass = async (chatBranchId: string | null) => {
      const calls: string[] = [];
      const partition = await previewCalls.run(calls, () =>
        resolveLinkVariants(
          [pair.en, pair.de],
          { chatBranchId, renderId: crypto.randomUUID() },
          { keep: true },
        ),
      );
      return { asked: calls.some((c) => c.startsWith("plugin:")), partition };
    };
    clearLinkResolveCache();
    await pass(null);
    await pass(session.chatBranchId);
    expect((await pass(null)).asked).toBe(false);
    expect((await pass(session.chatBranchId)).asked).toBe(false);

    // The chat (acting for an Owner: unlinking needs content.write)
    // unlinks the German page: a pending row on its branch.
    const owner = await seedOwner();
    const unlinked = await runPluginOperation({
      invocation: {
        origin: "chat",
        actorId: owner,
        operatorActorId: owner,
        chatBranchId: session.chatBranchId,
        chatTaskId: session.chatSessionId,
      },
      pluginSlug: "international-site",
      operationName: "unlink_page_variants",
      args: { pageId: pair.de },
    });
    if (!unlinked.ok) throw new Error(`${unlinked.error.kind}: ${unlinked.error.message}`);

    const inChat = await pass(session.chatBranchId);
    expect(inChat.asked).toBe(true);
    expect(inChat.partition.get(pair.de)?.group ?? null).toBeNull();
    const onMain = await pass(null);
    expect(onMain.asked).toBe(false);
    expect(onMain.partition.get(pair.de)?.variant).toBe("de");
  });

  it("a written variant row re-asks only the pages it names, on main and in a chat (#1269)", async () => {
    const pairs = await seedGroups("kd", 3);
    const [a, b, c] = pairs;
    if (!a || !b || !c) throw new Error("seed");
    // Three pages in no group yet: each joins a's group below.
    const [x, y, z] = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(
          `INSERT INTO pages (slug, title, short_title, template_id, page_type_id, page_type_confirmed, current_path, status)
           SELECT '${PFX}kd-x' || i, 'X', 'X', '${templateId}', '${pageTypeId}', true, '/${PFX}kd-x' || i, 'published'
             FROM generate_series(1, 3) i ORDER BY i
           RETURNING id::text AS id`,
        )) as { id: string }[],
    );
    if (!x || !y || !z) throw new Error("seed");
    const asked = [...pairs.flatMap((p) => [p.en, p.de]), x.id, y.id, z.id];
    const session = await sysOp<{ chatSessionId: string; chatBranchId: string }>(
      "chat.create_session",
      { isolation: "experiment", title: `${PFX}kd-chat` },
    );
    const pass = async (chatBranchId: string | null) => {
      const reads: string[] = [];
      const partition = await storeReads.run(reads, () =>
        resolveLinkVariants(asked, { chatBranchId, renderId: crypto.randomUUID() }, { keep: true }),
      );
      // The pages the plugin was asked about: those its variant read names.
      const askedNow = asked.filter((id) => reads.some((r) => r.includes(id)));
      return { askedNow, partition };
    };
    const cold = async (chatBranchId: string | null) =>
      resolveLinkVariants(asked, { chatBranchId, renderId: crypto.randomUUID() });
    clearLinkResolveCache();
    expect((await pass(null)).askedNow).toEqual(asked);
    expect((await pass(session.chatBranchId)).askedNow).toEqual(asked);

    // On main: x joins a's group. Only x is asked again, and the kept
    // answers are the answers a cold ask gives.
    const owner = await seedOwner();
    const linked = await runPluginOperation({
      invocation: { origin: "owner-panel", actorId: owner },
      pluginSlug: "international-site",
      operationName: "link_page_variants",
      args: { groupPageId: a.en, pageId: x.id, localeCode: "de" },
    });
    if (!linked.ok) throw new Error(`${linked.error.kind}: ${linked.error.message}`);
    const main = await pass(null);
    expect(main.askedNow).toEqual([x.id]);
    expect(main.partition.get(x.id)?.group).toBe(main.partition.get(a.en)?.group ?? "");
    expect([...main.partition].sort()).toEqual([...(await cold(null))].sort());

    // A row written outside the ops (a migration, an import) has no
    // snapshot: its live row names the page.
    await sqlSystem(async (tx) => {
      await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${pluginId}', true)`);
      await tx.unsafe(
        `INSERT INTO plugin_international_site.page_variants (group_id, page_id, locale_code, translation_status)
         SELECT group_id, '${z.id}', 'de', 'up_to_date' FROM plugin_international_site.page_variants
          WHERE page_id = '${b.en}'`,
      );
    });
    const raw = await pass(null);
    expect(raw.askedNow).toEqual([z.id]);
    expect(raw.partition.get(z.id)?.group).toBe(raw.partition.get(b.en)?.group ?? "");

    // In the chat: y joins a's group as a pending row on its branch. The
    // chat asks again about y (and x and z, written on main since), main about nothing.
    const inChat = await runPluginOperation({
      invocation: {
        origin: "chat",
        actorId: owner,
        operatorActorId: owner,
        chatBranchId: session.chatBranchId,
        chatTaskId: session.chatSessionId,
      },
      pluginSlug: "international-site",
      operationName: "link_page_variants",
      args: { groupPageId: a.en, pageId: y.id, localeCode: "de" },
    });
    if (!inChat.ok) throw new Error(`${inChat.error.kind}: ${inChat.error.message}`);
    const chat = await pass(session.chatBranchId);
    expect(chat.askedNow.sort()).toEqual([x.id, y.id, z.id].sort());
    expect(chat.partition.get(y.id)?.group).toBe(chat.partition.get(a.en)?.group ?? "");
    expect([...chat.partition].sort()).toEqual([...(await cold(session.chatBranchId))].sort());
    expect((await pass(null)).askedNow).toEqual([]);

    // The locale registry decides every page's answer: a new language asks
    // about every page again (and is gone before the next test).
    const registry = async (statement: string) =>
      sqlSystem(async (tx) => {
        await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${pluginId}', true)`);
        await tx.unsafe(statement);
      });
    await registry(
      `INSERT INTO plugin_international_site.locales (code, display_name, url_strategy, is_default)
       VALUES ('fr', 'Francais', 'subdirectory', false)`,
    );
    try {
      expect((await pass(null)).askedNow).toEqual(asked);
    } finally {
      await registry(`DELETE FROM plugin_international_site.locales WHERE code = 'fr'`);
    }
  });

  it("a kept refill is read after its mark, not from an earlier hook of the pass (#1269)", async () => {
    const [pair] = await seedGroups("km", 1);
    if (!pair) throw new Error("seed");
    clearLinkResolveCache();
    const scope: RenderScope = { chatBranchId: null, renderId: crypto.randomUUID() };
    // An earlier hook of the same pass memoizes the variant rows.
    const annotated = await runPluginOperation({
      invocation: renderInvocation(scope),
      pluginSlug: "international-site",
      operationName: "url_annotations",
      args: { pageIds: [pair.de] },
    });
    if (!annotated.ok) throw new Error(annotated.error.message);
    // The variant leaves its group before the partition is asked for.
    const owner = await seedOwner();
    const unlinked = await runPluginOperation({
      invocation: { origin: "owner-panel", actorId: owner },
      pluginSlug: "international-site",
      operationName: "unlink_page_variants",
      args: { pageId: pair.de },
    });
    if (!unlinked.ok) throw new Error(`${unlinked.error.kind}: ${unlinked.error.message}`);
    const partition = await resolveLinkVariants([pair.de], scope, { keep: true });
    // Kept with a mark that has seen the unlink: it must not be the
    // memoized grouped row.
    expect(partition.get(pair.de)?.group ?? null).toBeNull();
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * #391, #1729 — head/sitemap contribution collection against the real host:
 * additive merge across two plugins, identical-duplicate dedup, LOUD
 * contradiction, the URLs core builds for the pages alternates name (on the
 * render's branch), the vocabulary's refusals as render-failure markers
 * (docs/dev/external-plugin-brokers.md §6.2), the chunks a build asks in,
 * capability enforcement at the validator, the serializer's deterministic
 * ordering, and the per-page document language (`lang`) channel.
 *
 * The plugins here are shipped-style (in-process): the vocabulary binds
 * every plugin (decision Q2 A). The sandboxed path is
 * admin-core `external-head-contributions.integration.test.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import {
  bootstrap,
  collectContributions,
  MAIN_RENDER,
  type PluginHostInfra,
  renderHeadEntries,
  resetPluginHost,
} from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t391",
};
const BASE = "https://example.com";
const URLS = { siteBaseUrl: BASE, pageUrlStyle: "directory" as const };
/** No page has this id. */
const NOWHERE = "00000000-0000-4000-8000-00000000dead";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let infra: PluginHostInfra;
/** Pages on main, and one created on an isolated chat branch. */
let A = "";
let DE = "";
let FR = "";
let BRANCHED = "";
let branchId = "";

type Answer = (pageIds: string[]) => unknown;

function contributor(slug: string, answer: Answer, calls?: string[][]) {
  return definePlugin({
    slug,
    version: "0.1.0",
    tier: 1,
    schema: {},
    requestedCapabilities: ["head_contributions"],
    contributes: ["head", "sitemap"],
    contributionsOperation: "contribute",
    operations: {
      contribute: async (_ctx, args) => {
        const { pageIds } = args as { pageIds: string[] };
        calls?.push(pageIds);
        return answer(pageIds);
      },
    },
  });
}

const link = (hreflang: string, pageId: string) => ({
  kind: "link" as const,
  rel: "alternate" as const,
  hreflang,
  pageId,
});

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

async function cleanupPlugins(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't391-%')
    )`);
    await tx.unsafe(
      "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't391-%')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't391-%'");
  });
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function boot(...definitions: ReturnType<typeof contributor>[]): Promise<void> {
  const report = await bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: definitions.map((definition) => ({ definition })),
  });
  expect(report.failed).toEqual([]);
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry };
  await cleanupPlugins();
  await sqlSystem((tx) => tx.unsafe("DELETE FROM pages WHERE slug LIKE 't391-%'"));
  const { templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
    pageType: "home",
    slug: "t391-tpl",
    displayName: "T391",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  const create = async (ctx: ExecutionContext, slug: string) =>
    (await op<{ pageId: string }>(ctx, "pages.create", { slug, title: slug, templateId })).pageId;
  A = await create(SYS, "t391-pricing");
  DE = await create(SYS, "t391-preise");
  FR = await create(SYS, "t391-prix");
  ({ chatBranchId: branchId } = await op<{ chatBranchId: string }>(SYS, "chat.create_session", {
    isolation: "experiment",
    title: "t391 branch",
  }));
  BRANCHED = await create({ ...SYS, chatBranchId: branchId }, "t391-entwurf");
}, 60_000);

afterEach(async () => {
  await cleanupPlugins();
});

afterAll(async () => {
  await sqlSystem(async (tx) => {
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't391-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't391-%'");
  });
  await adapter.close();
});

describe("#391 — head/sitemap contribution collection", () => {
  it("merges two plugins additively; identical duplicates dedup; core builds the URLs; order-stable", async () => {
    await boot(
      contributor("t391-intl", () => ({ head: { [A]: [link("de", DE), link("x-default", A)] } })),
      contributor("t391-og", () => ({
        // One identical duplicate (dedup) + disjoint metas.
        head: {
          [A]: [
            link("de", DE),
            { kind: "meta", property: "og:locale", content: "en_GB" },
            { kind: "meta", property: "og:locale:alternate", content: "fr_FR" },
            { kind: "meta", property: "og:locale:alternate", content: "de_DE" },
          ],
        },
      })),
    );
    const collected = await collectContributions([A], { ...MAIN_RENDER, ...URLS });
    expect(collected.refused.size).toBe(0);
    const entries = collected.head.get(A) ?? [];
    expect(entries).toHaveLength(5);
    // Serializer: deterministic order regardless of plugin iteration.
    expect(renderHeadEntries(entries)).toBe(
      [
        `<link rel="alternate" hreflang="de" href="${BASE}/t391-preise/" />`,
        `<link rel="alternate" hreflang="x-default" href="${BASE}/t391-pricing/" />`,
        '<meta property="og:locale" content="en_GB" />',
        '<meta property="og:locale:alternate" content="de_DE" />',
        '<meta property="og:locale:alternate" content="fr_FR" />',
      ].join("\n"),
    );
  });

  it("contradictory entries under one key fail loudly", async () => {
    await boot(
      contributor("t391-a", () => ({ head: { [A]: [link("de", DE)] } })),
      contributor("t391-b", () => ({ head: { [A]: [link("de", FR)] } })),
    );
    await expect(collectContributions([A], { ...MAIN_RENDER, ...URLS })).rejects.toThrow(
      /contradictory head entries/,
    );
  });

  it("sitemap contributions merge with built URLs; contradictory alternates fail loudly", async () => {
    await boot(
      contributor("t391-a", () => ({
        sitemap: { [A]: { alternates: [{ hreflang: "de", pageId: DE }] } },
      })),
      contributor("t391-b", () => ({ sitemap: { [A]: { exclude: true } } })),
    );
    const collected = await collectContributions([A], { ...MAIN_RENDER, ...URLS });
    expect(collected.sitemap.get(A)).toEqual({
      exclude: true,
      alternates: [{ hreflang: "de", href: `${BASE}/t391-preise/` }],
    });

    await cleanupPlugins();
    await boot(
      contributor("t391-a", () => ({
        sitemap: { [A]: { alternates: [{ hreflang: "de", pageId: DE }] } },
      })),
      contributor("t391-b", () => ({
        sitemap: { [A]: { alternates: [{ hreflang: "de", pageId: FR }] } },
      })),
    );
    await expect(collectContributions([A], { ...MAIN_RENDER, ...URLS })).rejects.toThrow(
      /contradictory sitemap alternates/,
    );
  });

  it("document language: agreeing plugins merge; contradictions fail loudly; a non-tag is refused", async () => {
    const collect = () => collectContributions([A], { ...MAIN_RENDER, ...URLS });
    await boot(
      contributor("t391-a", () => ({ lang: { [A]: "de-AT" } })),
      contributor("t391-b", () => ({ lang: { [A]: "de-AT" } })),
    );
    expect((await collect()).lang.get(A)).toBe("de-AT");

    await cleanupPlugins();
    await boot(
      contributor("t391-a", () => ({ lang: { [A]: "de" } })),
      contributor("t391-b", () => ({ lang: { [A]: "fr" } })),
    );
    await expect(collect()).rejects.toThrow(/contradictory document languages/);

    await cleanupPlugins();
    // A value that would break out of the attribute is not a language tag.
    await boot(contributor("t391-a", () => ({ lang: { [A]: 'en" onload="x' } })));
    const refused = await collect();
    expect(refused.lang.has(A)).toBe(false);
    expect(refused.refused.get(A)).toEqual([
      "plugin-value-refused:t391-a.head-composition.lang:lang-invalid",
    ]);
  });

  it("refuses every entry outside the vocabulary and renders the rest", async () => {
    await boot(
      contributor("t391-evil", () => ({
        head: {
          [A]: [
            { kind: "link", rel: "stylesheet", href: "https://evil.example/x.css" },
            { kind: "link", rel: "preconnect", href: "https://tracker.example" },
            { kind: "link", rel: "alternate", hreflang: "es", href: "https://evil.example/es" },
            { kind: "meta", name: "robots", content: "noindex" },
            { kind: "meta", property: "og:image", content: "https://evil.example/i.png" },
            { kind: "meta", property: "og:locale", content: "javascript:alert(1)" },
            { kind: "meta", property: "og:locale:alternate", content: "<script>x</script>" },
            link("it", NOWHERE),
            // Another chat's page: not in this render's view.
            link("nl", BRANCHED),
            link("fr", FR),
          ],
        },
        sitemap: {
          [A]: {
            alternates: [
              { hreflang: "es", href: "https://evil.example/es" },
              { hreflang: "it", pageId: NOWHERE },
              { hreflang: "fr", pageId: FR },
            ],
          },
        },
      })),
    );
    const collected = await collectContributions([A], { ...MAIN_RENDER, ...URLS });
    const marker = (field: string, rule: string) =>
      `plugin-value-refused:t391-evil.head-composition.${field}:${rule}`;
    expect(collected.refused.get(A)).toEqual([
      marker("link", "rel-stylesheet"),
      marker("link", "rel-preconnect"),
      marker("link", "href-not-allowed"),
      marker("meta", "name-robots"),
      marker("meta", "property-og-image"),
      marker("meta", "content-format"),
      marker("sitemap", "href-not-allowed"),
      marker("link", "page-unknown"),
      marker("sitemap", "page-unknown"),
    ]);
    const rendered = renderHeadEntries(collected.head.get(A) ?? []);
    expect(rendered).toBe(`<link rel="alternate" hreflang="fr" href="${BASE}/t391-prix/" />`);
    expect(collected.sitemap.get(A)).toEqual({
      alternates: [{ hreflang: "fr", href: `${BASE}/t391-prix/` }],
    });
  });

  it("names pages in the render's view: a chat's own page resolves on its branch only", async () => {
    await boot(contributor("t391-a", () => ({ head: { [A]: [link("nl", BRANCHED)] } })));
    const preview = await collectContributions([A], {
      chatBranchId: branchId,
      renderId: "t391-pass",
      ...URLS,
    });
    expect(preview.refused.size).toBe(0);
    expect(renderHeadEntries(preview.head.get(A) ?? [])).toBe(
      `<link rel="alternate" hreflang="nl" href="${BASE}/t391-entwurf/" />`,
    );
    const build = await collectContributions([A], { ...MAIN_RENDER, ...URLS });
    expect(build.head.has(A)).toBe(false);
    expect(build.refused.get(A)).toEqual([
      "plugin-value-refused:t391-a.head-composition.link:page-unknown",
    ]);
  });

  it("a page with more than 20 entries gets none; an answer over 1 MB is refused for its pages", async () => {
    const many = Array.from({ length: 21 }, (_, i) => link(`x${String.fromCharCode(97 + i)}`, DE));
    await boot(
      contributor("t391-bloat", (pageIds) =>
        pageIds.includes(FR)
          ? { head: { [FR]: [link("de", DE)] }, lang: { [FR]: "x".repeat(1_100_000) } }
          : { head: { [A]: many, [DE]: [link("de", DE)] } },
      ),
    );
    const collected = await collectContributions([A, DE], { ...MAIN_RENDER, ...URLS });
    expect(collected.head.has(A)).toBe(false);
    expect(collected.head.get(DE)).toHaveLength(1);
    expect(collected.refused.get(A)).toEqual([
      "plugin-value-refused:t391-bloat.head-composition.entries:entries-over-limit",
    ]);
    const big = await collectContributions([FR], { ...MAIN_RENDER, ...URLS });
    expect(big.head.size).toBe(0);
    expect(big.refused.get(FR)).toEqual([
      "plugin-value-refused:t391-bloat.head-composition.answer:answer-too-large",
    ]);
  });

  it("a build asks in chunks of at most 200 pages", async () => {
    const calls: string[][] = [];
    await boot(contributor("t391-a", () => ({}), calls));
    const ids = Array.from(
      { length: 450 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    await collectContributions(ids, { ...MAIN_RENDER, ...URLS });
    expect(calls.map((c) => c.length)).toEqual([200, 200, 50]);
  });

  it("an answer for a page that was not asked about fails loudly", async () => {
    await boot(contributor("t391-a", () => ({ head: { [NOWHERE]: [link("de", DE)] } })));
    await expect(collectContributions([A], { ...MAIN_RENDER, ...URLS })).rejects.toThrow(
      /not part of this call/,
    );
  });

  it("ceiling: contributes without the capability is refused at validation", async () => {
    const def = definePlugin({
      slug: "t391-nocap",
      version: "0.1.0",
      tier: 1,
      schema: {},
      requestedCapabilities: [],
      contributes: ["head"],
      contributionsOperation: "contribute",
      operations: { contribute: async () => ({}) },
    });
    const report = await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: def }],
    });
    expect(report.loaded).toHaveLength(0);
    expect(report.failed[0]?.reason).toContain("manifest-cap-missing");
  });
});

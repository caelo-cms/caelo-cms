// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a runtime-installed plugin resolves internal links
 * (docs/dev/external-plugin-brokers.md §6.4), end to end on a real Postgres
 * and the real Deno sandbox: staged, approved by an Owner, activated, then
 * asked by the editor preview through the `$linkResolve` reserved entry.
 *
 * - A link on a German page goes to the German version of its target; the
 *   href is the path core builds, whatever the plugin calls its groups.
 * - The answer is kept per render scope (`linkResolveReads`, required for
 *   every link resolver): a second ask after an unrelated write asks the
 *   plugin nothing, and a write to a declared table asks again only about
 *   the page the row names.
 * - Adversarial: an answer for a page it was not asked about, a variant
 *   token carrying a URL, two plugins placing one page, an answer over the
 *   cap and a resolver past its preview budget all fail loudly.
 * - A build asks about many pages in chunks below the 1 MB wire line.
 *
 * The preview's cost with an external link resolver is printed (PR measurement).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  clearLinkResolveCache,
  createPluginRenderFailureSink,
  MAIN_RENDER,
  resetPluginHost,
  resolveLinkVariants,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { externalPluginFlow, FLOW_SYSTEM } from "./_external-plugin-flow.js";

let adapter: DatabaseAdapter;
let pluginsRoot: string;
const registry = new OperationRegistry();
const SLUG = "link-probe";
const PFX = "t1729lr";
const flow = externalPluginFlow({
  adapter: () => adapter,
  registry,
  prefix: PFX,
  schemas: ["plugin_link_probe"],
});

/** Page ids that make the probe misbehave, one way each. */
const STRAY = "00000000-0000-4000-9000-000000000001";
const SCHEME = "00000000-0000-4000-9000-000000000002";
const HUGE = "00000000-0000-4000-9000-000000000003";
const SLOW = "00000000-0000-4000-9000-000000000004";
const SHARED = "00000000-0000-4000-9000-000000000005";
/** Build-style ids the probe answers for with the call's own tag. */
const BULK = "00000000-0000-4000-8000-";

const manifest = {
  slug: SLUG,
  version: "1.0.0",
  tier: 2,
  schema: {},
  adminSchema: { variants: { page_id: "uuid", variant: "text", group_key: "text" } },
  operations: ["resolve", "set_variant"],
  hasLinkResolve: true,
  linkResolveReads: {
    tables: ["variants"],
    columns: ["page_id", "variant", "group_key"],
    pageColumns: { variants: "page_id" },
  },
  requestedCapabilities: ["link_resolve", "cms_admin_schema"],
  capabilityReasons: {
    link_resolve: "Send each language's links to its own pages",
    cms_admin_schema: "Keep which page is which language",
  },
};
// Each call tags its groups with a value of its own, so a test can tell an
// answer that was kept from one the plugin was asked for again.
const source = `export default {slug:"${SLUG}",version:"1.0.0",tier:2,
  linkResolveOperation: "resolve",
  operations:{
    set_variant: async (ctx, { pageId, variant, group }) => {
      const [row] = await ctx.adminQuery.list("variants", { limit: 1000 }).then((rows) => rows.filter((r) => r.page_id === pageId));
      if (row) await ctx.adminQuery.update("variants", row.id, { variant, group_key: group });
      else await ctx.adminQuery.insert("variants", { page_id: pageId, variant, group_key: group });
      return { ok: true };
    },
    resolve: async (ctx, { pageIds }) => {
      const asked = new Set(pageIds);
      if (asked.has("${STRAY}")) return { pages: { "${SHARED}": { variant: "en", group: null } } };
      if (asked.has("${SCHEME}")) return { pages: { "${SCHEME}": { variant: "javascript:alert(1)", group: null } } };
      if (asked.has("${HUGE}")) return { pages: Object.fromEntries(Array.from({ length: 30000 }, (_, i) => ["${HUGE}".slice(0, 24) + String(i).padStart(12, "0"), { variant: "en", group: "g".repeat(190) }])) };
      if (asked.has("${SLOW}")) { const end = Date.now() + 8000; while (Date.now() < end) {} }
      const tag = Math.random().toString(36).slice(2, 10);
      const pages = {};
      for (const id of pageIds) if (id.startsWith("${BULK}") || id === "${SHARED}") pages[id] = { variant: "en", group: "bulk~" + tag };
      for (const r of await ctx.adminQuery.list("variants", { limit: 1000 }))
        if (asked.has(r.page_id)) pages[r.page_id] = { variant: r.variant, group: r.group_key + "~" + tag };
      return { pages };
    },
  }};`;

/** A shipped resolver that places the one page the probe also claims. */
const rival = definePlugin({
  slug: `${PFX}-rival`,
  version: "0.1.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["link_resolve"],
  linkResolveOperation: "resolve",
  linkResolveReads: { tables: [] },
  operations: {
    resolve: async (_ctx, args) => {
      const { pageIds } = args as { pageIds: string[] };
      return {
        pages: pageIds.includes(SHARED) ? { [SHARED]: { variant: "de", group: null } } : {},
      };
    },
  },
});

let owner: Awaited<ReturnType<typeof flow.owner>>;

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  await flow.dropRows();
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-link-resolve-test-"));
  await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot,
    systemActorId: FLOW_SYSTEM.actorId,
    testPlugins: [{ definition: rival }],
  });
  await flow.install(manifest, source);
  owner = await flow.owner();
});
afterAll(async () => {
  resetPluginHost();
  await flow.dropRows();
  await rm(pluginsRoot, { recursive: true, force: true });
  await adapter.close();
});

/** Place a page in a variant through the probe, as the Owner panel does. */
async function setVariant(pageId: string, variant: string, group: string): Promise<void> {
  const r = await runPluginOperation({
    invocation: { origin: "owner-panel", actorId: owner.actorId },
    pluginSlug: SLUG,
    operationName: "set_variant",
    args: { pageId, variant, group },
  });
  if (!r.ok) throw new Error(`set_variant: ${r.error.message}`);
}

/** The tag of the call that answered for `pageId`. */
const tagOf = (r: Awaited<ReturnType<typeof resolveLinkVariants>>, pageId: string) =>
  r.get(pageId)?.group?.split("~")[1];

describe("#1729 — a runtime-installed plugin resolves links", () => {
  let pages: { aboutEn: string; aboutDe: string; start: string };

  it("a link on a German page goes to the German version, at the path core builds", async () => {
    const { templateId } = await flow.template();
    const aboutEn = await flow.page(templateId, "about-en", "<p>About</p>");
    const aboutDe = await flow.page(templateId, "about-de", "<p>Über uns</p>");
    const start = await flow.page(
      templateId,
      "start-de",
      `<p><a class="to-about" href="caelo:page/${aboutEn}">Über uns</a></p>`,
    );
    pages = { aboutEn, aboutDe, start };
    // A group that looks like an address is only a key: it never reaches an href.
    await setVariant(aboutEn, "en", "//evil.example/about");
    await setVariant(aboutDe, "de", "//evil.example/about");
    await setVariant(start, "de", "javascript:alert(1)");

    const started = performance.now();
    const first = await flow.preview(start);
    const firstMs = performance.now() - started;
    expect(first.pluginFailures).toEqual([]);
    expect(first.html).toMatch(new RegExp(`class="to-about" href="/${PFX}-about-de/?"`));
    expect(first.html).not.toContain("evil.example");
    expect(first.html).not.toContain("javascript:");

    // The second preview serves the kept answers: no sandbox call for links.
    const again = performance.now();
    const second = await flow.preview(start);
    const secondMs = performance.now() - again;
    expect(second.html).toBe(first.html);
    console.log(
      `[measure] preview with an external link resolver: first ${firstMs.toFixed(0)} ms, second (kept answers) ${secondMs.toFixed(0)} ms`,
    );
  }, 120_000);

  it("keeps the answer per scope and asks again only about the page a write names", async () => {
    clearLinkResolveCache();
    const ids = [pages.aboutEn, pages.aboutDe, pages.start];
    const first = await resolveLinkVariants(ids, MAIN_RENDER, { keep: true });
    const tag = tagOf(first, pages.aboutEn);
    expect(tag).toBeDefined();
    expect(ids.map((id) => tagOf(first, id))).toEqual([tag, tag, tag]);

    // An unrelated write: a page of core, not the probe's table.
    await flow.call("pages.update", { pageId: pages.start, title: "Start (edited)" });
    const kept = await resolveLinkVariants(ids, MAIN_RENDER, { keep: true });
    expect(ids.map((id) => tagOf(kept, id))).toEqual([tag, tag, tag]);

    // A write to the declared table names one page: only it is asked again.
    await setVariant(pages.aboutDe, "de", "about-renamed");
    const after = await resolveLinkVariants(ids, MAIN_RENDER, { keep: true });
    expect(after.get(pages.aboutDe)?.group).toStartWith("about-renamed~");
    expect(tagOf(after, pages.aboutDe)).not.toBe(tag);
    expect(tagOf(after, pages.aboutEn)).toBe(tag);
    expect(tagOf(after, pages.start)).toBe(tag);
  }, 120_000);

  it("refuses an answer for a page it was not asked about", async () => {
    await expect(resolveLinkVariants([STRAY], MAIN_RENDER)).rejects.toThrow(
      /answered for page .*, which is not part of this render/,
    );
  }, 60_000);

  it("refuses a variant token that carries a URL", async () => {
    await expect(resolveLinkVariants([SCHEME], MAIN_RENDER)).rejects.toThrow(
      /invalid answer.*variant must be 1-64 letters/,
    );
  }, 60_000);

  it("refuses two plugins placing one page", async () => {
    await expect(resolveLinkVariants([SHARED], MAIN_RENDER)).rejects.toThrow(
      /placed in a variant by both "link-probe" and "t1729lr-rival"/,
    );
  }, 60_000);

  it("refuses an answer over the cap before anything walks it", async () => {
    await expect(resolveLinkVariants([HUGE], MAIN_RENDER)).rejects.toThrow(/SandboxAnswerTooLarge/);
  }, 60_000);

  it("stops a resolver past its preview budget and renders without it", async () => {
    const sink = createPluginRenderFailureSink();
    const started = performance.now();
    const r = await resolveLinkVariants([SLOW, pages.aboutEn], {
      chatBranchId: null,
      renderId: crypto.randomUUID(),
      onPluginFailure: sink.onPluginFailure,
    });
    // Killed at 5 s, not after the 8 s the probe would run (a loaded
    // machine adds its spawn time).
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(r.get(pages.aboutEn)).toBeUndefined();
    expect(sink.failures()).toEqual([
      expect.objectContaining({
        slug: SLUG,
        point: "link-resolve",
        reason: expect.stringContaining("SandboxTimeout"),
      }),
    ]);
  }, 60_000);

  it("asks a build about many pages in chunks below the wire line", async () => {
    const ids = Array.from({ length: 30_000 }, (_, i) => `${BULK}${String(i).padStart(12, "0")}`);
    const started = performance.now();
    const resolved = await resolveLinkVariants(ids, MAIN_RENDER);
    const ms = performance.now() - started;
    expect(resolved.size).toBe(ids.length);
    // One tag per call: 10 000 pages each.
    expect(new Set(ids.map((id) => tagOf(resolved, id))).size).toBe(3);
    console.log(
      `[measure] build-style link resolve of ${ids.length} pages from an external resolver: ${ms.toFixed(0)} ms`,
    );
  }, 180_000);
});

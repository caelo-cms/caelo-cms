// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a runtime-installed plugin translates lists (`list-resolve`,
 * docs/dev/external-plugin-brokers.md §6.5), end to end on a real Postgres
 * and the real Deno sandbox: staged, approved by an Owner, activated, then
 * asked by the editor preview through the `$listResolve` reserved entry
 * (its variants come from the same plugin's `$linkResolve` partition).
 *
 * - Values are checked for their field (§4.5): a text name carrying markup
 *   renders escaped, a richtext description with `<script>` and a
 *   `javascript:` landing page are refused (the spot stays raw, the preview
 *   lists `plugin-value-refused`, which blocks Publish live), and the
 *   checked entry renders translated.
 * - An overlay may only replace values: one naming an entry the list does
 *   not have is refused and reported to the plugin's error channel.
 * - Adversarial: an answer for a variant it was not asked about, an answer
 *   over the 16 MB cap and a plugin past its preview budget.
 * - A scope too big for one wire line is asked in parts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  createPluginRenderFailureSink,
  MAIN_RENDER,
  resetPluginHost,
  resolveListOverlays,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { externalPluginFlow, FLOW_SYSTEM } from "./_external-plugin-flow.js";
import { rawSystemSql } from "./_raw-system-sql.js";

let adapter: DatabaseAdapter;
let pluginsRoot: string;
const registry = new OperationRegistry();
const SLUG = "overlay-probe";
const PFX = "t1729lo";
const flow = externalPluginFlow({
  adapter: () => adapter,
  registry,
  prefix: PFX,
  schemas: [],
});
const FIRST = "00000000-0000-4000-9000-0000000000c1";
const SECOND = "00000000-0000-4000-9000-0000000000c2";
const GHOST = "00000000-0000-4000-9000-0000000000c9";

const manifest = {
  slug: SLUG,
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["variants", "overlays"],
  hasLinkResolve: true,
  linkResolveReads: { tables: [] },
  hasListResolve: true,
  requestedCapabilities: ["link_resolve", "list_resolve"],
  capabilityReasons: {
    link_resolve: "Every page is German",
    list_resolve: "Translate the categories",
  },
};
const source = `export default {slug:"${SLUG}",version:"1.0.0",tier:2,
  linkResolveOperation: "variants",
  listResolveOperation: "overlays",
  operations:{
    variants: async (ctx, { pageIds }) => ({ pages: Object.fromEntries(pageIds.map((id) => [id, { variant: "de", group: null }])) }),
    overlays: async (ctx, { variants, scope }) => {
      if (variants.includes("stray")) return { overlays: { fr: { values: {}, hidden: [] } } };
      if (variants.includes("huge")) return { overlays: { huge: { values: { "page/x/props/y": "x".repeat(17 * 1024 * 1024) }, hidden: [] } } };
      if (variants.includes("slow")) { const end = Date.now() + 8000; while (Date.now() < end) {} }
      if (variants.includes("parts")) {
        const first = scope.pageIds[0] ?? scope.contentInstanceIds[0];
        return { overlays: { parts: { values: { ["page/" + first + "/props/part"]: "x" }, hidden: [] } } };
      }
      // The probe cannot tell its list from the others the page can show
      // (site texts, …): it answers for each, and the render refuses the
      // addresses that name nothing.
      const values = {};
      for (const list of scope?.listIds ?? []) {
      const at = (item, field) => "list/" + list + "/item/" + item + "/" + field;
      Object.assign(values, {
        [at("${FIRST}", "name")]: "<img src=x onerror=alert(1)>",
        [at("${FIRST}", "description")]: "<p>x</p><script>alert(1)</script>",
        [at("${FIRST}", "landing_page")]: { href: "javascript:alert(1)" },
        [at("${SECOND}", "name")]: "Zweite",
        [at("${SECOND}", "description")]: "<p>Gut <em>so</em></p>",
        [at("${SECOND}", "landing_page")]: { href: "https://example.com/de" },
        [at("${GHOST}", "name")]: "Erfunden",
      });
      }
      return { overlays: { de: { hidden: [], values } } };
    },
  }};`;

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  await flow.dropRows();
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-list-resolve-test-"));
  await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot,
    systemActorId: FLOW_SYSTEM.actorId,
  });
  await flow.install(manifest, source);
  // Generous: installing runs the sandbox, and a loaded machine slows it.
}, 180_000);
afterAll(async () => {
  resetPluginHost();
  await flow.dropRows();
  await rawSystemSql((tx) => tx.unsafe(`DELETE FROM lists WHERE slug LIKE '${PFX}-%'`));
  await rm(pluginsRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("#1729 — a runtime-installed plugin translates lists", () => {
  it("renders checked overlay values in the preview and refuses the rest", async () => {
    const { lists } = (await flow.call("lists.upsert_many", {
      lists: [
        {
          slug: `${PFX}-cats`,
          name: "Categories",
          purpose: "Test categories",
          type: "categories",
          items: [
            {
              id: FIRST,
              node: "category",
              values: { name: "First", slug: "first", description: "<p>One</p>" },
            },
            {
              id: SECOND,
              node: "category",
              values: { name: "Second", slug: "second", description: "<p>Two</p>" },
            },
          ],
        },
      ],
    })) as { lists: { id: string }[] };
    const listId = lists[0]?.id as string;
    const { templateId } = await flow.template();
    const pageId = await flow.page(
      templateId,
      "cats",
      '<ul>{{#cats}}<li><b>{{name}}</b><div>{{description}}</div><a href="{{landing_page}}">go</a></li>{{/cats}}</ul>',
      [
        {
          name: "cats",
          kind: "list",
          listType: "categories",
          bind: "shared",
          list: `caelo:list/${listId}`,
          label: "Categories",
        },
      ],
    );
    const started = performance.now();
    const preview = await flow.preview(pageId);
    const ms = performance.now() - started;
    expect(preview.pluginFailures).toEqual([]);
    expect(preview.html).toContain("<b>&lt;img src&#61;x onerror&#61;alert(1)&gt;</b>");
    expect(preview.html).not.toContain("<img src=x");
    expect(preview.html).not.toContain("<script>");
    expect(preview.html).not.toContain("javascript:");
    expect(preview.html).toContain(
      '<b>Zweite</b><div><p>Gut <em>so</em></p></div><a href="https://example.com/de">go</a>',
    );
    const at = (field: string) => `list/${listId}/item/${FIRST}/${field}`;
    expect(preview.missingSlots).toContain(
      `plugin-value-refused:${SLUG}.list-resolve.${at("description")}:element-script`,
    );
    expect(preview.missingSlots).toContain(
      `plugin-value-refused:${SLUG}.list-resolve.${at("landing_page")}:url-scheme`,
    );
    // The invented entry is not rendered: refused and reported to the plugin.
    expect(preview.html).not.toContain("Erfunden");
    const errors = (await adapter.withAdminTransaction(FLOW_SYSTEM, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL caelo.actor_kind = 'system'"));
      return tx.execute(
        sql`SELECT message FROM plugin_errors WHERE plugin_slug = ${SLUG} AND phase = 'render'`,
      );
    })) as unknown as { message: string }[];
    expect(errors.map((e) => e.message).join("\n")).toContain(
      `list/${listId}/item/${GHOST}/name: no such list entry`,
    );
    console.log(
      `[measure] preview with an external link resolver and list overlays: ${ms.toFixed(0)} ms`,
    );
  }, 120_000);

  it("refuses an answer for a variant it was not asked about", async () => {
    await expect(resolveListOverlays(["stray"], MAIN_RENDER)).rejects.toThrow(
      /answered for variant "fr", which this render does not have/,
    );
  }, 60_000);

  it("refuses an answer over the cap before anything walks it", async () => {
    await expect(resolveListOverlays(["huge"], MAIN_RENDER)).rejects.toThrow(
      /SandboxAnswerTooLarge/,
    );
  }, 60_000);

  it("stops a plugin past its preview budget and renders the stored values", async () => {
    const sink = createPluginRenderFailureSink();
    const r = await resolveListOverlays(["slow"], {
      chatBranchId: null,
      renderId: crypto.randomUUID(),
      onPluginFailure: sink.onPluginFailure,
    });
    expect(r.plugins).toEqual([]);
    expect(sink.failures()).toEqual([
      expect.objectContaining({
        slug: SLUG,
        point: "list-resolve",
        reason: expect.stringContaining("SandboxTimeout"),
      }),
    ]);
  }, 60_000);

  it("asks a scope too big for one wire line in parts", async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const r = await resolveListOverlays(["parts"], MAIN_RENDER, {
      listIds: [],
      contentInstanceIds: Array.from({ length: 20_000 }, (_, i) => id(i)),
      pageIds: Array.from({ length: 30_000 }, (_, i) => id(100_000 + i)),
    });
    // One answer per part, each naming the part's first id.
    const parts = Object.keys(r.plugins[0]?.overlays.parts?.values ?? {});
    expect(parts.length).toBeGreaterThanOrEqual(4);
  }, 120_000);
});

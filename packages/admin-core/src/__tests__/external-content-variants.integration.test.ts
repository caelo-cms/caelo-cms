// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a runtime-installed plugin gives pages their own chrome
 * (`content-variants`, docs/dev/external-plugin-brokers.md §6.6), end to
 * end on a real Postgres and the real Deno sandbox: staged, approved by an
 * Owner, activated, then asked by the editor preview through the
 * `$contentVariants` reserved entry.
 *
 * - Values are checked for the module's fields (§4.5): a text carrying
 *   markup renders escaped, a `<script>` richtext, a `javascript:` link and
 *   a key the module does not declare are refused (the spot stays raw, the
 *   preview lists `plugin-value-refused`, which blocks Publish live), and
 *   checked prose renders translated.
 * - A variant naming a module that does not exist on the render's branch
 *   is flagged instead of rendering the stored chrome.
 * - Adversarial: an answer for a page it was not asked about, a module swap
 *   on a page placement, an answer over the cap and a plugin past its
 *   preview budget.
 *
 * The preview's cost with an external content variant is printed (PR measurement).
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
  resolveContentVariants,
} from "@caelo-cms/plugin-host";
import type { ContentVariantPlacement } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { externalPluginFlow, FLOW_SYSTEM } from "./_external-plugin-flow.js";

let adapter: DatabaseAdapter;
let pluginsRoot: string;
const registry = new OperationRegistry();
const SLUG = "variant-probe";
const PFX = "t1729cv";
const flow = externalPluginFlow({
  adapter: () => adapter,
  registry,
  prefix: PFX,
  schemas: [],
});
const STRAY = "00000000-0000-4000-9000-0000000000d1";
const SWAP = "00000000-0000-4000-9000-0000000000d2";
const HUGE = "00000000-0000-4000-9000-0000000000d3";
const SLOW = "00000000-0000-4000-9000-0000000000d4";
const OTHER = "00000000-0000-4000-9000-0000000000d9";

const manifest = {
  slug: SLUG,
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["variants"],
  hasContentVariants: true,
  requestedCapabilities: ["content_variants"],
  capabilityReasons: { content_variants: "Give each page its own chrome" },
};
// A page's own module says what the probe answers for the chrome
// (`mode`), so one installed plugin covers each case.
const source = `export default {slug:"${SLUG}",version:"1.0.0",tier:2,
  contentVariantsOperation: "variants",
  operations:{
    variants: async (ctx, { pages }) => {
      const ids = pages.map((p) => p.pageId);
      if (ids.includes("${STRAY}")) return { resolutions: { "${OTHER}": { "layout:chrome:0": { problems: ["x"] } } } };
      if (ids.includes("${SWAP}")) return { resolutions: { "${SWAP}": { "page:content:0": { moduleId: "${OTHER}" } } } };
      if (ids.includes("${HUGE}")) return { resolutions: { "${HUGE}": { "layout:chrome:0": { values: { title: "x".repeat(5 * 1024 * 1024) } } } } };
      if (ids.includes("${SLOW}")) { const end = Date.now() + 8000; while (Date.now() < end) {} }
      const resolutions = {};
      for (const page of pages) {
        const own = page.placements.find((p) => p.scope === "page");
        const mode = own?.values.mode;
        if (mode === "swap-deleted") resolutions[page.pageId] = { "layout:chrome:0": { moduleId: own.values.target } };
        else if (mode === "translate") resolutions[page.pageId] = { "layout:chrome:0": { values: {
          title: "<img src=x onerror=alert(1)>",
          intro: "<p>Willkommen <strong>hier</strong></p>",
          body: "<p>x</p><script>alert(1)</script>",
          cta: { href: "javascript:alert(1)" },
          ghost: "kein Feld",
        } } };
      }
      return { resolutions };
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
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-content-variants-test-"));
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
  await rm(pluginsRoot, { recursive: true, force: true });
  await adapter.close();
});

/** A layout whose chrome block holds one module, and a page on it with `mode`. */
async function chromePages(): Promise<{ translated: string; swapped: string; deleted: string }> {
  const { layoutId, templateId } = await flow.template("chrome");
  const { moduleId } = (await flow.call("modules.create", {
    slug: `${PFX}-chrome`,
    displayName: `${PFX} chrome`,
    html: '<header><h1>{{title}}</h1><div class="intro">{{intro}}</div><div class="body">{{body}}</div><a class="cta" href="{{cta}}">go</a></header>',
    fields: [
      { name: "title", kind: "text", label: "Title", default: "Welcome" },
      { name: "intro", kind: "richtext", label: "Intro", default: "<p>Welcome here</p>" },
      { name: "body", kind: "richtext", label: "Body", default: "<p>Hello</p>" },
      {
        name: "cta",
        kind: "link",
        label: "Call to action",
        default: { href: "https://example.com" },
      },
    ],
  })) as { moduleId: string };
  await flow.call("layout_modules.set", { layoutId, blockName: "chrome", moduleIds: [moduleId] });
  const { moduleId: gone } = (await flow.call("modules.create", {
    slug: `${PFX}-gone`,
    displayName: `${PFX} gone`,
    html: "<p>gone</p>",
  })) as { moduleId: string };
  await flow.call("modules.delete_many", { moduleIds: [gone] });
  const fields = [
    { name: "mode", kind: "text", label: "Mode" },
    { name: "target", kind: "text", label: "Target" },
  ];
  const page = (slug: string, values: Record<string, unknown>) =>
    flow.page(templateId, slug, "<p>{{mode}}</p>", fields, values);
  return {
    translated: await page("translated", { mode: "translate" }),
    swapped: await page("swapped", { mode: "swap-deleted", target: gone }),
    deleted: gone,
  };
}

describe("#1729 — a runtime-installed plugin gives pages their own chrome", () => {
  let pages: Awaited<ReturnType<typeof chromePages>>;

  it("renders checked variant values in the preview and refuses the rest", async () => {
    pages = await chromePages();
    const started = performance.now();
    const preview = await flow.preview(pages.translated);
    const firstMs = performance.now() - started;
    expect(preview.pluginFailures).toEqual([]);
    expect(preview.html).toContain("<h1>&lt;img src&#61;x onerror&#61;alert(1)&gt;</h1>");
    expect(preview.html).toContain(
      '<div class="intro"><p>Willkommen <strong>hier</strong></p></div>',
    );
    expect(preview.html).not.toContain("<img src=x");
    expect(preview.html).not.toContain("<script>");
    expect(preview.html).not.toContain("javascript:");
    // Refused: raw, never the stored (source-language) chrome.
    expect(preview.html).toContain('<div class="body">{{body}}</div>');
    expect(preview.html).not.toContain("<p>Hello</p>");
    const marker = (field: string, rule: string) =>
      `plugin-value-refused:${SLUG}.content-variants.layout:chrome:0/${field}:${rule}`;
    expect(preview.missingSlots).toEqual(
      expect.arrayContaining([
        marker("body", "element-script"),
        marker("cta", "url-scheme"),
        marker("ghost", "undeclared-field"),
      ]),
    );

    const again = performance.now();
    await flow.preview(pages.translated);
    const secondMs = performance.now() - again;
    console.log(
      `[measure] preview with an external content variant: first ${firstMs.toFixed(0)} ms, second ${secondMs.toFixed(0)} ms`,
    );
  }, 120_000);

  it("flags a variant naming a module the render's branch does not have", async () => {
    const preview = await flow.preview(pages.swapped);
    expect(preview.missingSlots.join("\n")).toContain(
      `renders module ${pages.deleted}, which does not exist`,
    );
  }, 60_000);

  const placement = (key: string, scope: "layout" | "page"): ContentVariantPlacement => ({
    key,
    scope,
    layoutId: null,
    blockName: key.split(":")[1] as string,
    position: 0,
    moduleId: OTHER,
    moduleName: "Probe",
    contentInstanceId: null,
    shared: true,
    fields: [{ name: "title", kind: "text" }],
    values: {},
  });
  const ask = (pageId: string) => [
    {
      pageId,
      placements: [placement("layout:chrome:0", "layout"), placement("page:content:0", "page")],
    },
  ];

  it("refuses an answer for a page it was not asked about", async () => {
    await expect(resolveContentVariants(ask(STRAY), MAIN_RENDER)).rejects.toThrow(
      /answered for page .*, which is not part of this render pass/,
    );
  }, 60_000);

  it("refuses a module swap on a page placement", async () => {
    await expect(resolveContentVariants(ask(SWAP), MAIN_RENDER)).rejects.toThrow(
      /swapped the module of page placement/,
    );
  }, 60_000);

  it("refuses an answer over the cap before anything walks it", async () => {
    await expect(resolveContentVariants(ask(HUGE), MAIN_RENDER)).rejects.toThrow(
      /SandboxAnswerTooLarge/,
    );
  }, 60_000);

  it("stops a plugin past its preview budget and renders the stored chrome", async () => {
    const sink = createPluginRenderFailureSink();
    const r = await resolveContentVariants(ask(SLOW), {
      chatBranchId: null,
      renderId: crypto.randomUUID(),
      onPluginFailure: sink.onPluginFailure,
    });
    expect(r.size).toBe(0);
    expect(sink.failures()).toEqual([
      expect.objectContaining({
        slug: SLUG,
        point: "content-variants",
        reason: expect.stringContaining("SandboxTimeout"),
      }),
    ]);
  }, 60_000);
});

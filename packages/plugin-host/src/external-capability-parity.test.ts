// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — one plugin model, checked: every capability in `pluginCapability`
 * is either brokered for runtime-installed (external) plugins or planned
 * with an issue (`EXTERNAL_CAPABILITY_STATUS`), and every brokered one is
 * real — its surface reaches the host through the real Deno sandbox, and
 * its manifest fields reach the definition the host builds from the
 * manifest. A new capability without a status fails the type check and
 * this test; marking one brokered without a smoke or without its fields
 * fails here too. See docs/dev/external-plugin-brokers.md §4.2.
 *
 * Adding a broker: flip its status to `brokered` in
 * `plugin-sdk/src/external-capabilities.ts`, carry its manifest fields in
 * `externalDeclarations` (external-plugin.ts), and add its smoke to
 * {@link SMOKES} below — one SDK call through the sandbox that reaches a
 * fake host handle, or the declaration and the operation it names.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateInstallationPolicy, validateManifest } from "@caelo-cms/plugin-sandbox";
import {
  CAPABILITY_MANIFEST_FIELDS,
  EXTERNAL_CAPABILITY_STATUS,
  EXTERNAL_UNAVAILABLE_DECLARATIONS,
  externalCapabilityRefusal,
  isExternallyBrokered,
  manifestFromDefinition,
  type PluginCapability,
  type PluginContext,
  type PluginDefinition,
  type PluginManifest,
  pluginCapability,
} from "@caelo-cms/plugin-sdk";
import { externalDeclarations } from "./external-plugin.js";
import { renderPointDefinition } from "./render-points.js";
import { runSandbox } from "./sandbox-runtime.js";
import { declaredUrlAnnotationKey, declaredUrlContributions } from "./url-tables.js";

const PLUGINS_ROOT = resolve(import.meta.dir, "../../plugins");
const ID = "11111111-1111-4111-8111-111111111111";

const probe: PluginManifest = {
  slug: "parity-probe",
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["run"],
  hasStaticRender: false,
  hasBuildData: false,
  hasDeferrals: false,
  hasContentVariants: false,
  hasLinkResolve: false,
  hasShareImages: false,
  hasListResolve: false,
};

const baseContext: PluginContext = {
  query: {
    insert: async () => ({ id: ID }),
    list: async () => [],
    update: async () => {},
    updateMany: async () => {},
    delete: async () => {},
    compareAndSwap: async () => true,
  },
  api: { list: async () => [], get: async () => null },
  theme: { tokens: {} },
  visitor: { id: null, publicUserId: null, ipHash: "", sessionToken: null },
  captcha: { requireProof: async () => true },
  invocation: { origin: "owner-panel", actorId: ID },
};

/** Run `body` as the probe's `run` operation in the real sandbox, on `extra` host handles. */
function sandboxed(
  body: string,
  extra: Record<string, unknown>,
  invocation = baseContext.invocation,
) {
  return runSandbox({
    source: `export default {slug:"parity-probe",version:"1.0.0",tier:2,operations:{run:async(ctx,args)=>{${body}}}};`,
    manifest: probe,
    operation: "run",
    args: {},
    context: { ...baseContext, ...extra, invocation } as PluginContext,
    authorize: async () => {},
  });
}

/** A host handle that answers every method with `answer` and records the calls. */
function fakeHandle(methods: readonly string[], answer: unknown) {
  const calls: string[] = [];
  const handle = Object.fromEntries(
    methods.map((m) => [
      m,
      async () => {
        calls.push(m);
        return answer;
      },
    ]),
  );
  return { handle, calls };
}

async function shipped(slug: string): Promise<PluginManifest> {
  const mod = (await import(resolve(PLUGINS_ROOT, slug, "src/index.ts"))) as {
    default: PluginDefinition;
  };
  return manifestFromDefinition(mod.default);
}

/**
 * One manifest that sets every field a brokered capability names, taken
 * from the shipped plugins that use them (their shapes are the reviewed
 * ones). Only `externalDeclarations` reads it, which validates nothing.
 */
async function fixtureManifest(): Promise<PluginManifest> {
  const search = await shipped("site-search");
  const assistant = await shipped("site-assistant");
  const newsletter = await shipped("newsletter");
  const consent = await shipped("consent-manager");
  const international = await shipped("international-site");
  return {
    ...search,
    ...assistant,
    mailTemplates: newsletter.mailTemplates,
    mailUnsubscribe: newsletter.mailUnsubscribe,
    collections: search.collections,
    collectionOperations: search.collectionOperations,
    pageOutputObserver: search.pageOutputObserver,
    batchOperations: search.batchOperations,
    tools: search.tools,
    skills: search.skills,
    adminSchema: search.adminSchema,
    workers: search.workers,
    listTypes: search.listTypes,
    listSources: consent.listSources,
    hasLinkResolve: international.hasLinkResolve,
    hasListResolve: international.hasListResolve,
    hasContentVariants: international.hasContentVariants,
    // #1729 — client assets: the shipped files, data and placeholders.
    clientFiles: consent.clientFiles,
    hasBuildData: consent.hasBuildData,
    hasDeferrals: consent.hasDeferrals,
    deferralPlaceholders: consent.deferralPlaceholders,
    linkResolveReads: international.linkResolveReads,
    aiChatOperations: assistant.aiChatOperations,
    changeConsumer: consent.changeConsumer,
    contributes: international.contributes,
    hasShareImages: international.hasShareImages,
    urlTables: URL_TABLES,
    urlContributions: [{ slot: "host" }, { slot: "path-prefix" }],
    tier: 2,
  };
}

/**
 * Manifest fields whose definition key differs: a `has…` flag says a
 * reserved sandbox entry (`$contentVariants`, …) answers the point (Q3).
 * A brokered capability's `has…` field without an entry here fails.
 */
const DEFINITION_KEY: Partial<Record<keyof PluginManifest, string>> = {
  hasLinkResolve: "linkResolveOperation",
  hasShareImages: "shareImagesOperation",
  hasDeferrals: "deferralsOperation",
  hasBuildData: "buildDataOperation",
  hasListResolve: "listResolveOperation",
  hasContentVariants: "contentVariantsOperation",
  // #1729 (Q7 A) — the slot claims of an installed plugin are its tables:
  // the host builds the encoders from them (url-tables.ts).
  urlContributions: "urlTables",
};

/** Declared URL tables in the shape a runtime-installed plugin submits them. */
const URL_TABLES = {
  pages: { table: "page_markets", valueColumn: "market" },
  values: { table: "markets", valueColumn: "code", segmentColumn: "segment", hostColumn: "host" },
};

/** A render-point call as core makes it in an editor preview. */
function renderPoint(source: string, manifest: PluginManifest, entry: string, args: unknown) {
  return runSandbox({
    source,
    manifest,
    operation: entry,
    args,
    context: {
      ...baseContext,
      invocation: { origin: "render", actorId: ID, renderId: "pass" },
    } as PluginContext,
    authorize: async () => {},
    kind: "preview",
  });
}

const SMOKES: Partial<Record<PluginCapability, () => Promise<void>>> = {
  // #1729 — the broker takes the operation name and input; every rule is
  // the host handle's (capabilities.ts, tested in plugin-cms.test.ts).
  cms_admin: async () => {
    const calls: unknown[][] = [];
    const cms = {
      call: async (...args: unknown[]) => {
        calls.push(args);
        return { pages: [] };
      },
    };
    expect(await sandboxed(`return ctx.cms.call("pages.list", { limit: 1 })`, { cms })).toEqual({
      pages: [],
    });
    expect(calls).toEqual([["pages.list", { limit: 1 }]]);
  },
  // #1729 — batches and rebuild chunks are host-initiated runs of the
  // declared operations; the plugin asks about its consumer through ctx.changes.
  change_journal: async () => {
    const changeConsumer = {
      operationName: "run",
      rebuildOperationName: "run",
      kinds: [],
      ownTables: ["notes"],
      lines: "all" as const,
    };
    expect(externalDeclarations({ ...probe, changeConsumer }).changeConsumer).toEqual(
      changeConsumer,
    );
    const fake = fakeHandle(["cursorState"], { continuous: true });
    expect(await sandboxed(`return ctx.changes.cursorState()`, { changes: fake.handle })).toEqual({
      continuous: true,
    });
    expect(fake.calls).toEqual(["cursorState"]);
  },
  cms_admin_schema: async () => {
    const fake = fakeHandle(["list"], [{ id: ID }]);
    expect(
      await sandboxed(`return ctx.adminQuery.list("notes", {})`, { adminQuery: fake.handle }),
    ).toEqual([{ id: ID }]);
    expect(fake.calls).toEqual(["list"]);
  },
  font_assets: async () => {
    const fake = fakeHandle(["find"], { fonts: [], hasMore: false });
    expect(await sandboxed(`return ctx.fonts.find({})`, { fonts: fake.handle })).toEqual({
      fonts: [],
      hasMore: false,
    });
    expect(fake.calls).toEqual(["find"]);
  },
  private_files: async () => {
    const fake = fakeHandle(["stat"], { id: ID, status: "ready" });
    expect(
      await sandboxed(`return ctx.privateFiles.stat({ id: "${ID}" })`, {
        privateFiles: fake.handle,
      }),
    ).toEqual({ id: ID, status: "ready" });
    expect(fake.calls).toEqual(["stat"]);
  },
  image_generation: async () => {
    const fake = fakeHandle(["describe"], { model: "m" });
    expect(await sandboxed(`return ctx.images.describe()`, { images: fake.handle })).toEqual({
      model: "m",
    });
    expect(fake.calls).toEqual(["describe"]);
  },
  site_media_read: async () => {
    const fake = fakeHandle(["find"], []);
    expect(await sandboxed(`return ctx.siteMedia.find({})`, { siteMedia: fake.handle })).toEqual(
      [],
    );
    expect(fake.calls).toEqual(["find"]);
  },
  consent_provider: async () => {
    const fake = fakeHandle(["list"], [{ key: "visitor_id" }]);
    expect(
      await sandboxed(`return ctx.consentPurposes.list()`, { consentPurposes: fake.handle }),
    ).toEqual([{ key: "visitor_id" }]);
    expect(fake.calls).toEqual(["list"]);
  },
  collections: async () => {
    const fake = fakeHandle(["get"], { id: "doc" });
    expect(
      await sandboxed(`return ctx.collections.pages.get("doc")`, {
        collections: { pages: fake.handle },
      }),
    ).toEqual({ id: "doc" });
    expect(fake.calls).toEqual(["get"]);
  },
  visitor_ai: async () => {
    const fake = fakeHandle(["run"], { output: "ok" });
    expect(
      await sandboxed(
        `return ctx.chatTools.run("ask", { plugin: "parity-probe", operation: "search" }, {}, { lang: "en" })`,
        { chatTools: fake.handle },
      ),
    ).toEqual({ output: "ok" });
    expect(fake.calls).toEqual(["run"]);
  },
  // Declarations: the definition carries them (checked below for every
  // brokered capability) and the operation they name runs sandboxed.
  chat_runner_tools: async () => {
    expect(await sandboxed(`return "tool ran"`, {})).toBe("tool ran");
  },
  companion_skills: async () => {
    const skills = (await fixtureManifest()).skills;
    expect(externalDeclarations({ ...probe, skills }).skills).toEqual(skills);
  },
  page_output: async () => {
    expect(
      await sandboxed(
        `return ctx.invocation.origin`,
        {},
        { origin: "observer", actorId: ID, stageRunId: ID },
      ),
    ).toBe("observer");
  },
  background_workers: async () => {
    const workers = (await fixtureManifest()).workers;
    expect(externalDeclarations({ ...probe, workers }).workers).toEqual(workers);
    // A worker run is a sandboxed call of the background pool.
    expect(
      await sandboxed(`return ctx.invocation.origin`, {}, { origin: "worker", actorId: ID }),
    ).toBe("worker");
  },
  list_types: async () => {
    const listTypes = (await fixtureManifest()).listTypes;
    expect(listTypes?.length).toBeGreaterThan(0);
    expect(externalDeclarations({ ...probe, listTypes }).listTypes).toEqual(listTypes);
  },
  // #1729 — the install's AI through the host handle (which reserves under
  // the plugin's caps), and its mail templates (queue and link, no send).
  ai_provider: async () => {
    const fake = fakeHandle(["complete", "generateObject"], { text: "hi" });
    expect(
      await sandboxed(
        `return ctx.ai.complete({ system: "s", messages: [{ role: "user", content: "x" }] })`,
        { ai: fake.handle },
      ),
    ).toEqual({ text: "hi" });
    expect(fake.calls).toEqual(["complete"]);
  },
  email: async () => {
    const fake = fakeHandle(["queue", "unsubscribeLink"], null);
    expect(
      await sandboxed(
        `await ctx.email.queue({ template: "confirm_subscription", to: "a@example.com" });
         return typeof ctx.email.send;`,
        { email: { ...fake.handle, send: async () => ({ messageId: "never" }) } },
        { origin: "worker", actorId: ID },
      ),
    ).toBe("undefined");
    expect(fake.calls).toEqual(["queue"]);
    const { mailTemplates, mailUnsubscribe } = await fixtureManifest();
    expect(externalDeclarations({ ...probe, mailTemplates, mailUnsubscribe })).toMatchObject({
      mailTemplates,
      mailUnsubscribe,
    });
  },
  list_sources: async () => {
    const listSources = (await fixtureManifest()).listSources;
    expect(listSources?.length).toBeGreaterThan(0);
    const manifest = { ...probe, listSources } as PluginManifest;
    expect(externalDeclarations(manifest).listSources).toEqual(listSources);
    // The reserved entry answers through the operation the definition names,
    // as a render (preview budget) call.
    const name = (listSources ?? [])[0]?.name as string;
    expect(
      await runSandbox({
        source: `export default {slug:"parity-probe",version:"1.0.0",tier:2,listSourcesOperation:"entries",
          operations:{entries:async(ctx,args)=>({sources:{[args.pageIds[0]]:{${name}:[{id:"a",values:{label:ctx.invocation.origin}}]}}})}};`,
        manifest,
        operation: "$listSources",
        args: { pageIds: [ID] },
        context: {
          ...baseContext,
          invocation: { origin: "render", actorId: ID, renderId: "pass" },
        } as PluginContext,
        authorize: async () => {},
        kind: "preview",
      }),
    ).toEqual({ sources: { [ID]: { [name]: [{ id: "a", values: { label: "render" } }] } } });
  },
  head_contributions: async () => {
    const { contributes, hasShareImages } = await fixtureManifest();
    const manifest = { ...probe, contributes, hasShareImages } as PluginManifest;
    expect(externalDeclarations(manifest).contributes).toEqual(contributes);
    // Both reserved entries answer through the operations the definition names.
    const source = `export default {slug:"parity-probe",version:"1.0.0",tier:2,
      contributionsOperation:"head", shareImagesOperation:"images",
      operations:{
        head:async(ctx,args)=>({head:{[args.pageIds[0]]:[{kind:"link",rel:"alternate",hreflang:"de",pageId:args.pageIds[0]}]},lang:{[args.pageIds[0]]:ctx.invocation.origin === "render" ? "de" : "?"}}),
        images:async(ctx,args)=>({images:{[args.pageIds[0]]:"${ID}"}}),
      }};`;
    expect(await renderPoint(source, manifest, "$contributions", { pageIds: [ID] })).toEqual({
      head: { [ID]: [{ kind: "link", rel: "alternate", hreflang: "de", pageId: ID }] },
      lang: { [ID]: "de" },
    });
    expect(await renderPoint(source, manifest, "$shareImages", { pageIds: [ID] })).toEqual({
      images: { [ID]: ID },
    });
  },
  link_resolve: async () => {
    const linkResolveReads = (await fixtureManifest()).linkResolveReads;
    expect(linkResolveReads?.tables.length).toBeGreaterThan(0);
    const manifest = { ...probe, hasLinkResolve: true, linkResolveReads } as PluginManifest;
    expect(externalDeclarations(manifest).linkResolveReads).toEqual(linkResolveReads);
    // The reserved entry answers through the operation the definition names.
    expect(
      await renderPoint(
        `export default {slug:"parity-probe",version:"1.0.0",tier:2,linkResolveOperation:"variants",
          operations:{variants:async(ctx,args)=>({pages:{[args.pageIds[0]]:{variant:"de",group:ctx.invocation.origin}}})}};`,
        manifest,
        "$linkResolve",
        { pageIds: [ID] },
      ),
    ).toEqual({ pages: { [ID]: { variant: "de", group: "render" } } });
  },
  // #1729 — the files and placeholders are reviewed data the definition
  // carries; the build data and the deferral verdicts are reserved entries
  // the sandbox answers as render calls.
  client_assets: async () => {
    const fixture = await fixtureManifest();
    const manifest = {
      ...probe,
      clientFiles: fixture.clientFiles,
      hasBuildData: true,
      hasDeferrals: true,
      deferralPlaceholders: fixture.deferralPlaceholders,
    } as PluginManifest;
    const declarations = externalDeclarations(manifest);
    expect(declarations.clientFiles).toEqual(fixture.clientFiles);
    expect(declarations.deferralPlaceholders).toEqual(fixture.deferralPlaceholders);
    const source = `export default {slug:"parity-probe",version:"1.0.0",tier:2,
      buildDataOperation:"data",deferralsOperation:"gate",
      operations:{
        data:async(ctx)=>({data:{origin:ctx.invocation.origin}}),
        gate:async(ctx,args)=>({deferrals:{[args.moduleIds[0]]:{reason:"marketing",placeholderModuleSlug:"ph",placeholder:{name:"consent",values:{category:"marketing",category_label:"Marketing"}}}}}),
      }};`;
    expect(await renderPoint(source, manifest, "$buildData", {})).toEqual({
      data: { origin: "render" },
    });
    expect(
      await renderPoint(source, manifest, "$deferrals", { moduleIds: [ID], modules: [] }),
    ).toEqual({
      deferrals: {
        [ID]: {
          reason: "marketing",
          placeholderModuleSlug: "ph",
          placeholder: {
            name: "consent",
            values: { category: "marketing", category_label: "Marketing" },
          },
        },
      },
    });
  },
  // #1729 (Q7 A) — no plugin code runs on the URL path: the definition
  // carries the tables, and the encoders are the host's, reading the value
  // the host attached to the page.
  url_slots: async () => {
    const manifest = {
      ...probe,
      urlTables: URL_TABLES,
      urlContributions: [{ slot: "host" as const }, { slot: "path-prefix" as const }],
    };
    expect(externalDeclarations(manifest).urlTables).toEqual(URL_TABLES);
    const encoders = declaredUrlContributions("parity-probe", URL_TABLES);
    const page = {
      pageId: ID,
      slug: "pricing",
      ancestorSlugs: [],
      isHomePage: false,
      annotations: {
        [declaredUrlAnnotationKey("parity-probe")]: {
          id: ID,
          value: "de",
          segment: "de",
          host: "de.example.com",
        },
      },
    };
    const bySlot = Object.fromEntries(encoders.map((c) => [c.slot, c]));
    expect(
      bySlot["path-prefix"]?.slot === "path-prefix" && bySlot["path-prefix"].encode(page),
    ).toEqual(["de"]);
    expect(bySlot.host?.slot === "host" && bySlot.host.encode(page)).toBe("de.example.com");
    // A page without a row keeps the site's own shape.
    const bare = { ...page, annotations: {} };
    expect(
      bySlot["path-prefix"]?.slot === "path-prefix" && bySlot["path-prefix"].encode(bare),
    ).toEqual([]);
  },
  list_resolve: async () => {
    const manifest = { ...probe, hasListResolve: true } as PluginManifest;
    expect(
      await renderPoint(
        `export default {slug:"parity-probe",version:"1.0.0",tier:2,listResolveOperation:"overlays",
          operations:{overlays:async(ctx,args)=>({overlays:{[args.variants[0]]:{values:{"list/l1/item/i1/label":ctx.invocation.origin},hidden:[]}}})}};`,
        manifest,
        "$listResolve",
        { variants: ["de"] },
      ),
    ).toEqual({ overlays: { de: { values: { "list/l1/item/i1/label": "render" }, hidden: [] } } });
  },
  content_variants: async () => {
    const manifest = { ...probe, hasContentVariants: true } as PluginManifest;
    expect(
      await renderPoint(
        `export default {slug:"parity-probe",version:"1.0.0",tier:2,contentVariantsOperation:"chrome",
          operations:{chrome:async(ctx,args)=>({resolutions:{[args.pages[0].pageId]:{"layout:footer:0":{values:{note:ctx.invocation.origin}}}}})}};`,
        manifest,
        "$contentVariants",
        { pages: [{ pageId: ID, placements: [] }] },
      ),
    ).toEqual({ resolutions: { [ID]: { "layout:footer:0": { values: { note: "render" } } } } });
  },
  batch_jobs: async () => {
    expect(
      await sandboxed(
        `return ctx.invocation.batchRunId`,
        {},
        { origin: "batch", actorId: ID, batchRunId: ID },
      ),
    ).toBe(ID);
  },
};

describe("#1729 — every capability is brokered for external plugins or tracked", () => {
  it("every capability has a status", () => {
    for (const capability of pluginCapability.options) {
      expect(EXTERNAL_CAPABILITY_STATUS[capability]?.status).toMatch(/^(brokered|planned)$/);
      expect(CAPABILITY_MANIFEST_FIELDS[capability]).toBeDefined();
    }
  });

  it("a planned capability names its issue and is refused at installation review", () => {
    for (const capability of pluginCapability.options) {
      const status = EXTERNAL_CAPABILITY_STATUS[capability];
      if (status.status !== "planned") continue;
      expect(Number.isSafeInteger(status.issue) && status.issue > 0).toBe(true);
      expect(() =>
        validateInstallationPolicy({
          ...probe,
          requestedCapabilities: [capability],
          capabilityReasons: { [capability]: "probe" },
        }),
      ).toThrow(new RegExp(`\`${capability}\`.*\\(#${status.issue}\\)`));
    }
  });

  it("the refusal of a planned capability names it, its issue and what to remove (injected record)", () => {
    // Independent of the real record, which may have no planned entry left.
    const record = {
      ...EXTERNAL_CAPABILITY_STATUS,
      url_slots: { status: "planned", issue: 4242 },
    } as const;
    const refusal = externalCapabilityRefusal("url_slots", record);
    expect(refusal).toContain(
      "`url_slots` (Page addresses) is not available to runtime-installed plugins yet (#4242)",
    );
    expect(refusal).toContain("remove `urlContributions`, `urlTables`, which need it");
    expect(externalCapabilityRefusal("cms_admin", record)).toBeNull();
  });

  it("a declaration no installed plugin can make is refused at submission and review, with its issue (#1737)", () => {
    // A well-formed value per declaration: the refusal must come from the
    // record, not from a manifest that fails its shape.
    const sample: Readonly<Record<string, unknown>> = {
      hasStaticRender: true,
      imports: [
        {
          kind: "probe_rows",
          label: "Probe rows",
          description: "Rows of another system.",
          release: "stage",
          fields: { text: { type: "text", maxLength: 10 } },
        },
      ],
    };
    for (const [field, declaration] of Object.entries(EXTERNAL_UNAVAILABLE_DECLARATIONS)) {
      expect(sample[field]).toBeDefined();
      const manifest = { ...probe, [field]: sample[field] } as PluginManifest;
      expect(() => validateInstallationPolicy(manifest)).toThrow(`(#${declaration?.issue})`);
      // `plugins.submit` / `plugins.revalidate`: a tier-2 submission without grants.
      const hints = validateManifest(manifest).failures.map((f) => f.hint);
      expect(hints.some((h) => h.includes(`(#${declaration?.issue})`))).toBe(true);
      // A shipped plugin declares it as before.
      expect(
        validateManifest({ ...manifest, tier: 1 }).failures.map((f) => f.hint),
      ).not.toContainEqual(expect.stringContaining(`#${declaration?.issue}`));
    }
  });

  it("every brokered capability has a sandbox smoke", () => {
    const missing = pluginCapability.options.filter((c) => isExternallyBrokered(c) && !SMOKES[c]);
    expect(missing).toEqual([]);
    const stale = Object.keys(SMOKES).filter((c) => !isExternallyBrokered(c as PluginCapability));
    expect(stale).toEqual([]);
  });

  for (const capability of pluginCapability.options.filter(isExternallyBrokered)) {
    it(`smoke: ${capability} reaches the host through the sandbox`, async () => {
      await SMOKES[capability]?.();
    });
  }

  it("the definition carries every manifest field of a brokered capability", async () => {
    const fixture = await fixtureManifest();
    // As externalPluginDefinition builds it: the data, and each announced
    // point's definition key set to its reserved entry.
    const declarations = {
      ...externalDeclarations(fixture),
      ...renderPointDefinition(fixture, () => null).keys,
    } as Record<string, unknown>;
    for (const capability of pluginCapability.options.filter(isExternallyBrokered)) {
      for (const field of CAPABILITY_MANIFEST_FIELDS[capability]) {
        if (field.startsWith("has") && !DEFINITION_KEY[field])
          throw new Error(
            `${capability}: map the manifest flag "${field}" in DEFINITION_KEY to the definition key its reserved entry sets`,
          );
        // The fixture must really set the field, or the check below proves nothing.
        expect({ capability, field, set: fixture[field] !== undefined }).toEqual({
          capability,
          field,
          set: true,
        });
        const key = DEFINITION_KEY[field] ?? field;
        expect({ capability, field, carried: declarations[key] !== undefined }).toEqual({
          capability,
          field,
          carried: true,
        });
      }
    }
  });

  it("the definition carries the data declarations core reads for any plugin (§10)", () => {
    const declared = {
      listExt: { field: { type: "object", additionalProperties: false, properties: {} } },
      visitorProjection: { notes: ["body"] },
      component: { tag: "parity-probe-widget", shadowMode: "open" },
    } as const;
    const declarations = externalDeclarations({
      ...probe,
      ...declared,
    } as unknown as PluginManifest);
    expect(declarations).toMatchObject(declared);
  });

  it("the host has no hand-written list of capabilities", () => {
    const names = new Set<string>(pluginCapability.options);
    for (const file of ["external-plugin.ts", "loader.ts"]) {
      const text = readFileSync(resolve(import.meta.dir, file), "utf8");
      for (const array of text.match(/\[[^\][]*\]/g) ?? []) {
        const listed = (array.match(/"([a-z_]+)"/g) ?? [])
          .map((q) => q.slice(1, -1))
          .filter((n) => names.has(n));
        // One capability name in brackets is a gate (`has("cms_admin")`);
        // two or more is a list that the status record must replace.
        expect({ file, listed: listed.length > 1 ? listed : [] }).toEqual({ file, listed: [] });
      }
    }
  });
});

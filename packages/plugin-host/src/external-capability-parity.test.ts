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
import { validateInstallationPolicy } from "@caelo-cms/plugin-sandbox";
import {
  CAPABILITY_MANIFEST_FIELDS,
  EXTERNAL_CAPABILITY_STATUS,
  isExternallyBrokered,
  manifestFromDefinition,
  type PluginCapability,
  type PluginContext,
  type PluginDefinition,
  type PluginManifest,
  pluginCapability,
} from "@caelo-cms/plugin-sdk";
import { externalDeclarations } from "./external-plugin.js";
import { runSandbox } from "./sandbox-runtime.js";

const PLUGINS_ROOT = resolve(import.meta.dir, "../../plugins");
const ID = "11111111-1111-4111-8111-111111111111";

const probe: PluginManifest = {
  slug: "parity-probe",
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["run"],
  hasStaticRender: false,
  hasBuildAssets: false,
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
  return {
    ...search,
    ...assistant,
    collections: search.collections,
    collectionOperations: search.collectionOperations,
    pageOutputObserver: search.pageOutputObserver,
    batchOperations: search.batchOperations,
    tools: search.tools,
    skills: search.skills,
    adminSchema: search.adminSchema,
    workers: search.workers,
    listTypes: search.listTypes,
    aiChatOperations: assistant.aiChatOperations,
    tier: 2,
  };
}

/**
 * Manifest fields whose definition key differs: a `has…` flag says a
 * reserved sandbox entry (`$contentVariants`, …) answers the point (Q3).
 * A brokered capability's `has…` field without an entry here fails.
 */
const DEFINITION_KEY: Partial<Record<keyof PluginManifest, string>> = {};

const SMOKES: Partial<Record<PluginCapability, () => Promise<void>>> = {
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
    const declarations = externalDeclarations(fixture) as Record<string, unknown>;
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

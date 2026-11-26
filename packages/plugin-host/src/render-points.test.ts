// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the render-point runtime (render-points.ts): reserved entries the
 * sandbox child resolves from the plugin's own definition, `$inspect`
 * holding the definition to the manifest's announcements, answers over one
 * wire line in parts under the caller's cap, and page ids in chunks.
 * Runs the real Deno sandbox.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContext, PluginManifest } from "@caelo-cms/plugin-sdk";
import {
  announcedRenderPoints,
  assertAnswerSize,
  chunkPageIds,
  RENDER_POINT_CHUNK_BYTES,
  renderPointDefinition,
} from "./render-points.js";
import { runSandbox } from "./sandbox-runtime.js";

const base: PluginManifest = {
  slug: "point-probe",
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["sources", "other"],
  hasStaticRender: false,
};
const sources: PluginManifest = {
  ...base,
  listSources: [
    {
      name: "probe_items",
      description: "Items a probe offers.",
      node: { label: "Item", fields: [{ name: "label", label: "Label", type: "text" }] },
    },
  ],
} as PluginManifest;
const context: PluginContext = {
  query: {
    insert: async () => ({ id: "11111111-1111-4111-8111-111111111111" }),
    list: async () => [],
    update: async () => {},
    updateMany: async () => {},
    delete: async () => {},
    compareAndSwap: async () => true,
  },
  api: { list: async () => [], get: async () => null },
  theme: { tokens: {} },
  visitor: { id: "v", publicUserId: null, ipHash: "", sessionToken: null },
  captcha: { requireProof: async () => false },
  invocation: { origin: "render", actorId: "system", renderId: "pass-1" },
};

/** A plugin source whose definition sets `extra` (`listSourcesOperation: "sources"`). */
function source(extra: string, body = "return { sources: args.pageIds };"): string {
  return `import { definePlugin } from "@caelo-cms/plugin-sdk";
  export default definePlugin({slug:"point-probe",version:"1.0.0",tier:2,schema:{},${extra}
    operations:{sources:async(ctx,args)=>{${body}},other:async()=>"other"}});`;
}

function run(
  manifest: PluginManifest,
  code: string,
  operation: string,
  args: unknown = {},
  extra: Partial<Parameters<typeof runSandbox>[0]> = {},
) {
  return runSandbox({
    source: code,
    manifest,
    operation,
    args,
    context,
    authorize: async () => {},
    kind: "preview",
    ...extra,
  });
}

describe("reserved entries (Q3 A)", () => {
  it("the child answers $listSources with the operation the definition names", async () => {
    expect(
      await run(sources, source('listSourcesOperation:"sources",'), "$listSources", {
        pageIds: ["a", "b"],
      }),
    ).toEqual({ sources: ["a", "b"] });
  });

  it("an entry the definition does not answer is not declared", async () => {
    await expect(run(base, source(""), "$listSources")).rejects.toThrow(
      "SandboxOperationNotDeclared",
    );
  });

  it("$inspect refuses a definition that answers no announced point, or one not announced", async () => {
    await expect(
      run(sources, source(""), "$inspect", sources, { denySdkCalls: true }),
    ).rejects.toThrow("SandboxRenderPointMismatch: the manifest's listSources");
    await expect(
      run(base, source('listSourcesOperation:"sources",'), "$inspect", base, {
        denySdkCalls: true,
      }),
    ).rejects.toThrow("SandboxRenderPointMismatch");
    await expect(
      run(sources, source('listSourcesOperation:"missing",'), "$inspect", sources, {
        denySdkCalls: true,
      }),
    ).rejects.toThrow("SandboxRenderPointMissing: listSourcesOperation");
    expect(
      await run(sources, source('listSourcesOperation:"sources",'), "$inspect", sources, {
        denySdkCalls: true,
      }),
    ).toBe(true);
  });

  it("an external definition carries each announced point as its entry", () => {
    expect(announcedRenderPoints(base)).toEqual([]);
    expect(announcedRenderPoints(sources)).toEqual(["$listSources"]);
    const def = renderPointDefinition(sources, (entry) => entry);
    expect(def.keys).toEqual({ listSourcesOperation: "$listSources" });
    expect(def.operations).toEqual({ $listSources: "$listSources" });
  });
});

describe("answers over one wire line", () => {
  const big = 'return { text: "é".repeat(700000) + "\\u0000\\"" };';

  it("arrive in parts, intact, when the caller accepts their size", async () => {
    const value = (await run(
      base,
      source("", big),
      "sources",
      {},
      {
        maxResultBytes: 8 * 1024 * 1024,
      },
    )) as { text: string };
    expect(value.text.length).toBe(700002);
    expect(value.text.endsWith('\\u0000"'.replace("\\u0000", "\u0000"))).toBe(true);
  });

  it("are refused while they arrive once they pass the cap", async () => {
    await expect(
      run(base, source("", big), "sources", {}, { maxResultBytes: 1_000_000 }),
    ).rejects.toThrow("SandboxAnswerTooLarge");
  });
});

describe("chunks and caps", () => {
  it("splits page ids under the chunk budget, in order, and asks nothing for none", () => {
    const ids = Array.from(
      { length: 50_000 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const chunks = chunkPageIds(ids);
    expect(chunks.length).toBe(4);
    expect(chunks.flat()).toEqual(ids);
    for (const c of chunks)
      expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThanOrEqual(RENDER_POINT_CHUNK_BYTES);
    expect(chunkPageIds([])).toEqual([]);
  });

  it("refuses an in-process answer over the point's cap with the same words", () => {
    expect(() =>
      assertAnswerSize({ point: "list-sources", maxAnswerBytes: 10 }, "probe", {
        a: "x".repeat(20),
      }),
    ).toThrow("probe: the answer is 28 bytes, more than the 10 a render accepts");
  });
});

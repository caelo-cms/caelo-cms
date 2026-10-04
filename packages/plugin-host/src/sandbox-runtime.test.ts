// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext, PluginManifest } from "@caelo-cms/plugin-sdk";
import { previewContext } from "./preview-context.js";
import { buildIsolatedBundle, runSandbox } from "./sandbox-runtime.js";

const manifest: PluginManifest = {
  slug: "sandbox-probe",
  version: "1.0.0",
  tier: 2,
  schema: { notes: { id: "uuid", body: "text" } },
  operations: ["run"],
  hasStaticRender: false,
};
const context: PluginContext = {
  query: {
    insert: async () => ({ id: "11111111-1111-4111-8111-111111111111" }),
    list: async () => [{ body: "host result" }],
    update: async () => {},
    delete: async () => {},
    compareAndSwap: async () => true,
  },
  api: { list: async () => [], get: async () => null },
  theme: { tokens: { color: "blue" } },
  visitor: { id: "visitor", publicUserId: null, ipHash: "", sessionToken: null },
  captcha: { requireProof: async (token) => token === "valid" },
  invocation: {
    origin: "chat",
    actorId: "ai-actor",
    operatorActorId: "owner",
    chatBranchId: "22222222-2222-4222-8222-222222222222",
  },
};
function invoke(body: string, overrides: Partial<Parameters<typeof runSandbox>[0]> = {}) {
  return runSandbox({
    source: `import { definePlugin } from "@caelo-cms/plugin-sdk";
    export default definePlugin({slug:"sandbox-probe",version:"1.0.0",tier:2,schema:{},
      operations:{run:async(ctx,args)=>{${body}}}});`,
    manifest,
    operation: "run",
    args: {},
    context,
    authorize: async () => {},
    ...overrides,
  });
}
describe("actual Deno plugin execution", () => {
  it("brokers validated SDK calls and returns host identity/theme", async () => {
    expect(
      await invoke(
        'const rows = await ctx.query.list("notes"); return {rows, color:ctx.theme.tokens.color, visitor:ctx.visitor.id};',
      ),
    ).toEqual({ rows: [{ body: "host result" }], color: "blue", visitor: "visitor" });
  });
  it("does not expose host globals, credentials or elevated handles", async () => {
    expect(await invoke("return [typeof Bun, typeof ctx.cms, typeof ctx.ai];")).toEqual([
      "undefined",
      "undefined",
      "undefined",
    ]);
    expect(await invoke('try { return process.env.HOME; } catch { return "denied"; }')).toBe(
      "denied",
    );
  });
  it("rejects forbidden imports and their re-export spelling before loading", async () => {
    await expect(invoke("", { source: 'export { readFileSync } from "node:fs";' })).rejects.toThrow(
      "SandboxSourceRejected",
    );
    await expect(invoke("", { source: 'export * from "file:///etc/passwd";' })).rejects.toThrow(
      "SandboxSourceRejected",
    );
  });
  it("enforces runtime denial even when source obtains globals indirectly", async () => {
    expect(
      await invoke(
        'try { await globalThis["fetch"]("https://example.com"); return "escaped"; } catch { return "denied"; }',
      ),
    ).toBe("denied");
    expect(
      await invoke(
        'try { return globalThis["De"+"no"].readTextFileSync("/etc/passwd"); } catch { return "denied"; }',
      ),
    ).toBe("denied");
  });
  it("terminates an infinite loop", async () => {
    await expect(invoke("while(true) {}", { timeoutMs: 100 })).rejects.toThrow("SandboxTimeout");
  });
  it("returns a deadline error while an already-started SDK call settles", async () => {
    let finish: (() => void) | undefined;
    const delayed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await expect(
        invoke('return await ctx.query.list("notes");', {
          timeoutMs: 250,
          context: {
            ...context,
            query: {
              ...context.query,
              list: async () => {
                await delayed;
                return [];
              },
            },
          },
        }),
      ).rejects.toThrow("SandboxTimeout");
    } finally {
      finish?.();
    }
  });
  it("validates arguments in the host", async () => {
    await expect(invoke('return await ctx.query.delete("notes", "bad-id");')).rejects.toThrow(
      "SandboxOperationFailed",
    );
  });
  it("rechecks authorization before each broker call", async () => {
    let checks = 0;
    await expect(
      invoke('return await ctx.query.list("notes");', {
        authorize: async () => {
          if (++checks > 1) throw new Error("permission revoked");
        },
      }),
    ).rejects.toThrow("permission revoked");
  });
  it("rejects lossy CAS values before RPC and can continue after a rejected call", async () => {
    const calls: unknown[][] = [];
    const result = (await invoke(
      `
      const errors = [];
      const invalid = [undefined, NaN, Infinity, () => 1, Symbol("x"), 1n,
        {nested: undefined}, [undefined]];
      for (const value of invalid) {
        for (const side of ["expected", "patch"]) {
          const expected = {revision: "base"};
          const patch = {revision: "next"};
          (side === "expected" ? expected : patch).invalid = value;
          try {
            await ctx.query.compareAndSwap("notes", "11111111-1111-4111-8111-111111111111", expected, patch);
          } catch (error) { errors.push(error.message); }
        }
      }
      const saved = await ctx.query.compareAndSwap("notes", "11111111-1111-4111-8111-111111111111",
        {revision: "base", note: null}, {revision: "next"});
      return {errors, saved};
    `,
      {
        context: {
          ...context,
          query: {
            ...context.query,
            compareAndSwap: async (...args) => {
              calls.push(args);
              return true;
            },
          },
        },
      },
    )) as { errors: string[]; saved: boolean };
    expect(result.errors).toHaveLength(16);
    expect(result.errors.every((message) => message.includes("requires JSON values"))).toBe(true);
    expect(result.saved).toBe(true);
    expect(calls).toEqual([
      [
        "notes",
        "11111111-1111-4111-8111-111111111111",
        { revision: "base", note: null },
        { revision: "next" },
      ],
    ]);
  });
  it("rejects oversized plugin output", async () => {
    await expect(invoke('return "x".repeat(1100000);')).rejects.toThrow("SandboxMessageTooLarge");
  });
});

describe("host-side bundling cannot read the host filesystem", () => {
  // Review of #473: bundling runs in the host before Deno's --deny-read
  // applies. A require() of a host path passed the validator and its
  // contents were inlined into the plugin bundle.
  const secretPath = join(mkdtempSync(join(tmpdir(), "caelo-sandbox-")), "sa.json");
  writeFileSync(secretPath, JSON.stringify({ private_key: "do-not-leak-1234" }));

  it("the validator rejects require() and import.meta", async () => {
    await expect(
      invoke("", { source: `const s = require(${JSON.stringify(secretPath)}); export default s;` }),
    ).rejects.toThrow("forbidden-require");
    await expect(invoke("", { source: "export default { u: import.meta.url };" })).rejects.toThrow(
      "forbidden-import-meta",
    );
  });

  it("the bundler refuses host paths even without the validator in front", async () => {
    await expect(
      buildIsolatedBundle(`const s = require(${JSON.stringify(secretPath)}); export default s;`),
    ).rejects.toThrow("SandboxResolveDenied");
    await expect(
      buildIsolatedBundle(`import s from ${JSON.stringify(secretPath)}; export default s;`),
    ).rejects.toThrow("SandboxResolveDenied");
  });

  it("still bundles the SDK import", async () => {
    const out = await buildIsolatedBundle(
      'import { definePlugin } from "@caelo-cms/plugin-sdk"; export default definePlugin({slug:"x",version:"1.0.0",tier:2,schema:{},operations:{}});',
    );
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("visitor identity handed to plugin code", () => {
  it("never includes the visitor's session bearer token", async () => {
    expect(
      await invoke("return ctx.visitor.sessionToken;", {
        context: { ...context, visitor: { ...context.visitor, sessionToken: "secret-bearer" } },
      }),
    ).toBeNull();
  });
});

describe("invocation handed to plugin code", () => {
  it("is visible to the plugin and cannot be changed by it", async () => {
    expect(
      await invoke(
        'try { ctx.invocation.chatBranchId = "x"; } catch {} return {origin: ctx.invocation.origin, branch: ctx.invocation.chatBranchId, frozen: Object.isFrozen(ctx.invocation)};',
      ),
    ).toEqual({
      origin: "chat",
      branch: "22222222-2222-4222-8222-222222222222",
      frozen: true,
    });
  });
});

it("preview denies public/private writes and cross-plugin RPC in the real sandbox", async () => {
  const readonly = previewContext({ ...context, adminQuery: context.query });
  const result = await invoke(
    `
    const denied = [];
    for (const target of [ctx.query, ctx.adminQuery]) {
      const id = "11111111-1111-4111-8111-111111111111";
      for (const [method, args] of [["insert", ["notes", {body:"changed"}]], ["update", ["notes", id, {body:"changed"}]], ["delete", ["notes", id]], ["compareAndSwap", ["notes", id, {body:"old"}, {body:"changed"}]]]) {
        try { await target[method](...args); } catch (e) { denied.push(e.message); }
      }
    }
    try { await ctx.api.get({}); } catch (e) { denied.push(e.message); }
    return { denied, rows: await ctx.adminQuery.list("notes") };
  `,
    { context: readonly },
  );
  expect(result).toEqual({
    denied: Array(9).fill("PluginPreviewReadOnly"),
    rows: [{ body: "host result" }],
  });
});

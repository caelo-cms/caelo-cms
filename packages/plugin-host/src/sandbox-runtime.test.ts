// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext, PluginManifest } from "@caelo-cms/plugin-sdk";
import { previewContext } from "./preview-context.js";
import {
  buildIsolatedBundle,
  exitReason,
  runSandbox,
  runSandboxWithBundler,
  streamHead,
} from "./sandbox-runtime.js";

const manifest: PluginManifest = {
  slug: "sandbox-probe",
  version: "1.0.0",
  tier: 2,
  schema: { notes: { id: "uuid", body: "text" } },
  tableKinds: { notes: "visitor-state" },
  operations: ["run"],
  hasStaticRender: false,
};
const context: PluginContext = {
  query: {
    insert: async () => ({ id: "11111111-1111-4111-8111-111111111111" }),
    list: async () => [{ body: "host result" }],
    update: async () => {},
    updateMany: async () => {},
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
describe("configuration and collections through the sandbox (#1645, #1648)", () => {
  it("reads config and entity settings, chunks a large upsert below the line limit, and refuses an undeclared collection", async () => {
    const upserts: number[] = [];
    const deleted: string[][] = [];
    const ctx: PluginContext = {
      ...context,
      invocation: {
        origin: "observer",
        actorId: "system",
        stageRunId: "33333333-3333-4333-8333-333333333333",
      },
      config: {
        get: async () => ({ limit: 7 }),
        entity: async (_k, id) => ({ excluded: id === "p1" }),
        entities: async (_k, ids) =>
          new Map(ids.map((id) => [id, { excluded: id === "p1" }] as const)),
        configured: async () => ["p1"],
      },
      collections: {
        pages: {
          upsert: async (docs) => {
            upserts.push(docs.length);
          },
          delete: async (ids) => {
            deleted.push([...ids]);
          },
          get: async (id) => ({ id, lang: "de", values: {} }),
          setProfile: async () => {},
        },
      },
    };
    const value = await invoke(
      `const c = await ctx.config.get();
       const m = await ctx.config.entities("page", ["p1", "p2"]);
       const big = "x".repeat(20000);
       const docs = [];
       for (let i = 0; i < 120; i++) docs.push({ id: "d" + i, lang: "de", values: { title: big } });
       await ctx.collections.pages.upsert(docs);
       await ctx.collections.pages.delete(["a", "b"]);
       let refused = "";
       try { await ctx.collections.other?.upsert([]); refused = ctx.collections.other ? "present" : "absent"; } catch (e) { refused = e.message; }
       return { limit: c.limit, isMap: m instanceof Map, p1: m.get("p1").excluded, p2: m.get("p2").excluded, refused };`,
      { context: ctx },
    );
    expect(value).toEqual({ limit: 7, isMap: true, p1: true, p2: false, refused: "absent" });
    // 120 documents of ~20 KB: more than one 1 MB message, so several calls, all of them.
    expect(upserts.length).toBeGreaterThan(2);
    expect(upserts.reduce((a, b) => a + b, 0)).toBe(120);
    expect(deleted).toEqual([["a", "b"]]);
  });

  it("refuses a collection call naming a collection the host did not attach", async () => {
    const ctx: PluginContext = {
      ...context,
      collections: {
        pages: {
          upsert: async () => {},
          delete: async () => {},
          get: async () => null,
          setProfile: async () => {},
        },
      },
    };
    await expect(
      invoke('await ctx.collections.pages.get("x"); return Object.keys(ctx.collections);', {
        context: ctx,
      }),
    ).resolves.toEqual(["pages"]);
    // A plugin without the grant has no handle at all.
    await expect(invoke("return typeof ctx.collections + typeof ctx.config;")).resolves.toBe(
      "undefinedundefined",
    );
  });
});

describe("actual Deno plugin execution", () => {
  it("brokers validated SDK calls and returns host identity/theme", async () => {
    expect(
      await invoke(
        'const rows = await ctx.query.list("notes"); return {rows, color:ctx.theme.tokens.color, visitor:ctx.visitor.id};',
      ),
    ).toEqual({ rows: [{ body: "host result" }], color: "blue", visitor: "visitor" });
  });
  it("does not expose host globals, credentials or elevated handles", async () => {
    expect(
      await invoke("return [typeof Bun, typeof ctx.cms, typeof ctx.ai, typeof process];"),
    ).toEqual(["undefined", "undefined", "undefined", "undefined"]);
    expect(await invoke('try { return process.env.HOME; } catch { return "denied"; }')).toBe(
      "denied",
    );
  });
  it("has no ctx.cms even with the grant and a host handle, so core calls stay in-process", async () => {
    // #1495 relies on this: pages.resolve_public_urls cannot be reached from
    // the sandbox, so a live-build refusal never crosses it as a string.
    const granted = {
      ...context,
      cms: {
        call: async () => {
          throw new Error("the sandbox reached the host's ctx.cms");
        },
      },
    };
    expect(
      await invoke("return typeof ctx.cms;", {
        manifest: { ...manifest, requestedCapabilities: ["cms_admin"] },
        context: granted as PluginContext,
      }),
    ).toBe("undefined");
  });
  it("rejects forbidden imports and their re-export spelling before loading", async () => {
    await expect(invoke("", { source: 'export { readFileSync } from "node:fs";' })).rejects.toThrow(
      "SandboxSourceRejected",
    );
    await expect(invoke("", { source: 'export * from "file:///etc/passwd";' })).rejects.toThrow(
      "SandboxSourceRejected",
    );
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

/**
 * The runtime layer on its own: these sources would all be refused by
 * `validateSource`, so they are bundled with `buildIsolatedBundle`
 * directly and must still be contained by Deno's permissions, the
 * prelude, and the code-generation ban.
 */
describe("runtime layer without the validator in front", () => {
  function invokeUnvalidated(topLevel: string, body: string) {
    return runSandboxWithBundler(
      {
        source: `import { definePlugin } from "@caelo-cms/plugin-sdk";
        ${topLevel}
        export default definePlugin({slug:"sandbox-probe",version:"1.0.0",tier:2,schema:{},
          operations:{run:async(ctx,args)=>{${body}}}});`,
        manifest,
        operation: "run",
        args: {},
        context,
        authorize: async () => {},
      },
      buildIsolatedBundle,
    );
  }

  it("a child that crashes says why, in one bounded line", async () => {
    // An exception outside the operation's promise: nothing the protocol
    // can carry, so the exit has to.
    await expect(
      invokeUnvalidated(
        'setTimeout(() => { throw new Error("boom-before-the-call"); }, 0);',
        "await new Promise(() => {});",
      ),
    ).rejects.toThrow(/SandboxExited: code 1 \(.*boom-before-the-call.*\)/);
  });

  it("the validator does refuse these sources on the production path", async () => {
    await expect(
      invoke('return globalThis["De"+"no"].readTextFileSync("/etc/passwd");'),
    ).rejects.toThrow("SandboxSourceRejected");
  });

  it("denies network and filesystem when source obtains globals indirectly", async () => {
    expect(
      await invokeUnvalidated(
        "",
        'try { await globalThis["fetch"]("https://example.com"); return "escaped"; } catch { return "denied"; }',
      ),
    ).toBe("denied");
    expect(
      await invokeUnvalidated(
        "",
        'try { return globalThis["De"+"no"].readTextFileSync("/etc/passwd"); } catch { return "denied"; }',
      ),
    ).toBe("denied");
  });

  it("removes Deno before plugin top-level code runs", async () => {
    // ESM hoists `import plugin`, so a bootstrap that removed Deno in the
    // entry body would lose to this capture.
    expect(
      await invokeUnvalidated(
        "const g = globalThis; const captured = typeof g.Deno; let writer = 'none';\n" +
          "try { writer = typeof g.Deno.stdout.writeSync.bind(g.Deno.stdout); } catch { writer = 'denied'; }",
        "return { captured, writer, now: typeof globalThis.Deno };",
      ),
    ).toEqual({ captured: "undefined", writer: "denied", now: "undefined" });
  });

  it("protocol primitives survive top-level tampering", async () => {
    expect(
      await invokeUnvalidated(
        'JSON.stringify = () => \'{"kind":"result","value":"forged"}\';\n' +
          "JSON.parse = () => ({ forged: true });\n" +
          "Map.prototype.get = () => undefined; String.prototype.indexOf = () => -1;\n" +
          'console.log("top-level output must not reach the protocol channel");',
        'const rows = await ctx.query.list("notes"); return { rows, real: true };',
      ),
    ).toEqual({ rows: [{ body: "host result" }], real: true });
  });

  it("denies code generation from strings at runtime", async () => {
    expect(
      await invokeUnvalidated(
        "",
        `const out = [];
        for (const attempt of [
          () => (0, eval)("1 + 1"),
          () => (() => {})["con" + "structor"]("return 1")(),
          () => (async () => {}).constructor("return 1"),
        ]) { try { out.push(attempt()); } catch { out.push("denied"); } }
        return out;`,
      ),
    ).toEqual(["denied", "denied", "denied"]);
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

  it("plugin code cannot import the bootstrap modules", async () => {
    // The prelude exports the captured stdout writer; only the entry may import it.
    for (const target of ["caelo:prelude", "caelo:entry", "caelo:plugin"]) {
      await expect(
        buildIsolatedBundle(`import * as m from "${target}"; export default m;`),
      ).rejects.toThrow("SandboxResolveDenied");
    }
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

it("carries updateMany through the bridge and refuses a malformed id list (#1391)", async () => {
  const calls: unknown[][] = [];
  const result = await invoke(
    `
    const id = "11111111-1111-4111-8111-111111111111";
    await ctx.query.updateMany("notes", [id], { body: "bulk" });
    const errors = [];
    for (const ids of [["not-a-uuid"], id, [1]]) {
      try { await ctx.query.updateMany("notes", ids, { body: "x" }); } catch (e) { errors.push(e.message); }
    }
    return { errors: errors.length };
  `,
    {
      context: {
        ...context,
        query: {
          ...context.query,
          updateMany: async (...args) => {
            calls.push(args);
          },
        },
      },
    },
  );
  expect(result).toEqual({ errors: 3 });
  expect(calls).toEqual([["notes", ["11111111-1111-4111-8111-111111111111"], { body: "bulk" }]]);
});

it("preview denies public/private writes and cross-plugin RPC in the real sandbox", async () => {
  const readonly = previewContext({ ...context, adminQuery: context.query });
  const result = await invoke(
    `
    const denied = [];
    for (const target of [ctx.query, ctx.adminQuery]) {
      const id = "11111111-1111-4111-8111-111111111111";
      for (const [method, args] of [["insert", ["notes", {body:"changed"}]], ["update", ["notes", id, {body:"changed"}]], ["updateMany", ["notes", [id], {body:"changed"}]], ["delete", ["notes", id]], ["compareAndSwap", ["notes", id, {body:"old"}, {body:"changed"}]]]) {
        try { await target[method](...args); } catch (e) { denied.push(e.message); }
      }
    }
    try { await ctx.api.get({}); } catch (e) { denied.push(e.message); }
    return { denied, rows: await ctx.adminQuery.list("notes") };
  `,
    { context: readonly },
  );
  expect(result).toEqual({
    denied: Array(11).fill("PluginPreviewReadOnly"),
    rows: [{ body: "host result" }],
  });
});

describe("ctx.consentPurposes through the broker (consent_provider)", () => {
  const HOST_LIST = [
    {
      pluginSlug: "ratings",
      key: "visitor_id",
      category: "functional",
      purpose: "One rating per visitor and page.",
      cookies: [{ name: "__session", lifetime: "30 days", purpose: "Remembers it." }],
    },
  ];
  const granted = {
    ...context,
    consentPurposes: { list: async () => HOST_LIST },
  } as PluginContext;

  it("is absent without the grant, so no call reaches the host", async () => {
    expect(await invoke("return typeof ctx.consentPurposes;")).toBe("undefined");
  });

  it("returns the host's list to a granted plugin", async () => {
    expect(await invoke("return await ctx.consentPurposes.list();", { context: granted })).toEqual(
      HOST_LIST,
    );
  });

  it("refuses arguments a plugin could use to spoof another plugin's declarations", async () => {
    const result = await invoke(
      `
      const refused = [];
      for (const args of [
        [[{ pluginSlug: "ratings", key: "visitor_id", category: "marketing", purpose: "x", cookies: [] }]],
        [{ pluginSlug: "comments" }],
      ]) {
        try { await ctx.consentPurposes.list(...args); } catch (e) { refused.push(e.message); }
      }
      // Changing the copy the child received changes nothing host-side.
      const first = await ctx.consentPurposes.list();
      first[0].category = "marketing";
      first.push({ pluginSlug: "auth", key: "tracking" });
      return { refused, after: await ctx.consentPurposes.list() };
    `,
      { context: granted },
    );
    expect(result).toEqual({
      refused: ["SandboxArgumentsInvalid", "SandboxArgumentsInvalid"],
      after: HOST_LIST,
    });
  });
});

describe("why a child exited", () => {
  it("keeps the first 2 KB of stderr and reads the rest to the end", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024).fill(120);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled++ >= 10_000) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const head = await streamHead(stream, 2048);
    expect(head.byteLength).toBe(2048);
    expect(pulled).toBe(10_001);
  });

  it("names the first line, without control characters, at most 300 characters", () => {
    const enc = new TextEncoder();
    expect(exitReason(enc.encode("\n\nerror: Uncaught Error: boom\u0007\n    at x\n"))).toBe(
      "error: Uncaught Error: boom",
    );
    expect(exitReason(enc.encode(`error: ${"y".repeat(1000)}`))).toHaveLength(300);
    expect(exitReason(new Uint8Array())).toBe("");
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * Collecting client assets from real, loaded plugins: reviewed files, build
 * data and CSP sources (#449, #1729).
 *
 * The channel exists so a plugin can guarantee browser behaviour the
 * site's markup cannot be trusted to provide (#449). That guarantee is
 * only worth something if the failure modes are loud: a plugin whose
 * runtime silently stops shipping is the exact defect this pass must
 * never produce. So the invalid cases below assert a THROW, not a
 * degraded build.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import {
  bootstrap,
  collectBuildAssets,
  injectPluginAssets,
  MAIN_RENDER,
  type PluginHostInfra,
  resetPluginHost,
  setPluginDisabled,
} from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "test-assets-runtime";

let adapter: DatabaseAdapter;
let infra: PluginHostInfra;

async function wipe(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (
          SELECT id FROM plugins WHERE slug LIKE 'test-assets-%'
        )
      )`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 'test-assets-%')`;
      await tx`DELETE FROM plugins WHERE slug LIKE 'test-assets-%'`;
    });
  } finally {
    await sql.end();
  }
}

/**
 * A fixture plugin with reviewed client files and, when `data` is given,
 * a build-data operation answering it (#1729).
 */
function fixture(
  files: Record<string, string>,
  opts: {
    readonly data?: () => unknown;
    readonly origins?: Record<string, string[]>;
    readonly capabilities?: ReadonlyArray<"client_assets">;
  } = {},
) {
  return definePlugin({
    slug: SLUG,
    version: "0.1.0",
    tier: 1,
    schema: {},
    requestedCapabilities: [...(opts.capabilities ?? ["client_assets"])],
    ...(opts.origins
      ? { capabilityConstraints: { client_assets: { origins: opts.origins } } }
      : {}),
    clientFiles: files,
    ...(opts.data ? { buildDataOperation: "build_data" } : {}),
    operations: {
      noop: async () => ({}),
      ...(opts.data ? { build_data: async () => opts.data?.() } : {}),
    },
  });
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry };
});

afterEach(async () => {
  await wipe();
});

afterAll(async () => {
  await adapter.close();
});

async function load(definition: ReturnType<typeof definePlugin>): Promise<void> {
  const reason = await refusal(definition);
  if (reason !== null) throw new Error(`fixture failed to load: ${reason}`);
}

/** The reason a fixture is refused at load, or null when it loads. */
async function refusal(definition: ReturnType<typeof definePlugin>): Promise<string | null> {
  const report = await bootstrap({
    infra,
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition }],
  });
  return report.failed[0]?.reason ?? null;
}

describe("collectBuildAssets", () => {
  it("emits the plugin's reviewed files with the content hash in the name", async () => {
    await load(fixture({ "runtime.js": "/* reviewed */", "runtime.css": ".c{}" }));
    const assets = await collectBuildAssets(MAIN_RENDER);

    expect(assets).toHaveLength(2);
    const js = assets.find((a) => a.kind === "js");
    expect(js?.content).toBe("/* reviewed */");
    expect(js?.relPath).toMatch(new RegExp(`^_caelo/plugin/${SLUG}/runtime\\.[0-9a-f]{12}\\.js$`));
    expect(js?.publicPath).toBe(`/${js?.relPath}`);
  });

  it("hands the grant's origins to the build as CSP data, and no page links it (#1454)", async () => {
    await load(
      fixture({ "runtime.js": "x" }, { origins: { connect: ["https://api.example.com"] } }),
    );
    const assets = await collectBuildAssets(MAIN_RENDER);
    const csp = assets.find((a) => a.kind === "csp");
    expect(JSON.parse(csp?.content ?? "{}")).toEqual({
      origins: { connect: ["https://api.example.com"] },
    });
    expect(csp?.relPath).toBe("");
    const html = injectPluginAssets("<head></head><body></body>", assets, "linked");
    expect(html).not.toContain("api.example.com");
  });

  it("embeds the build data as a data block before the scripts that read it", async () => {
    await load(fixture({ "runtime.js": "x" }, { data: () => ({ data: { greeting: "hi" } }) }));
    const assets = await collectBuildAssets(MAIN_RENDER);
    expect(assets.map((a) => a.kind)).toEqual(["js", "data"]);
    const html = injectPluginAssets("<head></head><body></body>", assets, "linked");
    const block = `<script type="application/json" data-caelo-plugin-data="${SLUG}">{"greeting":"hi"}</script>`;
    expect(html).toContain(block);
    expect(html.indexOf(block)).toBeLessThan(html.indexOf("<script defer src="));
  });

  // #1729 adversarial — data that tries to become code or markup.
  it("keeps a </script> in the data from ending its block", async () => {
    await load(
      fixture(
        { "runtime.js": "x" },
        { data: () => ({ data: { note: "</script><script>steal()</script><!--" } }) },
      ),
    );
    const html = injectPluginAssets(
      "<head></head><body></body>",
      await collectBuildAssets(MAIN_RENDER),
      "linked",
    );
    expect(html).not.toContain("</script><script>steal()");
    expect(html).not.toContain("<!--");
    const block = /data-caelo-plugin-data="[^"]+">([^<]*)<\/script>/.exec(html)?.[1] ?? "";
    expect(JSON.parse(block)).toEqual({ note: "</script><script>steal()</script><!--" });
  });

  it.each([
    ["__proto__", '{"data":{"__proto__":{"isAdmin":true}}}'],
    ["constructor", '{"data":{"a":{"constructor":{"prototype":{"x":1}}}}}'],
    ["prototype", '{"data":{"list":[{"prototype":1}]}}'],
  ])("refuses a %s key anywhere in the data", async (key, answer) => {
    // Parsed the way the sandbox wire parses it: `__proto__` becomes an own key.
    await load(fixture({ "runtime.js": "x" }, { data: () => JSON.parse(answer) }));
    expect(collectBuildAssets(MAIN_RENDER)).rejects.toThrow(new RegExp(`the key "${key}"`));
  });

  it("refuses a file the build hands over: only reviewed files reach a page", async () => {
    await load(
      fixture(
        { "runtime.js": "x" },
        { data: () => ({ data: {}, files: { "evil.js": "steal()" } }) },
      ),
    );
    expect(collectBuildAssets(MAIN_RENDER)).rejects.toThrow(/expected \{ data: object, csp\? \}/);
  });

  it("refuses data that is not plain JSON", async () => {
    await load(fixture({ "runtime.js": "x" }, { data: () => ({ data: { at: new Date(0) } }) }));
    expect(collectBuildAssets(MAIN_RENDER)).rejects.toThrow(/data\.at: not a plain object/);
  });

  it("refuses data over the 64 KB every page carries", async () => {
    await load(
      fixture({ "runtime.js": "x" }, { data: () => ({ data: { blob: "x".repeat(70 * 1024) } }) }),
    );
    expect(collectBuildAssets(MAIN_RENDER)).rejects.toThrow(/over the 65536 every page can carry/);
  });

  it("refuses CSP sources per build from a plugin that is not the consent provider", async () => {
    await load(
      fixture(
        { "runtime.js": "x" },
        { data: () => ({ data: {}, csp: { origins: { connect: ["https://evil.example"] } } }) },
      ),
    );
    expect(collectBuildAssets(MAIN_RENDER)).rejects.toThrow(/only the site's consent provider/);
  });

  it("fails the build when the plugin's build data throws", async () => {
    await load(
      fixture(
        { "runtime.js": "x" },
        {
          data: () => {
            throw new Error("config table missing");
          },
        },
      ),
    );
    expect(collectBuildAssets(MAIN_RENDER)).rejects.toThrow(/config table missing/);
  });

  it("lets the pages connect to the stream origin of a visitor conversation (#1654)", async () => {
    const chat = definePlugin({
      slug: `${SLUG}-chat`,
      version: "0.1.0",
      tier: 1,
      schema: {},
      requestedCapabilities: ["collections", "visitor_ai"],
      requires: ["visitor-ai"],
      collections: {
        pages: {
          description: "Pages.",
          fields: { title: { kind: "text" }, url: { kind: "keyword" } },
          maxDocuments: 10,
          maxDocumentBytes: 1024,
        },
      },
      config: {
        tone: {
          type: "string",
          label: "Tone",
          description: "How it answers.",
          effect: "query",
          maxLength: 200,
          default: "kurz",
          visitorVisible: true,
        },
      },
      collectionOperations: [
        {
          name: "search",
          kind: "search",
          collection: "pages",
          description: "Search.",
          returns: ["url"],
        },
      ],
      aiChatOperations: [
        {
          name: "ask",
          kind: "ai-chat",
          description: "Answer visitors.",
          prompt: { fields: ["tone"] },
          tools: [{ plugin: `${SLUG}-chat`, operation: "search" }],
        },
      ],
      operations: { noop: async () => ({}) },
    });
    await load(chat);
    const before = process.env.CAELO_VISITOR_AI_STREAM_ORIGIN;
    try {
      // The site's own origin streams (gcp, self-hosted): nothing to add.
      process.env.CAELO_VISITOR_AI_STREAM_ORIGIN = "";
      expect(await collectBuildAssets(MAIN_RENDER)).toEqual([]);
      // Buffered there (gcp-firebase): the gateway's own origin, for the CSP only.
      process.env.CAELO_VISITOR_AI_STREAM_ORIGIN = "https://gw-123.europe-west1.run.app";
      const assets = await collectBuildAssets(MAIN_RENDER);
      expect(assets).toEqual([
        {
          pluginSlug: `${SLUG}-chat`,
          fileName: "csp-sources.json",
          kind: "csp",
          content: '{"origins":{"connect":["https://gw-123.europe-west1.run.app"]}}',
          relPath: "",
          publicPath: "",
        },
      ]);
    } finally {
      if (before === undefined) delete process.env.CAELO_VISITOR_AI_STREAM_ORIGIN;
      else process.env.CAELO_VISITOR_AI_STREAM_ORIGIN = before;
    }
  });

  it("gives identical content the same name and changed content a new one", async () => {
    // The name is what a CDN caches against; if it did not move when the
    // behaviour moved, a deploy would leave stale plugin code live.
    await load(fixture({ "runtime.js": "v1" }));
    const first = (await collectBuildAssets(MAIN_RENDER))[0]?.relPath;
    const again = (await collectBuildAssets(MAIN_RENDER))[0]?.relPath;
    expect(again).toBe(first);

    await wipe();
    await load(fixture({ "runtime.js": "v2" }));
    expect((await collectBuildAssets(MAIN_RENDER))[0]?.relPath).not.toBe(first);
  });

  it("emits nothing for a plugin that is switched off", async () => {
    await load(fixture({ "runtime.js": "x" }));
    setPluginDisabled(SLUG, true);
    expect(await collectBuildAssets(MAIN_RENDER)).toEqual([]);
    setPluginDisabled(SLUG, false);
    expect(await collectBuildAssets(MAIN_RENDER)).toHaveLength(1);
  });

  it("costs nothing when no plugin contributes", async () => {
    await load(
      definePlugin({
        slug: SLUG,
        version: "0.1.0",
        tier: 1,
        schema: {},
        operations: { noop: async () => ({}) },
      }),
    );
    expect(await collectBuildAssets(MAIN_RENDER)).toEqual([]);
  });
});

// #1729 — the review rules bind a shipped plugin at every load (one plugin model).
describe("client files are reviewed at load, for every plugin", () => {
  it("refuses a file name that is not a plain .js or .css", async () => {
    expect(await refusal(fixture({ "../escape.js": "x" }))).toMatch(/manifest/);
  });

  it("refuses files over the per-plugin budget", async () => {
    expect(await refusal(fixture({ "runtime.js": `// ${"x".repeat(600 * 1024)}` }))).toMatch(
      /manifest/,
    );
  });

  it("refuses client files without the client_assets grant", async () => {
    expect(await refusal(fixture({ "runtime.js": "x" }, { capabilities: [] }))).toMatch(
      /manifest-cap-missing/,
    );
  });

  it.each([
    ["a fetch to another site", 'fetch("https://collector.example/x")'],
    ["eval", "eval(location.hash.slice(1))"],
    ["a markup sink", 'document.body.innerHTML = "<b>x</b>"'],
    ["a dynamic import", 'import("/x.js")'],
  ])("refuses a client script with %s", async (_what, code) => {
    expect(await refusal(fixture({ "runtime.js": code }))).toMatch(/client-assets/);
  });

  it("allows a third-party origin the grant names", async () => {
    expect(
      await refusal(
        fixture(
          { "runtime.js": 'fetch("https://api.example.com/x")' },
          { origins: { connect: ["https://api.example.com"] } },
        ),
      ),
    ).toBeNull();
  });

  it("refuses CSS that loads a third-party URL", async () => {
    expect(
      await refusal(fixture({ "runtime.css": "@import url(https://fonts.example/a.css);" })),
    ).toMatch(/client-assets/);
    await wipe();
    expect(
      await refusal(fixture({ "runtime.css": ".a{background:url(https://t.example/p.gif)}" })),
    ).toMatch(/client-assets/);
  });
});

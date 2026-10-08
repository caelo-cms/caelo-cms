// SPDX-License-Identifier: MPL-2.0

/**
 * #592 — the content-variants composition point against the real host:
 * no contributor = no plugin call; answers are validated and returned
 * per placement; and every loud branch (module swap on a page placement,
 * an answer for a placement outside the pass, an ill-formed answer, two
 * plugins resolving one placement) throws instead of rendering something.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { type ContentVariantPage, definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import {
  bootstrap,
  hasContentVariantContributors,
  MAIN_RENDER,
  type PluginHostInfra,
  resetPluginHost,
  resolveContentVariants,
} from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const PAGE = "00000000-0000-4000-8000-00000000b592";
const MODULE = "00000000-0000-4000-8000-00000000c592";

let adapter: DatabaseAdapter;
let infra: PluginHostInfra;

const pages: ContentVariantPage[] = [
  {
    pageId: PAGE,
    placements: [
      {
        key: "layout:footer:0",
        scope: "layout",
        layoutId: "00000000-0000-4000-8000-00000000d592",
        blockName: "footer",
        position: 0,
        moduleId: MODULE,
        moduleName: "Footer",
        contentInstanceId: null,
        shared: true,
        fields: [{ name: "tagline", kind: "text" }],
        values: { tagline: "Made with care" },
      },
      {
        key: "page:content:0",
        scope: "page",
        layoutId: null,
        blockName: "content",
        position: 0,
        moduleId: MODULE,
        moduleName: "CTA",
        contentInstanceId: "00000000-0000-4000-8000-00000000e592",
        shared: true,
        fields: [{ name: "label", kind: "text" }],
        values: { label: "Talk to us" },
      },
    ],
  },
];

function resolver(slug: string, resolutions: Record<string, Record<string, unknown>>) {
  return definePlugin({
    slug,
    version: "0.1.0",
    tier: 1,
    schema: {},
    requestedCapabilities: ["content_variants"],
    contentVariantsOperation: "resolve",
    operations: { resolve: async () => ({ resolutions }) },
  });
}

async function boot(...defs: ReturnType<typeof resolver>[]): Promise<void> {
  const report = await bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: defs.map((definition) => ({ definition })),
  });
  expect(report.failed).toEqual([]);
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't592-%')
      )`);
      await tx.unsafe(
        "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't592-%')",
      );
      await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't592-%'");
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry };
  await cleanup();
});

afterEach(cleanup);

afterAll(async () => {
  await adapter.close();
});

describe("#592 — content-variants composition point", () => {
  it("without a contributor nothing is resolved", async () => {
    await boot();
    expect(hasContentVariantContributors()).toBe(false);
    expect((await resolveContentVariants(pages, MAIN_RENDER, "directory")).size).toBe(0);
  });

  it("returns validated answers per placement, problems included", async () => {
    const swap = "00000000-0000-4000-8000-00000000f592";
    await boot(
      resolver("t592-ok", {
        [PAGE]: {
          "layout:footer:0": { moduleId: swap, values: { tagline: "Mit Sorgfalt" } },
          "page:content:0": { problems: ["no German version yet"] },
        },
      }),
    );
    const r = (await resolveContentVariants(pages, MAIN_RENDER, "directory")).get(PAGE);
    expect(r?.get("layout:footer:0")).toEqual({
      pluginSlug: "t592-ok",
      moduleId: swap,
      values: { tagline: "Mit Sorgfalt" },
      problems: [],
    });
    expect(r?.get("page:content:0")?.problems).toEqual(["no German version yet"]);
  });

  it("refuses a module swap on a page placement", async () => {
    await boot(
      resolver("t592-swap", {
        [PAGE]: { "page:content:0": { moduleId: "00000000-0000-4000-8000-00000000f592" } },
      }),
    );
    await expect(resolveContentVariants(pages, MAIN_RENDER, "directory")).rejects.toThrow(
      /only layout placements may render a different module/,
    );
  });

  it("refuses answers outside the pass and ill-formed answers", async () => {
    await boot(resolver("t592-stray", { [PAGE]: { "layout:header:0": { values: {} } } }));
    await expect(resolveContentVariants(pages, MAIN_RENDER, "directory")).rejects.toThrow(
      /not part of this render pass/,
    );
    await cleanup();
    await boot(resolver("t592-bad", { [PAGE]: { "layout:footer:0": { values: "x" } } }));
    await expect(resolveContentVariants(pages, MAIN_RENDER, "directory")).rejects.toThrow(
      /invalid resolution/,
    );
  });

  it("refuses two plugins resolving the same placement", async () => {
    const answer = { [PAGE]: { "layout:footer:0": { values: {} } } };
    await boot(resolver("t592-a", answer), resolver("t592-b", answer));
    await expect(resolveContentVariants(pages, MAIN_RENDER, "directory")).rejects.toThrow(
      /resolved by both/,
    );
  });
});

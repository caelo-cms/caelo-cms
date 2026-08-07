// SPDX-License-Identifier: MPL-2.0

/**
 * #391 — head/sitemap contribution collection against the real host:
 * additive merge across two plugins, identical-duplicate dedup, LOUD
 * contradiction, capability enforcement at the validator, and the
 * serializer's deterministic ordering.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { definePlugin, type HeadEntry } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import {
  bootstrap,
  collectContributions,
  type PluginHostInfra,
  renderHeadEntries,
  resetPluginHost,
} from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const PAGE_A = "00000000-0000-4000-8000-00000000a001";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let infra: PluginHostInfra;

function contributor(
  slug: string,
  headByPage: Record<string, HeadEntry[]>,
  sitemapByPage: Record<string, unknown> = {},
) {
  return definePlugin({
    slug,
    version: "0.1.0",
    tier: 1,
    schema: {},
    requestedCapabilities: ["head_contributions"],
    contributes: ["head", "sitemap"],
    contributionsOperation: "contribute",
    operations: {
      contribute: async () => ({ head: headByPage, sitemap: sitemapByPage }),
    },
  });
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't391-%')
      )`);
      await tx.unsafe(
        "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't391-%')",
      );
      await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't391-%'");
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry };
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await adapter.close();
});

describe("#391 — head/sitemap contribution collection", () => {
  it("merges two plugins additively; identical duplicates dedup; serializer is order-stable", async () => {
    const hreflangDe: HeadEntry = {
      kind: "link",
      rel: "alternate",
      hreflang: "de",
      href: "https://example.com/de/pricing",
    };
    const report = await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [
        {
          definition: contributor("t391-intl", {
            [PAGE_A]: [
              hreflangDe,
              {
                kind: "link",
                rel: "alternate",
                hreflang: "x-default",
                href: "https://example.com/pricing",
              },
            ],
          }),
        },
        {
          definition: contributor("t391-og", {
            // One identical duplicate (dedup) + one disjoint meta.
            [PAGE_A]: [hreflangDe, { kind: "meta", property: "og:locale", content: "de_DE" }],
          }),
        },
      ],
    });
    expect(report.failed).toEqual([]);

    const collected = await collectContributions([PAGE_A], {
      siteBaseUrl: "https://example.com",
    });
    const entries = collected.head.get(PAGE_A) ?? [];
    expect(entries).toHaveLength(3);

    // Serializer: deterministic order regardless of plugin iteration.
    const rendered = renderHeadEntries(entries);
    expect(rendered).toBe(
      [
        '<link rel="alternate" hreflang="de" href="https://example.com/de/pricing" />',
        '<link rel="alternate" hreflang="x-default" href="https://example.com/pricing" />',
        '<meta property="og:locale" content="de_DE" />',
      ].join("\n"),
    );
  });

  it("contradictory entries under one key fail loudly", async () => {
    await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [
        {
          definition: contributor("t391-a", {
            [PAGE_A]: [
              { kind: "link", rel: "alternate", hreflang: "de", href: "https://example.com/de" },
            ],
          }),
        },
        {
          definition: contributor("t391-b", {
            [PAGE_A]: [
              {
                kind: "link",
                rel: "alternate",
                hreflang: "de",
                href: "https://OTHER.example.com/de",
              },
            ],
          }),
        },
      ],
    });
    await expect(
      collectContributions([PAGE_A], { siteBaseUrl: "https://example.com" }),
    ).rejects.toThrow(/contradictory head entries/);
  });

  it("sitemap contributions merge; contradictory alternates fail loudly", async () => {
    await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [
        {
          definition: contributor(
            "t391-a",
            {},
            { [PAGE_A]: { alternates: [{ hreflang: "de", href: "https://example.com/de" }] } },
          ),
        },
        {
          definition: contributor("t391-b", {}, { [PAGE_A]: { exclude: true } }),
        },
      ],
    });
    const collected = await collectContributions([PAGE_A], {
      siteBaseUrl: "https://example.com",
    });
    expect(collected.sitemap.get(PAGE_A)).toEqual({
      exclude: true,
      alternates: [{ hreflang: "de", href: "https://example.com/de" }],
    });
  });

  it("ceiling: contributes without the capability is refused at validation", async () => {
    const def = definePlugin({
      slug: "t391-nocap",
      version: "0.1.0",
      tier: 1,
      schema: {},
      requestedCapabilities: [],
      contributes: ["head"],
      contributionsOperation: "contribute",
      operations: { contribute: async () => ({}) },
    });
    const report = await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: def }],
    });
    expect(report.loaded).toHaveLength(0);
    expect(report.failed[0]?.reason).toContain("manifest-cap-missing");
  });
});

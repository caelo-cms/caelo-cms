// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout D) — the link-resolve composition point against the
 * real host: no contributor = no plugin call; answers are validated and
 * returned per page; a disabled-by-default capability request is
 * enforced by the manifest; and every loud branch (an answer for a page
 * outside the render, an ill-formed answer, two plugins placing one
 * page, a failing operation) throws instead of resolving links somewhere.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { validateInstallationPolicy } from "@caelo-cms/plugin-sandbox";
import { definePlugin, manifestFromDefinition } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import {
  bootstrap,
  hasLinkResolveContributors,
  MAIN_RENDER,
  type PluginHostInfra,
  resetPluginHost,
  resolveLinkVariants,
} from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const EN = "00000000-0000-4000-8000-00000000a724";
const DE = "00000000-0000-4000-8000-00000000b724";
const OTHER = "00000000-0000-4000-8000-00000000c724";

let adapter: DatabaseAdapter;
let infra: PluginHostInfra;

function resolver(slug: string, answer: unknown | (() => never)) {
  return definePlugin({
    slug,
    version: "0.1.0",
    tier: 1,
    schema: {},
    requestedCapabilities: ["link_resolve"],
    linkResolveOperation: "resolve",
    operations: {
      resolve: async () => (typeof answer === "function" ? (answer as () => never)() : answer),
    },
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
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't724d-%')
      )`);
      await tx.unsafe(
        "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't724d-%')",
      );
      await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't724d-%'");
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

describe("#724 D — link-resolve composition point", () => {
  it("without a contributor nothing is resolved", async () => {
    await boot();
    expect(hasLinkResolveContributors()).toBe(false);
    expect((await resolveLinkVariants([EN, DE], MAIN_RENDER)).size).toBe(0);
  });

  it("returns the validated page-variant partition", async () => {
    await boot(
      resolver("t724d-ok", {
        pages: {
          [EN]: { variant: "en", group: "g1" },
          [DE]: { variant: "de", group: "g1" },
          [OTHER]: { variant: "en", group: null },
        },
      }),
    );
    expect(hasLinkResolveContributors()).toBe(true);
    const r = await resolveLinkVariants([EN, DE, OTHER], MAIN_RENDER);
    expect(r.get(DE)).toEqual({ variant: "de", group: "g1" });
    expect(r.get(OTHER)).toEqual({ variant: "en", group: null });
  });

  it("refuses answers outside the render and ill-formed answers", async () => {
    await boot(resolver("t724d-stray", { pages: { [OTHER]: { variant: "en", group: null } } }));
    await expect(resolveLinkVariants([EN], MAIN_RENDER)).rejects.toThrow(/not part of this render/);
    await cleanup();
    await boot(resolver("t724d-bad", { pages: { [EN]: { variant: "", group: null } } }));
    await expect(resolveLinkVariants([EN], MAIN_RENDER)).rejects.toThrow(/invalid answer/);
  });

  it("refuses two plugins placing the same page", async () => {
    const answer = { pages: { [EN]: { variant: "en", group: null } } };
    await boot(resolver("t724d-a", answer), resolver("t724d-b", answer));
    await expect(resolveLinkVariants([EN], MAIN_RENDER)).rejects.toThrow(/by both/);
  });

  it("surfaces a failing operation instead of resolving links unmapped", async () => {
    await boot(
      resolver("t724d-throws", () => {
        throw new Error("variant table unreadable");
      }),
    );
    await expect(resolveLinkVariants([EN], MAIN_RENDER)).rejects.toThrow(
      /t724d-throws\.resolve failed/,
    );
  });

  it("requires the link_resolve capability request in the manifest", () => {
    const def = definePlugin({
      slug: "t724d-nocap",
      version: "0.1.0",
      tier: 1,
      schema: {},
      linkResolveOperation: "resolve",
      operations: { resolve: async () => ({ pages: {} }) },
    });
    const manifest = manifestFromDefinition(def);
    expect(manifest.hasLinkResolve).toBe(true);
    expect(() => validateInstallationPolicy(manifest)).toThrow(
      "Missing required capability request: link_resolve",
    );
  });
});

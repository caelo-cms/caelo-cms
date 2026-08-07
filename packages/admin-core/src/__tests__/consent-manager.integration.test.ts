// SPDX-License-Identifier: MPL-2.0

/**
 * #451 — the consent-manager plugin on the real engine.
 *
 * The load-bearing assertion is the split the whole plugin is built
 * around: the plugin supplies BEHAVIOUR and DATA, the AI supplies every
 * visible thing. So the tests check that the categories reach a module
 * as a data list, that the runtime ships with them baked in, and that a
 * visitor's decision lands server-side — and never that the plugin
 * emitted any markup, because it must not.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import consentPlugin from "@caelo-cms/plugin-consent-manager";
import {
  bootstrap,
  collectBuildAssets,
  resetPluginHost,
  resolveDataLists,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t451",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";
let pluginId = "";

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_consent_manager" CASCADE');
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'consent-manager')
    )`);
    await tx.unsafe(
      "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'consent-manager')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'consent-manager'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't451-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't451-%'");
  });
  const pub = new SQL(PUBLIC_URL);
  try {
    await pub.unsafe('DROP SCHEMA IF EXISTS "plugin_consent_manager" CASCADE');
  } finally {
    await pub.end();
  }
}

async function call(operationName: string, args: unknown = {}) {
  return runPluginOperation({ pluginSlug: "consent-manager", operationName, args });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();

  const tpl = await execute(registry, adapter, SYS_CTX, "templates.create", {
    slug: "t451-tpl",
    displayName: "T451",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(JSON.stringify(tpl.error));
  const page = await execute(registry, adapter, SYS_CTX, "pages.create", {
    slug: "t451-page",
    title: "Consent",
    templateId: (tpl.value as { templateId: string }).templateId,
  });
  if (!page.ok) throw new Error(JSON.stringify(page.error));
  pageId = (page.value as { pageId: string }).pageId;

  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: consentPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  pluginId = await sqlSystem(async (tx) => {
    const rows = (await tx.unsafe(
      `SELECT id::text AS id FROM plugins WHERE slug = 'consent-manager'`,
    )) as { id: string }[];
    const id = rows[0]?.id;
    if (!id) throw new Error("no plugin row");
    return id;
  });
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("#451 — consent-manager", () => {
  it("seeds the four categories and answers with the banner contract", async () => {
    const r = await call("consent_status");
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const v = r.value as {
      policyVersion: number;
      categories: Array<{ key: string; required: boolean }>;
      bannerContract: { hooks: string[] };
    };
    expect(v.policyVersion).toBe(1);
    expect(v.categories.map((c) => c.key)).toEqual([
      "necessary",
      "functional",
      "analytics",
      "marketing",
    ]);
    // Exactly one may run before the visitor answers.
    expect(v.categories.filter((c) => c.required).map((c) => c.key)).toEqual(["necessary"]);
    // The contract has to reach the AI, or it authors a banner the
    // runtime cannot bind to.
    expect(v.bannerContract.hooks.join(" ")).toContain("data-consent-accept-all");
  });

  it("offers the categories to a module as a data list, not as markup", async () => {
    const lists = await resolveDataLists([pageId]);
    const items = lists.get(pageId)?.consent_categories;
    expect(items).toBeDefined();
    expect(items?.map((i) => i.key)).toEqual(["necessary", "functional", "analytics", "marketing"]);
    // Every key the banner template needs, and nothing that looks like
    // HTML — the plugin never supplies markup.
    expect(Object.keys(items?.[0] ?? {}).sort()).toEqual([
      "description",
      "key",
      "label",
      "required",
    ]);
    expect(JSON.stringify(items)).not.toContain("<");
  });

  it("bakes the categories and the policy version into the runtime", async () => {
    const assets = await collectBuildAssets([pageId]);
    const js = assets.find((a) => a.fileName === "runtime.js");
    const css = assets.find((a) => a.fileName === "runtime.css");
    expect(js).toBeDefined();
    expect(css).toBeDefined();
    // Baked, not fetched: the runtime must decide before anything loads.
    expect(js?.content).toContain('"key":"analytics"');
    expect(js?.content).toContain('"policyVersion":1');
    expect(js?.content).toContain("/api/plugin/consent-manager/record_consent");
    // Hidden before first paint, revealed by the runtime — the other
    // way round flashes the banner for everyone who already answered.
    expect(css?.content).toContain("[data-consent-banner]{display:none}");
  });

  it("records a visitor's decision", async () => {
    const r = await call("record_consent", {
      granted: ["necessary", "analytics"],
      policyVersion: 1,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    // Read the way the plugin does. The table is FORCE-RLS'd and scoped
    // to caelo.plugin_id, so a plain SELECT legitimately sees nothing —
    // which is the isolation working, not a missing row.
    const pub = new SQL(PUBLIC_URL);
    try {
      const rows = await pub.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'plugin'");
        await tx.unsafe(`SET LOCAL caelo.plugin_id = '${pluginId}'`);
        return (await tx.unsafe(
          `SELECT granted::text AS granted, policy_version FROM "plugin_consent_manager"."consent_log"`,
        )) as { granted: string; policy_version: number }[];
      });
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.granted ?? "[]")).toEqual(["necessary", "analytics"]);
      expect(rows[0]?.policy_version).toBe(1);
    } finally {
      await pub.end();
    }
  });

  it("rejects a malformed decision instead of storing a half-record", async () => {
    // A consent row is evidence; one with the wrong shape is worse than
    // none, because it looks like proof.
    const r = await call("record_consent", { granted: "everything", policyVersion: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("array of category keys");
  });

  it("rewords a category but refuses to invent one", async () => {
    const ok = await call("describe_categories", {
      categories: [{ key: "analytics", displayName: "Statistik" }],
    });
    if (!ok.ok) throw new Error(JSON.stringify(ok.error));
    expect((ok.value as { updated: number }).updated).toBe(1);

    const status = await call("consent_status");
    if (!status.ok) throw new Error(JSON.stringify(status.error));
    const cats = (status.value as { categories: Array<{ key: string; displayName: string }> })
      .categories;
    expect(cats.find((c) => c.key === "analytics")?.displayName).toBe("Statistik");

    // Keys are what tags and withheld modules refer to, so a new one
    // cannot appear by way of a rename.
    const bad = await call("describe_categories", {
      categories: [{ key: "social", displayName: "Social" }],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain("keys are fixed");
  });

  it("re-asks everyone when the policy version is bumped", async () => {
    const before = await collectBuildAssets([pageId]);
    const r = await call("bump_policy_version");
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect((r.value as { policyVersion: number }).policyVersion).toBe(2);

    const after = await collectBuildAssets([pageId]);
    const js = after.find((a) => a.fileName === "runtime.js");
    expect(js?.content).toContain('"policyVersion":2');
    // A changed runtime must change its hashed filename, or caches keep
    // serving the version that stops asking.
    expect(js?.relPath).not.toBe(before.find((a) => a.fileName === "runtime.js")?.relPath);
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * #393 — lifecycle completion, end to end: disable survives a re-boot,
 * plugins.activate re-enables a release-signed plugin without restart,
 * manifest-shipped skills go live with the plugin (the Owner decision
 * sticks across boots), and the gated uninstall archives skills, moves
 * URLs back with redirects, drops the schemas, and removes the row.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  loadActivatedPlugin,
  loadedPlugins,
  pluginToolsRegistry,
  resetPluginHost,
  urlContributionsRegistry,
} from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { configurePluginUninstallFinalizer } from "../ops/plugins/uninstall.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t393",
};
// plugins.activate / execute_proposal are human+system; use a human ctx
// backed by the system actor row for the approval steps.
const HUMAN_CTX: ExecutionContext = { ...SYS_CTX, actorKind: "human" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const localeByPage = new Map<string, string>();
const droppedSchemas: string[] = [];

const lifecyclePlugin = definePlugin({
  slug: "t393-life",
  version: "0.1.0",
  tier: 1,
  schema: {},
  adminSchema: { notes: { body: "text" } },
  requestedCapabilities: ["cms_admin_schema", "chat_runner_tools"],
  operations: {
    noop: async () => ({}),
    url_annotations: async (_ctx, args) => {
      const { pageIds } = args as { pageIds: string[] };
      const annotations: Record<string, Record<string, unknown>> = {};
      for (const id of pageIds) annotations[id] = { locale: localeByPage.get(id) ?? "en" };
      return { annotations };
    },
  },
  tools: [
    {
      name: "t393_noop",
      description: "noop tool",
      operationName: "noop",
      inputJsonSchema: {},
    },
  ],
  skills: [
    {
      slug: "t393-skill",
      displayName: "T393 Skill",
      description: "lifecycle test skill",
      body: "Do the t393 thing.",
    },
  ],
  urlAnnotationsOperation: "url_annotations",
  urlContributions: [
    {
      slot: "path-prefix",
      encode: (page) => {
        const locale = page.annotations.locale;
        return typeof locale === "string" && locale !== "en" ? [locale] : [];
      },
      decode: (segments) =>
        segments[0] === "de" ? { consumed: 1, annotations: { locale: "de" } } : null,
    },
  ],
});

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

async function bootHost(): Promise<{ loaded: unknown[]; failed: { reason: string }[] }> {
  resetPluginHost();
  return bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: lifecyclePlugin }],
  }) as Promise<{ loaded: unknown[]; failed: { reason: string }[] }>;
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  localeByPage.clear();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_t393_life" CASCADE');
    await tx.unsafe("DELETE FROM plugin_pending_actions");
    await tx.unsafe("DELETE FROM skills WHERE slug LIKE 't393-%'");
    await tx.unsafe("DELETE FROM redirects WHERE from_path LIKE '/t393-%'");
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't393-%')
    )`);
    await tx.unsafe(
      "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't393-%')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't393-%'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't393-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't393-%'");
    await tx.unsafe("DELETE FROM layouts WHERE slug LIKE 't393-%'");
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  configurePluginUninstallFinalizer({
    dropPublicSchema: async (schemaName) => {
      droppedSchemas.push(`public:${schemaName}`);
      await adapter.dropPluginPublicSchema({ schemaName });
    },
    dropAdminSchema: async (schemaName) => {
      droppedSchemas.push(`admin:${schemaName}`);
      await adapter.dropPluginAdminSchema({ schemaName });
    },
  });
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("#393 — lifecycle completion", () => {
  it("disable persists across boots; activate re-enables without restart; skills ship + Owner decision sticks", async () => {
    const first = await bootHost();
    expect(first.failed).toEqual([]);

    // The manifest skill is live with the plugin, owned by it, stamped.
    const skillRows = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(
          `SELECT status, activated_at, plugin_id::text AS plugin_id FROM skills WHERE slug = 't393-skill'`,
        )) as { status: string; activated_at: string | Date | null; plugin_id: string | null }[],
    );
    expect(skillRows[0]?.status).toBe("active");
    expect(skillRows[0]?.activated_at).not.toBeNull();
    expect(skillRows[0]?.plugin_id).not.toBeNull();

    // Editing an already-active skill must NOT re-stamp activated_at —
    // the stamp drives the new-skill notice, and a reworded body is not
    // news to a chat that already has the skill.
    const stampBefore = String(skillRows[0]?.activated_at);
    const promote = await execute(registry, adapter, HUMAN_CTX, "skills.set", {
      slug: "t393-skill",
      displayName: "T393 Skill",
      description: "lifecycle test skill",
      body: "Do the t393 thing, reworded.",
      status: "active",
    });
    if (!promote.ok) throw new Error(JSON.stringify(promote.error));
    const afterEdit = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(`SELECT activated_at FROM skills WHERE slug = 't393-skill'`)) as {
          activated_at: string | Date | null;
        }[],
    );
    expect(String(afterEdit[0]?.activated_at)).toBe(stampBefore);

    const disabled = await execute(registry, adapter, HUMAN_CTX, "plugins.disable", {
      slug: "t393-life",
    });
    if (!disabled.ok) throw new Error(JSON.stringify(disabled.error));

    const second = await bootHost();
    expect(second.failed).toEqual([]);

    // Boot did NOT resurrect the plugin…
    const status = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(`SELECT status FROM plugins WHERE slug = 't393-life'`)) as {
          status: string;
        }[],
    );
    expect(status[0]?.status).toBe("disabled");
    // …its tools are hidden from the live catalogue…
    expect(pluginToolsRegistry.list().some((t) => t.spec.name === "t393_noop")).toBe(false);
    // …and the skill stayed active (boot upsert never downgrades).
    const skillAfter = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(`SELECT status FROM skills WHERE slug = 't393-skill'`)) as {
          status: string;
        }[],
    );
    expect(skillAfter[0]?.status).toBe("active");

    // Re-enable without a restart. Two steps, exactly as the
    // /security/plugins route does it: the op flips the row, then the
    // host loads the plugin. The load CANNOT run inside the op — the
    // loader opens its own transaction and takes the same row.
    const reenabled = await execute(registry, adapter, HUMAN_CTX, "plugins.activate", {
      slug: "t393-life",
    });
    if (!reenabled.ok) throw new Error(JSON.stringify(reenabled.error));
    // Flipping the row alone does not resurrect anything — the gate is
    // in the loader, so until it runs the plugin is still absent.
    expect(pluginToolsRegistry.list().some((t) => t.spec.name === "t393_noop")).toBe(false);
    const relive = await loadActivatedPlugin("t393-life");
    expect(relive).toEqual({ loaded: true });
    expect(pluginToolsRegistry.list().some((t) => t.spec.name === "t393_noop")).toBe(true);
    const statusAfter = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(`SELECT status FROM plugins WHERE slug = 't393-life'`)) as {
          status: string;
        }[],
    );
    expect(statusAfter[0]?.status).toBe("active");
  });

  it("gated uninstall: archives skills, moves URLs back with redirects, drops schemas, removes the row", async () => {
    droppedSchemas.length = 0;
    await bootHost();

    // A page the URL plugin reshaped to /de/… .
    const templateId = await sqlSystem(async (tx) => {
      const lay = (await tx.unsafe(
        `INSERT INTO layouts (slug, display_name, html, css) VALUES ('t393-lay', 'L', '<html></html>', '') RETURNING id::text AS id`,
      )) as { id: string }[];
      const tpl = (await tx.unsafe(
        `INSERT INTO templates (slug, display_name, kind, html, css, layout_id) VALUES ('t393-tpl', 'T', 'content', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
      )) as { id: string }[];
      const id = tpl[0]?.id;
      if (!id) throw new Error("seed failed");
      return id;
    });
    const created = await execute(registry, adapter, SYS_CTX, "pages.create", {
      slug: "t393-page",
      title: "T",
      templateId,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const pageId = (created.value as { pageId: string }).pageId;
    localeByPage.set(pageId, "de");
    const migrate = await execute(registry, adapter, SYS_CTX, "url_migrations.propose_migrate", {});
    if (!migrate.ok) throw new Error(JSON.stringify(migrate.error));
    const applied = await execute(registry, adapter, HUMAN_CTX, "url_migrations.execute_proposal", {
      proposalId: (migrate.value as { proposalId: string }).proposalId,
    });
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));

    // Propose + execute the uninstall.
    const proposed = await execute(registry, adapter, SYS_CTX, "plugins.propose_uninstall", {
      slug: "t393-life",
      reason: "test teardown",
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const preview = (proposed.value as { preview: Record<string, unknown> }).preview;
    expect(preview.dataLoss).toBe(true);
    expect(preview.urlSlotsReleased).toEqual(["path-prefix"]);
    expect(preview.skillsArchived).toEqual(["t393-skill"]);

    const executed = await execute(registry, adapter, HUMAN_CTX, "plugins.execute_proposal", {
      proposalId: (proposed.value as { proposalId: string }).proposalId,
    });
    if (!executed.ok) throw new Error(JSON.stringify(executed.error));
    const result = executed.value as { pagesMoved: number; redirectsCreated: number };
    expect(result.pagesMoved).toBe(1);
    expect(result.redirectsCreated).toBe(1);

    // Runtime + row + slot gone; skill archived; page moved back.
    expect(loadedPlugins.bySlug("t393-life")).toBeUndefined();
    expect(urlContributionsRegistry.bySlot("path-prefix")).toBeNull();
    const after = await sqlSystem(async (tx) => {
      const plugins = (await tx.unsafe(
        `SELECT COUNT(*)::int AS n FROM plugins WHERE slug = 't393-life'`,
      )) as { n: number }[];
      const skill = (await tx.unsafe(`SELECT status FROM skills WHERE slug = 't393-skill'`)) as {
        status: string;
      }[];
      const page = (await tx.unsafe(`SELECT current_path FROM pages WHERE id = '${pageId}'`)) as {
        current_path: string;
      }[];
      const redirect = (await tx.unsafe(
        `SELECT to_path FROM redirects WHERE from_path = '/de/t393-page'`,
      )) as { to_path: string }[];
      const schema = (await tx.unsafe(
        `SELECT COUNT(*)::int AS n FROM pg_namespace WHERE nspname = 'plugin_t393_life'`,
      )) as { n: number }[];
      return { plugins, skill, page, redirect, schema };
    });
    expect(after.plugins[0]?.n).toBe(0);
    expect(after.skill[0]?.status).toBe("archived");
    expect(after.page[0]?.current_path).toBe("/t393-page");
    expect(after.redirect[0]?.to_path).toBe("/t393-page");
    expect(after.schema[0]?.n).toBe(0);
    expect(droppedSchemas).toEqual(["public:plugin_t393_life", "admin:plugin_t393_life"]);
  });
});

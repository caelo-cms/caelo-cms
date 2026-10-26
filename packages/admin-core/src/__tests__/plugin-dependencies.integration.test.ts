// SPDX-License-Identifier: MPL-2.0

/**
 * `requiresPlugins` end to end: activation is refused until every required
 * plugin is active (the error names the one to activate first), a required
 * plugin cannot be disabled or uninstalled while a dependent is active,
 * the registry reads show both directions, and a dependent whose
 * dependency is not active at load is not loaded — recorded as its health
 * problem, its status left as the Owner set it (CLAUDE.md §2, #1008).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bootstrap, loadedPlugins, resetPluginHost } from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { ensureRoleUser } from "./fixtures/role-user.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t-requires",
};
const HUMAN_CTX: ExecutionContext = {
  ...SYS_CTX,
  actorId: "00000000-0000-0000-0000-0000011210e1",
  actorKind: "human",
};

const DEP = "t1121-dep";
const NEED = "t1121-need";

const depPlugin = definePlugin({
  slug: DEP,
  version: "1.0.0",
  tier: 1,
  schema: {},
  operations: { noop: async () => ({}) },
});

const needPlugin = definePlugin({
  slug: NEED,
  version: "1.0.0",
  tier: 1,
  schema: {},
  operations: { noop: async () => ({}) },
  requiresPlugins: [DEP],
  consentPurposes: [
    {
      key: "visitor_id",
      category: "functional",
      purpose: "Test purpose.",
      cookies: [{ name: "caelo_visitor_id", lifetime: "30 days", purpose: "Test cookie." }],
    },
  ],
});

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function statusOf(slug: string): Promise<string | undefined> {
  return sqlSystem(
    async (tx) =>
      ((await tx`SELECT status FROM plugins WHERE slug = ${slug}`) as { status: string }[])[0]
        ?.status,
  );
}

async function setStatus(slug: string, status: string): Promise<void> {
  await sqlSystem(async (tx) => {
    await tx`UPDATE plugins SET status = ${status} WHERE slug = ${slug}`;
  });
}

function boot(plugins: ReadonlyArray<typeof depPlugin>) {
  resetPluginHost();
  return bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: plugins.map((definition) => ({ definition })),
  });
}

/** The op's error message, or a failure when it succeeded. */
async function refusal(
  ctx: ExecutionContext,
  op: string,
  input: Record<string, unknown>,
): Promise<string> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (r.ok) throw new Error(`${op} unexpectedly succeeded`);
  return "message" in r.error ? String(r.error.message) : r.error.kind;
}

async function succeeds(ctx: ExecutionContext, op: string, input: Record<string, unknown>) {
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe("DELETE FROM plugin_pending_actions");
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't1121-%'))`);
    await tx.unsafe(
      "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't1121-%')",
    );
    await tx.unsafe("DELETE FROM plugin_errors WHERE plugin_slug LIKE 't1121-%'");
    await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't1121-%'");
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await ensureRoleUser(ADMIN_URL, HUMAN_CTX.actorId, "owner");
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("requiresPlugins", () => {
  it("does not load an active plugin whose dependency is not active, and records why", async () => {
    // The explicit test hand-off lands the row active, with nothing it requires installed.
    const report = await boot([needPlugin]);
    expect(report.failed.map((f) => f.slug)).toEqual([NEED]);
    expect(report.failed[0]?.reason).toContain(`requires "${DEP}" (not installed)`);
    expect(loadedPlugins.bySlug(NEED)).toBeUndefined();
    // Loud, never a switch: the status stays the Owner's (#1008).
    expect(await statusOf(NEED)).toBe("active");
    const errors = await sqlSystem(
      async (tx) =>
        (await tx`SELECT phase, error_class, message FROM plugin_errors WHERE plugin_slug = ${NEED}`) as {
          phase: string;
          error_class: string;
          message: string;
        }[],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ phase: "register", error_class: "plugin" });
    expect(errors[0]?.message).toContain(DEP);
  });

  it("refuses to activate a plugin before what it requires, naming the plugin to activate first", async () => {
    await boot([depPlugin, needPlugin]);
    await setStatus(DEP, "awaiting_activation");
    await setStatus(NEED, "awaiting_activation");

    for (const [ctx, op] of [
      [HUMAN_CTX, "plugins.activate"],
      [HUMAN_CTX, "plugins.prepare_activation"],
      [SYS_CTX, "plugins.propose_activation"],
    ] as const) {
      const message = await refusal(ctx, op, { slug: NEED });
      expect(message).toContain(`requires "${DEP}" (awaiting_activation)`);
      expect(message).toContain(`Activate "${DEP}" first`);
    }
    expect(await statusOf(NEED)).toBe("awaiting_activation");

    await succeeds(HUMAN_CTX, "plugins.activate", { slug: DEP });
    await succeeds(HUMAN_CTX, "plugins.activate", { slug: NEED });
    expect(await statusOf(NEED)).toBe("active");
  });

  it("shows the dependency both ways on the registry reads", async () => {
    const need = (await succeeds(SYS_CTX, "plugins.get", { slug: NEED })) as {
      plugin: { requiresPlugins: string[]; requiredBy: string[] };
    };
    expect(need.plugin.requiresPlugins).toEqual([DEP]);
    expect(need.plugin.requiredBy).toEqual([]);
    const list = (await succeeds(SYS_CTX, "plugins.list", {})) as {
      plugins: { slug: string; requiresPlugins: string[]; requiredBy: string[] }[];
    };
    expect(list.plugins.find((p) => p.slug === DEP)?.requiredBy).toEqual([NEED]);
  });

  it("refuses to disable or uninstall a plugin an active plugin requires, listing the dependents", async () => {
    const disable = await refusal(HUMAN_CTX, "plugins.disable", { slug: DEP });
    expect(disable).toContain(`while "${NEED}" requires it`);
    expect(disable).toContain(`Disable "${NEED}" first`);
    const uninstall = await refusal(SYS_CTX, "plugins.propose_uninstall", { slug: DEP });
    expect(uninstall).toContain(`cannot be uninstalled while "${NEED}" requires it`);
    expect(await statusOf(DEP)).toBe("active");

    // Dependents first, then the dependency.
    await succeeds(HUMAN_CTX, "plugins.disable", { slug: NEED });
    await succeeds(HUMAN_CTX, "plugins.disable", { slug: DEP });
    expect(await statusOf(DEP)).toBe("disabled");

    // And the dependent cannot come back on before it.
    const reenable = await refusal(HUMAN_CTX, "plugins.activate", { slug: NEED });
    expect(reenable).toContain(`requires "${DEP}" (disabled)`);
  });
});

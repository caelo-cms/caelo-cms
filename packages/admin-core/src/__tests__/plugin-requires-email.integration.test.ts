// SPDX-License-Identifier: MPL-2.0

/**
 * #1332 (E12) — a plugin whose manifest says `requires: ["email"]` cannot
 * be activated while no mail transport is configured, and the refusal names
 * the setup step: a newsletter that cannot send a single confirmation would
 * run half broken (CLAUDE.md §2, no fallbacks).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bootstrap, resetPluginHost } from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const OWNER: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "human",
  requestId: "t1332m",
};
const SLUG = "t1332-mailer";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await asSystem(async (tx) => {
    await tx.unsafe(
      `DELETE FROM audit_events WHERE entity_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`,
    );
    await tx.unsafe(
      `DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = '${SLUG}')`,
    );
    await tx.unsafe(`DELETE FROM plugins WHERE slug = '${SLUG}'`);
    await tx.unsafe(`UPDATE email_config SET transport = 'none', config_json = '{}' WHERE id = 1`);
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("requires: [email] (#1332)", () => {
  it("refuses activation without a mail transport, naming the setup step, and activates with one", async () => {
    const plugin = definePlugin({
      slug: SLUG,
      version: "1.0.0",
      tier: 1,
      schema: {},
      requires: ["email"],
      operations: { noop: async () => ({}) },
    });
    const boot = await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: plugin }],
    });
    expect(boot.failed).toEqual([]);
    const disabled = await execute(registry, adapter, OWNER, "plugins.disable", { slug: SLUG });
    if (!disabled.ok) throw new Error(JSON.stringify(disabled.error));

    const refused = await execute(registry, adapter, OWNER, "plugins.activate", { slug: SLUG });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      const message = "message" in refused.error ? String(refused.error.message) : "";
      expect(message).toContain("the mail transport cannot deliver (no email transport is set up)");
      expect(message).toContain("Settings → Email");
    }

    await asSystem((tx) =>
      tx.unsafe(
        `UPDATE email_config SET transport = 'resend', config_json = '{"apiKey":"re_test"}' WHERE id = 1`,
      ),
    );
    const activated = await execute(registry, adapter, OWNER, "plugins.activate", { slug: SLUG });
    if (!activated.ok) throw new Error(JSON.stringify(activated.error));
  });
});

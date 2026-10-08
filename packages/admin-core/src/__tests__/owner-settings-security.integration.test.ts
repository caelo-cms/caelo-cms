// SPDX-License-Identifier: MPL-2.0

/**
 * owner_settings — plugin AI cost cap + gateway cookie-secret rotation
 * (migration 0244), against a real Postgres.
 *
 * Per kind: the AI proposes and gets a pending row with a preview; the AI
 * cannot apply it (neither the direct op nor execute_proposal); an editor
 * without settings.write cannot approve; the Owner's in-chat Approve (the
 * gated execute) applies it through the direct op's handler and audits it.
 * Plus: no-op and unknown-plugin proposals fail loudly, a second pending
 * rotation is refused, reject leaves the setting alone, and
 * list_plugin_installations shows the AI a staged package without its source.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { attachGatedExecute } from "../ai/tools/gated-tools.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";
import { ensureRoleUser } from "./fixtures/role-user.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const P = "owner-sec-int";
const OWNER: ExecutionContext = {
  actorId: "00000000-0000-4000-8000-0000000a5e01",
  actorKind: "human",
  requestId: `${P}-owner`,
};
const EDITOR: ExecutionContext = {
  actorId: "00000000-0000-4000-8000-0000000a5e02",
  actorKind: "human",
  requestId: `${P}-editor`,
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-4000-8000-0000000a5e03",
  actorKind: "ai",
  requestId: `${P}-ai`,
};
const PLUGIN = `${P}-plug`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const tools = createDefaultToolRegistry();
let pluginId: string;
let savedSecret: string | null = null;

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM owner_settings_pending_actions WHERE proposed_by = ${AI.actorId}::uuid`;
    await tx`DELETE FROM plugin_installation_versions WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN})`;
    await tx`DELETE FROM plugins WHERE slug = ${PLUGIN}`;
  });
}

async function run(name: string, input: unknown, ctx: ExecutionContext) {
  return execute(registry, adapter, ctx, name, input);
}

async function cap(): Promise<number | null> {
  const rows = await asSystem(
    async (tx) =>
      (await tx`SELECT ai_cost_cap_microcents::text AS cap FROM plugins WHERE id = ${pluginId}::uuid`) as {
        cap: string | null;
      }[],
  );
  return rows[0]?.cap === null || rows[0]?.cap === undefined ? null : Number(rows[0].cap);
}

async function secret(): Promise<string | null> {
  const rows = await asSystem(
    async (tx) =>
      (await tx`SELECT gateway_cookie_secret AS s FROM site_settings WHERE id = 1`) as {
        s: string | null;
      }[],
  );
  return rows[0]?.s ?? null;
}

/** The chat's gated execute: propose as the AI, apply after `approver`'s click. */
async function approveInChat(tool: string, input: unknown, approver: ExecutionContext) {
  const t = tools.catalogue().find((x) => x.name === tool);
  if (!t) throw new Error(`${tool} not registered`);
  const gated = attachGatedExecute(t, registry, adapter, AI, approver);
  return (await gated.execute?.(input)) as { ok: boolean; value?: { kind: string } };
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await ensureRoleUser(ADMIN_URL as string, OWNER.actorId, "owner");
  await ensureRoleUser(ADMIN_URL as string, EDITOR.actorId, "editor");
  await wipe();
  pluginId = await asSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${AI.actorId}::uuid, 'ai', ${P}) ON CONFLICT DO NOTHING`;
    await tx`UPDATE site_settings SET gateway_cookie_secret = COALESCE(gateway_cookie_secret, 'seed-secret') WHERE id = 1`;
    const p = (await tx`
      INSERT INTO plugins (slug, version, tier, status, manifest_json, source_code, submitted_by)
      VALUES (${PLUGIN}, '1.0.0', 2, 'awaiting_activation', '{}'::jsonb, '', ${OWNER.actorId}::uuid)
      RETURNING id::text AS id`) as { id: string }[];
    return p[0]?.id as string;
  });
  savedSecret = await secret();
});

afterAll(async () => {
  await wipe();
  await asSystem(async (tx) => {
    await tx`UPDATE site_settings SET gateway_cookie_secret = ${savedSecret} WHERE id = 1`;
  });
  await adapter.close();
});

describe("propose_set_plugin_ai_cost_cap", () => {
  it("the AI cannot set the cap directly or approve its own proposal", async () => {
    const direct = await run("plugins.set_ai_cost_cap", { pluginId, capMicrocents: 1 }, AI);
    expect(direct.ok).toBe(false);
    const proposed = await run(
      "owner_settings.propose_set_plugin_ai_cost_cap",
      { pluginSlug: PLUGIN, capMicrocents: 500_000_000 },
      AI,
    );
    expect(proposed.ok).toBe(true);
    const { proposalId, preview } = (
      proposed as { value: { proposalId: string; preview: Record<string, unknown> } }
    ).value;
    expect(preview.summary).toBe(`${PLUGIN} AI cost cap: uncapped → $5.00 per 24h`);
    expect((await run("owner_settings.execute_proposal", { proposalId }, AI)).ok).toBe(false);
    const editor = await run("owner_settings.execute_proposal", { proposalId }, EDITOR);
    expect(editor.ok).toBe(false);
    expect(await cap()).toBeNull();
    // The Owner's Reject leaves the cap alone.
    expect((await run("owner_settings.reject_proposal", { proposalId }, OWNER)).ok).toBe(true);
    expect(await cap()).toBeNull();
  });

  it("applies after the Owner's in-chat Approve, with an audit row", async () => {
    const out = await approveInChat(
      "propose_set_plugin_ai_cost_cap",
      { pluginSlug: PLUGIN, capMicrocents: 250_000_000 },
      OWNER,
    );
    expect(out.ok).toBe(true);
    expect(out.value?.kind).toBe("set_plugin_ai_cost_cap");
    expect(await cap()).toBe(250_000_000);
    const audit = await asSystem(
      async (tx) =>
        (await tx`SELECT count(*)::int AS c FROM audit_events
                  WHERE operation = 'plugins.set_ai_cost_cap' AND entity_id = ${pluginId}::uuid`) as {
          c: number;
        }[],
    );
    expect(audit[0]?.c).toBeGreaterThan(0);
  });

  it("refuses a no-op and an unknown plugin with an actionable message", async () => {
    const same = await run(
      "owner_settings.propose_set_plugin_ai_cost_cap",
      { pluginSlug: PLUGIN, capMicrocents: 250_000_000 },
      AI,
    );
    expect(same.ok).toBe(false);
    expect(JSON.stringify(same)).toContain("already $2.50");
    const unknown = await run(
      "owner_settings.propose_set_plugin_ai_cost_cap",
      { pluginSlug: `${P}-missing`, capMicrocents: null },
      AI,
    );
    expect(unknown.ok).toBe(false);
    expect(JSON.stringify(unknown)).toContain("list_plugins");
  });
});

describe("propose_rotate_gateway_cookie_secret", () => {
  it("the AI cannot rotate directly; one rotation may wait at a time", async () => {
    expect((await run("gateway.rotate_cookie_secret", {}, AI)).ok).toBe(false);
    const first = await run(
      "owner_settings.propose_rotate_gateway_cookie_secret",
      { reason: "the .env leaked into a public backup" },
      AI,
    );
    expect(first.ok).toBe(true);
    const second = await run(
      "owner_settings.propose_rotate_gateway_cookie_secret",
      { reason: "asking again, different words" },
      AI,
    );
    expect(second.ok).toBe(false);
    expect(JSON.stringify(second)).toContain("already waiting");
    // Two proposals racing past the op's read still cannot both wait: the
    // database refuses a second pending rotation whatever its reason.
    const raced = asSystem(
      async (tx) =>
        tx`INSERT INTO owner_settings_pending_actions (kind, proposed_by, payload, preview, status, payload_hash)
           VALUES ('rotate_gateway_cookie_secret', ${AI.actorId}::uuid, '{}'::jsonb, '{}'::jsonb, 'pending', ${`${P}-race`})`,
    );
    await expect(raced).rejects.toThrow(/one_cookie_rotation_uniq|duplicate key/);
    const { proposalId } = (first as { value: { proposalId: string } }).value;
    expect((await run("owner_settings.reject_proposal", { proposalId }, OWNER)).ok).toBe(true);
  });

  it("rotates after the Owner's in-chat Approve and never shows the secret", async () => {
    const before = await secret();
    const out = await approveInChat(
      "propose_rotate_gateway_cookie_secret",
      { reason: "the .env leaked into a public backup" },
      OWNER,
    );
    expect(out.ok).toBe(true);
    expect(out.value?.kind).toBe("rotate_gateway_cookie_secret");
    const after = await secret();
    expect(after).not.toBe(before);
    expect(after).toHaveLength(128);
    expect(JSON.stringify(out)).not.toContain(after as string);
  });

  it("rejects a reason too short to tell the Owner why", async () => {
    const r = await run("owner_settings.propose_rotate_gateway_cookie_secret", { reason: "x" }, AI);
    expect(r.ok).toBe(false);
  });
});

describe("list_plugin_installations", () => {
  it("shows the AI a staged package's status without its source", async () => {
    await asSystem(async (tx) => {
      // The staging policy binds submitted_by to the session's actor.
      await tx.unsafe(`SET LOCAL caelo.actor_id = '${OWNER.actorId}'`);
      await tx`INSERT INTO plugin_installation_versions (plugin_id, artifact_digest, manifest_json, source_code, origin, submitted_by)
               VALUES (${pluginId}::uuid, ${"a".repeat(64)}, '{}'::jsonb, 'const STAGED_SOURCE_MARKER = 1;', 'runtime-authored', ${OWNER.actorId}::uuid)`;
    });
    const r = await tools.dispatch("list_plugin_installations", { filter: PLUGIN }, AI, {
      adapter,
      registry,
    });
    expect(r.ok, r.content).toBe(true);
    expect(r.content).toContain(`${PLUGIN},pending,runtime-authored`);
    expect(JSON.stringify(r)).not.toContain("STAGED_SOURCE_MARKER");
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * #1008 — a plugin's skills are available exactly where its tools are.
 *
 * A plugin that loaded once (its skill is persisted and active) and then
 * fails to load in this process keeps the Owner's `active` status, but its
 * tools are gone here — so its skill must not be offered here either:
 *   - skills.list leaves it out (the pinned index asks for it explicitly);
 *   - skills.get answers why instead of returning the body;
 *   - load_skill refuses with the reason and the next step;
 *   - a new chat's `# Skills` index leaves it out;
 *   - a RUNNING chat's index never changes: it was fixed when the chat's
 *     index was first built (`chat.pin_skills_index`), and the failure
 *     and the recovery reach the chat as two history notes instead.
 * Real Postgres, real plugin host.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bootstrap, resetPluginHost } from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { noteSignature } from "../ai/chat-runner/context/page.js";
import { buildSkillsContext, skillAvailabilityNote } from "../ai/chat-runner/context/skills.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { loadSkillTool } from "../ai/tools/load-skill.js";
import { registerAdminOps } from "../register.js";
import { ensureRoleUser } from "./fixtures/role-user.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1008-skills",
};
const OWNER: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000010080a1",
  actorKind: "human",
  requestId: "t1008-skills-chat",
};
const PLUGIN = "t1008s-consent";
const SKILL = "t1008s-consent-guide";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let healthy = true;

const plugin = definePlugin({
  slug: PLUGIN,
  version: "0.1.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["chat_runner_tools"],
  operations: { status: async () => ({}) },
  tools: [
    {
      name: "t1008s_consent_status",
      description: "consent status",
      operationName: "status",
      inputJsonSchema: {},
    },
  ],
  skills: [
    {
      slug: SKILL,
      displayName: "Consent guide",
      description: "how to use the consent banner",
      body: "Call t1008s_consent_status first.",
    },
  ],
  onActivate: async () => {
    if (!healthy) throw new Error("consent service unreachable");
  },
});

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

async function boot() {
  resetPluginHost();
  return bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: plugin }],
  });
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx`DELETE FROM chat_sessions WHERE title LIKE 't1008s %'`;
    await tx`DELETE FROM plugin_runtime WHERE plugin_slug = ${PLUGIN}`;
    await tx`DELETE FROM plugin_errors WHERE plugin_slug = ${PLUGIN}`;
    await tx`DELETE FROM skills WHERE slug = ${SKILL}`;
    await tx`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PLUGIN})`;
    await tx`DELETE FROM plugins WHERE slug = ${PLUGIN}`;
  });
}

async function listedSlugs(): Promise<string[]> {
  const r = await execute(registry, adapter, SYS, "skills.list", { status: "active" });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { skills: { slug: string }[] }).skills.map((s) => s.slug);
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await ensureRoleUser(ADMIN_URL as string, OWNER.actorId, "owner");
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("#1008 — a failed plugin's skills are not offered where it does not run", () => {
  it("offers the skill while the plugin runs", async () => {
    healthy = true;
    const report = await boot();
    expect(report.failed).toEqual([]);
    expect(await listedSlugs()).toContain(SKILL);
    const got = await execute(registry, adapter, SYS, "skills.get", { slug: SKILL });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    expect(got.value).toMatchObject({ skill: { slug: SKILL }, notRunningHere: null });
  });

  it("hides and refuses it once a later load fails, leaving the plugin active", async () => {
    healthy = false;
    const report = await boot();
    expect(report.failed.map((f) => f.slug)).toEqual([PLUGIN]);
    const status = await sqlSystem(
      async (tx) =>
        (await tx`SELECT status FROM plugins WHERE slug = ${PLUGIN}`) as { status: string }[],
    );
    expect(status[0]?.status).toBe("active");

    expect(await listedSlugs()).not.toContain(SKILL);

    const got = await execute(registry, adapter, SYS, "skills.get", { slug: SKILL });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    const value = got.value as {
      skill: unknown;
      notRunningHere: { pluginSlug: string; reason: string } | null;
    };
    expect(value.skill).toBeNull();
    expect(value.notRunningHere?.pluginSlug).toBe(PLUGIN);
    expect(value.notRunningHere?.reason).toContain("consent service unreachable");

    const loaded = await loadSkillTool.handler(SYS, { slugs: [SKILL] }, {
      registry,
      adapter,
    } as ToolContext);
    expect(loaded.ok).toBe(false);
    expect(loaded.content).toContain(`its plugin "${PLUGIN}" failed to load on this server`);
    expect(loaded.content).toContain("/settings/plugins");

    // A chat that starts now does not see it in its index.
    const ctx = await buildSkillsContext(registry, adapter, SYS, {
      chatStartedAt: new Date().toISOString(),
    });
    expect(ctx.skillsIndexBlock ?? "").not.toContain(SKILL);
    expect(ctx.newlyActivated.map((s) => s.slug)).not.toContain(SKILL);
  });

  it("offers it again once the plugin loads", async () => {
    healthy = true;
    const report = await boot();
    expect(report.failed).toEqual([]);
    expect(await listedSlugs()).toContain(SKILL);
  });

  it("keeps a running chat's index byte-identical through a failure and a recovery", async () => {
    healthy = true;
    expect((await boot()).failed).toEqual([]);
    const created = await execute(registry, adapter, OWNER, "chat.create_session", {
      title: "t1008s running",
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const { chatSessionId } = created.value as { chatSessionId: string };
    const session = await execute(registry, adapter, OWNER, "chat.get_session", { chatSessionId });
    if (!session.ok) throw new Error(JSON.stringify(session.error));
    const chatStartedAt = (session.value as { session: { createdAt: string } }).session.createdAt;
    const turn = () =>
      buildSkillsContext(registry, adapter, OWNER, {
        chatStartedAt,
        chatSessionId,
      });

    const first = await turn();
    expect(first.skillsIndexBlock).toContain(SKILL);
    expect(skillAvailabilityNote(first.notRunningHere, null)).toBeNull();

    // The plugin fails to load: same index, one "not available" note.
    healthy = false;
    expect((await boot()).failed.map((f) => f.slug)).toEqual([PLUGIN]);
    const failed = await turn();
    expect(failed.skillsIndexBlock).toBe(first.skillsIndexBlock as string);
    expect(failed.notRunningHere.map((s) => s.slug)).toEqual([SKILL]);
    const down = skillAvailabilityNote(failed.notRunningHere, null);
    expect(down?.body).toContain("NOT available");

    // It recovers: same index, one "available again" note, then silence.
    healthy = true;
    expect((await boot()).failed).toEqual([]);
    const recovered = await turn();
    expect(recovered.skillsIndexBlock).toBe(first.skillsIndexBlock as string);
    expect(recovered.notRunningHere).toEqual([]);
    expect(recovered.newlyActivated).toEqual([]);
    const back = skillAvailabilityNote(recovered.notRunningHere, noteSignature(down?.seed ?? ""));
    expect(back?.body).toContain("run on this server again");
    expect(
      skillAvailabilityNote(recovered.notRunningHere, noteSignature(back?.seed ?? "x")),
    ).toBeNull();
  });

  it("a chat that began while the plugin failed keeps it out of its index after a recovery", async () => {
    healthy = false;
    await boot();
    const created = await execute(registry, adapter, OWNER, "chat.create_session", {
      title: "t1008s during failure",
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const { chatSessionId } = created.value as { chatSessionId: string };
    const turn = () =>
      buildSkillsContext(registry, adapter, OWNER, {
        chatStartedAt: new Date(Date.now() + 1000).toISOString(),
        chatSessionId,
      });
    const first = await turn();
    expect(first.skillsIndexBlock ?? "").not.toContain(SKILL);

    healthy = true;
    await boot();
    const later = await turn();
    expect(later.skillsIndexBlock).toBe(first.skillsIndexBlock);
    // Announced through the history instead, like a newly activated skill.
    expect(later.newlyActivated.map((s) => s.slug)).toContain(SKILL);

    // It fails again: the chat knows the skill from that announcement, not
    // from its index, and must still be told it is gone.
    healthy = false;
    await boot();
    const again = await turn();
    expect(again.skillsIndexBlock).toBe(first.skillsIndexBlock);
    expect(again.notRunningHere.map((s) => s.slug)).toEqual([SKILL]);
    expect(skillAvailabilityNote(again.notRunningHere, null)?.body).toContain("NOT available");
  });
});

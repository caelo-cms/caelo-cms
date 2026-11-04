// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — one plugin model: a release-signed plugin whose new release
 * asks for a capability the Owner has not approved for it stays installed
 * and active (its status is the Owner's, #1008) but does not run until the
 * Owner approves the new set. That is how international-site and
 * consent-manager reach `change_journal` on upgrade (migration 0431 keeps
 * what each plugin ran with before).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  AWAITING_CAPABILITY_APPROVAL,
  bootstrap,
  loadActivatedPlugin,
  loadedPlugins,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
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
  requestId: "t1267a",
};
/** Approving needs plugins.install on a human; these tests act as the platform. */
const PLATFORM: ExecutionContext = { ...OWNER, actorKind: "system" };
const SLUG = "t1267a-upgraded";
/** What the pre-#1008 loader wrote on a failed load (searchVIU, 2026-10-22). */
const STALE_FINDING = [{ kind: "load", hint: 'syntax error at or near "CREATE SCHEMA"' }];

interface PluginOut {
  slug: string;
  status: string;
  unapprovedCapabilities: string[];
  validationErrors: unknown[];
  health: { state: string; awaitingCapabilities: string[] };
}

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const plugin = definePlugin({
  slug: SLUG,
  version: "0.2.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["background_workers", "cms_admin"],
  operations: { noop: async () => ({}) },
});

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
  });
}

async function boot() {
  return bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: plugin }],
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

describe("#1267 — a new release's capabilities wait for the Owner", () => {
  it("runs what was approved, holds a release that asks for more, and runs it once approved", async () => {
    // First activation: the explicit hand-off approves exactly what it asks for.
    const first = await boot();
    expect(first.loaded.map((l) => l.slug)).toEqual([SLUG]);

    // The previous release had been approved for less (what 0431 backfills).
    resetPluginHost();
    // #1306 — and it carries a validator finding the pre-#1008 loader left.
    await asSystem(
      (tx) =>
        tx`UPDATE plugins SET approved_capabilities = ARRAY['cms_admin'],
                              validation_errors = ${JSON.stringify(STALE_FINDING)}::jsonb
           WHERE slug = ${SLUG}`,
    );
    const upgraded = await boot();
    expect(upgraded.loaded).toEqual([]);
    expect(upgraded.inactive).toEqual([
      { slug: SLUG, version: "0.2.0", status: AWAITING_CAPABILITY_APPROVAL },
    ]);
    expect(loadedPlugins.bySlug(SLUG)).toBeUndefined();

    // Still the Owner's status: active, not switched off.
    const listed = await execute(registry, adapter, OWNER, "plugins.get", { slug: SLUG });
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const row = (listed.value as { plugin: PluginOut }).plugin;
    expect(row.status).toBe("active");
    expect(row.unapprovedCapabilities).toEqual(["background_workers"]);
    // #1306 — the health says why it does not run, not "unreported".
    expect(row.health.state).toBe("awaiting_approval");
    expect(row.health.awaitingCapabilities).toEqual(["background_workers"]);
    // The load attempt's upsert cleared the stale finding.
    expect(row.validationErrors).toEqual([]);
    const all = await execute(registry, adapter, OWNER, "plugins.list", {});
    if (!all.ok) throw new Error(JSON.stringify(all.error));
    const inList = (all.value as { plugins: PluginOut[] }).plugins.find((p) => p.slug === SLUG);
    expect(inList?.health.state).toBe("awaiting_approval");
    // A reload says what starts it, not "plugin is …, not active".
    const reloaded = await loadActivatedPlugin(SLUG);
    expect(reloaded.loaded).toBe(false);
    expect(reloaded.reason).toContain("waits for the Owner");

    const approved = await execute(registry, adapter, PLATFORM, "plugins.approve_capabilities", {
      slug: SLUG,
    });
    if (!approved.ok) throw new Error(JSON.stringify(approved.error));
    expect((approved.value as { approved: string[] }).approved.sort()).toEqual([
      "background_workers",
      "cms_admin",
    ]);
    expect((await loadActivatedPlugin(SLUG)).loaded).toBe(true);
    const after = await execute(registry, adapter, OWNER, "plugins.get", { slug: SLUG });
    if (!after.ok) throw new Error(JSON.stringify(after.error));
    const afterRow = (after.value as { plugin: PluginOut }).plugin;
    expect(afterRow.unapprovedCapabilities).toEqual([]);
    expect(afterRow.health.state).not.toBe("awaiting_approval");
    expect(afterRow.health.awaitingCapabilities).toEqual([]);
  });

  it("#1332 — holds a release whose manifest changed with the same capabilities, until approved", async () => {
    await cleanup();
    expect((await boot()).loaded.map((l) => l.slug)).toEqual([SLUG]);
    // The Owner approved another manifest than the one this release ships
    // (as after an upgrade that changed its public operations).
    resetPluginHost();
    await asSystem(
      (tx) =>
        tx`UPDATE plugins SET approved_manifest_digest = ${"0".repeat(64)} WHERE slug = ${SLUG}`,
    );
    const upgraded = await boot();
    expect(upgraded.loaded).toEqual([]);
    expect(upgraded.inactive).toEqual([
      { slug: SLUG, version: "0.2.0", status: AWAITING_CAPABILITY_APPROVAL },
    ]);
    const got = await execute(registry, adapter, OWNER, "plugins.get", { slug: SLUG });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    const row = (
      got.value as {
        plugin: PluginOut & {
          releaseUnapproved: boolean;
          health: { awaitingRelease: boolean };
        };
      }
    ).plugin;
    expect(row.status).toBe("active");
    expect(row.unapprovedCapabilities).toEqual([]);
    expect(row.releaseUnapproved).toBe(true);
    expect(row.health.state).toBe("awaiting_approval");
    expect(row.health.awaitingRelease).toBe(true);

    // An approval of a manifest the Owner was not shown is refused.
    const stale = await execute(registry, adapter, PLATFORM, "plugins.approve_capabilities", {
      slug: SLUG,
      manifestDigest: "f".repeat(64),
    });
    expect(stale.ok).toBe(false);

    const approved = await execute(registry, adapter, PLATFORM, "plugins.approve_capabilities", {
      slug: SLUG,
    });
    if (!approved.ok) throw new Error(JSON.stringify(approved.error));
    expect((await loadActivatedPlugin(SLUG)).loaded).toBe(true);
  });

  it("refuses an AI actor and a plugin that is not installed", async () => {
    const ai = await execute(
      registry,
      adapter,
      { ...OWNER, actorKind: "ai" },
      "plugins.approve_capabilities",
      { slug: SLUG },
    );
    expect(ai.ok).toBe(false);
    if (!ai.ok) expect(ai.error.kind).toBe("ActorScopeRejected");
    const missing = await execute(registry, adapter, PLATFORM, "plugins.approve_capabilities", {
      slug: "t1267a-nothing",
    });
    expect(missing.ok).toBe(false);
  });

  it("#1420 — refuses a human without the right to decide", async () => {
    const r = await execute(registry, adapter, OWNER, "plugins.approve_capabilities", {
      slug: SLUG,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect("message" in r.error && r.error.message).toContain("plugins.install");
  });
});

describe("#1420 — what waits for the Owner is visible and approved in one place", () => {
  interface Approvals {
    releases: {
      slug: string;
      manifestDigest: string;
      capabilities: { id: string; label: string; allows: string }[];
      changes: { area: string; added: string[] }[] | null;
    }[];
  }

  async function waiting() {
    const r = await execute(registry, adapter, OWNER, "plugins.list_approvals", {});
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (r.value as Approvals).releases.find((p) => p.slug === SLUG);
  }

  async function bell(): Promise<number> {
    const r = await execute(registry, adapter, OWNER, "notifications.aggregate", {});
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (r.value as { pluginApprovals: number }).pluginApprovals;
  }

  /** An upgrade: the approved manifest had one tool fewer and no background jobs. */
  async function stopByUpgrade() {
    await cleanup();
    expect((await boot()).loaded.map((l) => l.slug)).toEqual([SLUG]);
    resetPluginHost();
    await asSystem(
      (tx) =>
        tx`UPDATE plugins SET approved_capabilities = ARRAY['cms_admin'],
                              approved_manifest_digest = ${"0".repeat(64)},
                              approved_manifest_json = manifest_json || '{"operations":["old"]}'::jsonb
           WHERE slug = ${SLUG}`,
    );
    await boot();
  }

  it("records the approved manifest with the activation", async () => {
    await cleanup();
    await boot();
    const rows = await asSystem(
      (tx) => tx`SELECT approved_manifest_json FROM plugins WHERE slug = ${SLUG}`,
    );
    expect(
      (rows as { approved_manifest_json: { slug: string } }[])[0]?.approved_manifest_json.slug,
    ).toBe(SLUG);
    expect(await waiting()).toBeUndefined();
  });

  it("keeps the manifest an install approved before this was recorded, when a release replaces it", async () => {
    await cleanup();
    await boot();
    resetPluginHost();
    await asSystem(
      (tx) => tx`UPDATE plugins SET approved_manifest_json = NULL WHERE slug = ${SLUG}`,
    );
    const next = definePlugin({
      slug: SLUG,
      version: "0.3.0",
      tier: 1,
      schema: {},
      requestedCapabilities: ["background_workers", "cms_admin"],
      operations: { noop: async () => ({}), added: async () => ({}) },
    });
    await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: next }],
    });
    expect((await waiting())?.changes).toEqual([
      { area: "Internal operations", added: ["added"], removed: [], changed: [] },
    ]);
  });

  it("lists a stopped release in plain language with what changed, and the bell counts it", async () => {
    await cleanup();
    const before = await bell();
    await stopByUpgrade();
    const release = await waiting();
    expect(release?.capabilities.map((c) => c.label)).toEqual(["Background jobs"]);
    expect(release?.capabilities[0]?.allows).toContain("scheduled work");
    expect(release?.changes).toEqual([
      { area: "Internal operations", added: ["noop"], removed: ["old"], changed: [] },
    ]);
    expect(await bell()).toBe(before + 1);
  });

  it("counts a package review only for who may decide it", async () => {
    await cleanup();
    await boot();
    const count = async (ctx: ExecutionContext) => {
      const r = await execute(registry, adapter, ctx, "notifications.aggregate", {});
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return (r.value as { pluginApprovals: number }).pluginApprovals;
    };
    const before = await count(PLATFORM);
    await asSystem(async (tx) => {
      // The stage policy checks that the submitter is the acting actor.
      await tx.unsafe(`SET LOCAL caelo.actor_id = '${SYSTEM_ACTOR_ID}'`);
      await tx`INSERT INTO plugin_installation_versions
                 (plugin_id, artifact_digest, manifest_json, source_code, origin, submitted_by)
               SELECT id, ${"a".repeat(64)}, '{"version":"0.3.0"}'::jsonb, '', 'external-package',
                      ${SYSTEM_ACTOR_ID}::uuid
                 FROM plugins WHERE slug = ${SLUG}`;
    });
    expect(await count(PLATFORM)).toBe(before + 1);
    expect(await count(OWNER)).toBe(before);
  });

  it("says the change is unknown rather than guessing when no manifest was recorded", async () => {
    await stopByUpgrade();
    await asSystem(
      (tx) => tx`UPDATE plugins SET approved_manifest_json = NULL WHERE slug = ${SLUG}`,
    );
    expect((await waiting())?.changes).toBeNull();
  });

  it("the AI's card shows the server's text, and only the click applies it", async () => {
    await stopByUpgrade();
    const release = await waiting();
    if (!release) throw new Error("nothing waits");
    const input = { slug: SLUG, manifestDigest: release.manifestDigest };
    const ai: ExecutionContext = { ...OWNER, actorKind: "ai" };

    const preview = await execute(registry, adapter, ai, "plugins.preview_approve_release", input);
    if (!preview.ok) throw new Error(JSON.stringify(preview.error));
    expect((preview.value as { preview: string }).preview).toContain("Background jobs:");

    const stale = await execute(registry, adapter, ai, "plugins.propose_approve_release", {
      slug: SLUG,
      manifestDigest: "f".repeat(64),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect("message" in stale.error && stale.error.message).toContain(release.manifestDigest);
    }

    const proposed = await execute(registry, adapter, ai, "plugins.propose_approve_release", input);
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const { proposalId } = proposed.value as { proposalId: string };

    const self = await execute(registry, adapter, ai, "plugins.execute_proposal", { proposalId });
    expect(self.ok).toBe(false);
    expect(await waiting()).toBeDefined();

    const applied = await execute(registry, adapter, PLATFORM, "plugins.execute_proposal", {
      proposalId,
    });
    if (!applied.ok) throw new Error(JSON.stringify(applied.error));
    expect(await waiting()).toBeUndefined();
    expect((await loadActivatedPlugin(SLUG)).loaded).toBe(true);
  });

  it("an approval does not wait for a proposal another approval is applying", async () => {
    await stopByUpgrade();
    const release = await waiting();
    if (!release) throw new Error("nothing waits");
    const input = { slug: SLUG, manifestDigest: release.manifestDigest };
    const ai: ExecutionContext = { ...OWNER, actorKind: "ai" };
    const proposed = await execute(registry, adapter, ai, "plugins.propose_approve_release", input);
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const { proposalId } = proposed.value as { proposalId: string };
    const sql = new SQL(ADMIN_URL as string);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`SELECT 1 FROM plugin_pending_actions WHERE id = ${proposalId}::uuid FOR UPDATE`;
        const approved = await execute(
          registry,
          adapter,
          PLATFORM,
          "plugins.approve_capabilities",
          input,
        );
        if (!approved.ok) throw new Error(JSON.stringify(approved.error));
      });
    } finally {
      await sql.end();
    }
    expect(await waiting()).toBeUndefined();
  });

  it("an approval made elsewhere closes the card that asked for it", async () => {
    await stopByUpgrade();
    const release = await waiting();
    if (!release) throw new Error("nothing waits");
    const input = { slug: SLUG, manifestDigest: release.manifestDigest };
    const ai: ExecutionContext = { ...OWNER, actorKind: "ai" };
    const proposed = await execute(registry, adapter, ai, "plugins.propose_approve_release", input);
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const approved = await execute(
      registry,
      adapter,
      PLATFORM,
      "plugins.approve_capabilities",
      input,
    );
    if (!approved.ok) throw new Error(JSON.stringify(approved.error));
    const again = await execute(registry, adapter, PLATFORM, "plugins.execute_proposal", {
      proposalId: (proposed.value as { proposalId: string }).proposalId,
    });
    expect(again.ok).toBe(false);
  });
});

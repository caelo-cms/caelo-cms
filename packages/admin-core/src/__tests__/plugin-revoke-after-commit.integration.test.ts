// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #585 — revoking a running plugin's grant stops it in the running
 * host only once the revoke has COMMITTED. Before the fix the hot-disable
 * ran inside the transaction: a rollback left the host disabled while the
 * database still said active (and the grant still existed).
 *
 * Covered paths: the direct Owner op (`plugins.revoke_capability`), the
 * §11.A approval of an AI revoke proposal (`plugins.execute_proposal`,
 * kind `revoke_capability`), and `plugins.disable`. The uninstall twin
 * lives in plugin-lifecycle.integration.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, isPluginDisabled, resetPluginHost } from "@caelo-cms/plugin-host";
import {
  DatabaseAdapter,
  execute,
  type OperationDefinition,
  OperationRegistry,
} from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { lockPluginRow } from "../locks.js";
import { revokePluginCapabilityOp } from "../ops/plugins/installations.js";
import { disablePluginOp } from "../ops/plugins/registry.js";
import { executeUninstallPluginOp } from "../ops/plugins/uninstall.js";
import { registerAdminOps } from "../register.js";

let adapter: DatabaseAdapter;
let pluginsRoot: string;
const registry = new OperationRegistry();
const system: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t585",
};
const ai: ExecutionContext = { ...system, actorKind: "ai" };

function manifestFor(slug: string) {
  return {
    slug,
    version: "1.0.0",
    tier: 2,
    schema: {},
    adminSchema: { notes: { body: "text" } },
    operations: ["save"],
    requestedCapabilities: ["cms_admin_schema"],
    capabilityReasons: { cms_admin_schema: "Keep unpublished authoring notes private" },
  };
}
const sourceFor = (slug: string) =>
  `export default {slug:"${slug}",version:"1.0.0",tier:2,operations:{save:async()=>null}};`;

async function call(name: string, input: unknown, ctx: ExecutionContext = system) {
  const result = await execute(registry, adapter, ctx, name, input);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function owner(): Promise<ExecutionContext> {
  const id = crypto.randomUUID();
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors (id,kind,display_name) VALUES (${id}::uuid,'human','t585 owner')`,
    );
    await tx.execute(
      sql`INSERT INTO users (id,email,password_hash) VALUES (${id}::uuid,${`${id}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles (user_id,role_id) SELECT ${id}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  return { ...system, actorId: id, actorKind: "human" };
}

/** Stage, approve and finalize a Tier 2 package: an `active` plugin whose
 *  running version holds one `cms_admin_schema` grant. */
async function runningPlugin(slug: string, approver: ExecutionContext) {
  const staged = (await call("plugins.stage_installation", {
    manifest: manifestFor(slug),
    source: sourceFor(slug),
  })) as { installationId: string; pluginId: string; artifactDigest: string };
  const reviews = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  const review = reviews.installations.find((row) => row.id === staged.installationId);
  if (!review) throw new Error("review missing");
  const approved = (await call(
    "plugins.approve_installation",
    {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest: review.currentStateDigest,
      capabilities: ["cms_admin_schema"],
    },
    approver,
  )) as { grantIds: string[] };
  await call("plugins.finalize_installation", {
    installationId: staged.installationId,
    artifactDigest: staged.artifactDigest,
    grantIds: approved.grantIds,
  });
  return staged;
}

async function storedState(pluginId: string) {
  return adapter.withAdminTransaction(system, async (tx) => {
    const plugin = (await tx.execute(
      sql`SELECT status FROM plugins WHERE id = ${pluginId}::uuid`,
    )) as unknown as { status: string }[];
    const grants = (await tx.execute(
      sql`SELECT count(*)::int AS n FROM plugin_capability_grants WHERE plugin_id = ${pluginId}::uuid AND revoked_at IS NULL`,
    )) as unknown as { n: number }[];
    return { status: plugin[0]?.status, activeGrants: grants[0]?.n };
  });
}

/** Run `op`'s handler inside an adapter transaction that then rolls back. */
async function rolledBack<I, O>(op: OperationDefinition<I, O>, ctx: ExecutionContext, input: I) {
  await expect(
    adapter.withAdminTransaction(ctx, async (tx) => {
      const r = await op.handler(ctx, input, tx);
      if (!r.ok) throw new Error(`handler refused: ${JSON.stringify(r.error)}`);
      throw new Error("forced rollback");
    }),
  ).rejects.toThrow("forced rollback");
}

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-t585-"));
  await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot,
    systemActorId: system.actorId,
  });
});

afterAll(async () => {
  resetPluginHost();
  await rm(pluginsRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("#585 — plugin host state follows the commit", () => {
  it("direct revoke: a rollback keeps the plugin running, a commit stops it after the commit", async () => {
    const approver = await owner();
    const p = await runningPlugin("t585-direct", approver);
    const input = { installationId: p.installationId, capability: "cms_admin_schema" as const };

    await rolledBack(revokePluginCapabilityOp, approver, input);
    expect(isPluginDisabled("t585-direct")).toBe(false);
    expect(await storedState(p.pluginId)).toEqual({ status: "active", activeGrants: 1 });

    // Inside a transaction that does commit, the host is untouched until
    // the commit; the op result arrives with the host already stopped.
    await adapter.withAdminTransaction(approver, async (tx) => {
      const r = await revokePluginCapabilityOp.handler(approver, input, tx);
      expect(r.ok).toBe(true);
      expect(isPluginDisabled("t585-direct")).toBe(false);
    });
    expect(isPluginDisabled("t585-direct")).toBe(true);
    expect(await storedState(p.pluginId)).toEqual({ status: "disabled", activeGrants: 0 });
  });

  it("direct revoke through the Query API stops the plugin once execute returns", async () => {
    const approver = await owner();
    const p = await runningPlugin("t585-execute", approver);
    expect(
      await call(
        "plugins.revoke_capability",
        { installationId: p.installationId, capability: "cms_admin_schema" },
        approver,
      ),
    ).toEqual({ slug: "t585-execute", disabled: true });
    expect(isPluginDisabled("t585-execute")).toBe(true);
  });

  it("approved AI revoke proposal: a rollback keeps the plugin running, a commit stops it", async () => {
    const approver = await owner();
    const p = await runningPlugin("t585-proposal", approver);
    const proposed = (await call(
      "plugins.propose_revoke_capability",
      { slug: "t585-proposal", capability: "cms_admin_schema" },
      ai,
    )) as { proposalId: string; preview: { disablesPlugin: boolean } };
    expect(proposed.preview.disablesPlugin).toBe(true);

    await rolledBack(executeUninstallPluginOp, approver, { proposalId: proposed.proposalId });
    expect(isPluginDisabled("t585-proposal")).toBe(false);
    expect(await storedState(p.pluginId)).toEqual({ status: "active", activeGrants: 1 });

    expect(
      await call("plugins.execute_proposal", { proposalId: proposed.proposalId }, approver),
    ).toEqual({ slug: "t585-proposal", revokedCapability: "cms_admin_schema", disabled: true });
    expect(isPluginDisabled("t585-proposal")).toBe(true);
    expect(await storedState(p.pluginId)).toEqual({ status: "disabled", activeGrants: 0 });
  });

  it("plugins.disable: a rollback keeps the plugin running, a commit stops it", async () => {
    const approver = await owner();
    const p = await runningPlugin("t585-disable", approver);
    await rolledBack(disablePluginOp, approver, { slug: "t585-disable" });
    expect(isPluginDisabled("t585-disable")).toBe(false);
    expect((await storedState(p.pluginId)).status).toBe("active");

    await call("plugins.disable", { slug: "t585-disable" }, approver);
    expect(isPluginDisabled("t585-disable")).toBe(true);
  });
});

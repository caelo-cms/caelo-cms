// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin lifecycle steps that used to be Owner-panel-only, against a real
 * Postgres:
 *
 * - capability revoke as a §11.A proposal: the AI reads the grants and
 *   proposes; it cannot apply; an approver without `plugins.install` cannot
 *   apply; the Owner's approve revokes + disables through
 *   `plugins.execute_proposal`, both directly and through the chat's gated
 *   execute; the queue ops list / reject / cancel the rows;
 * - `plugins.execute_proposal` refuses an activation row instead of running
 *   the uninstall path on it;
 * - reject / revalidate are AI-callable for a submission that is not
 *   running, and revalidate refuses a running plugin for the AI.
 *
 * Installation fixtures go through the real stage → approve → finalize ops
 * (no Deno needed: nothing is loaded into a sandbox here).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { attachGatedExecute } from "../ai/tools/gated-tools.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";

let adapter: DatabaseAdapter;
const registry = new OperationRegistry();
const RUN = crypto.randomUUID().slice(0, 8);
const system: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "plugin-owner-tools-test",
};
const ai: ExecutionContext = { ...system, actorKind: "ai", requestId: "plugin-owner-tools-ai" };

const manifestFor = (slug: string) => ({
  slug,
  version: "1.0.0",
  tier: 2,
  schema: {},
  adminSchema: { notes: { body: "text" } },
  operations: ["save"],
  requestedCapabilities: ["cms_admin_schema"],
  capabilityReasons: { cms_admin_schema: "Keep unpublished authoring notes private" },
});
const sourceFor = (slug: string) =>
  `export default {slug:"${slug}",version:"1.0.0",tier:2,operations:{save:async()=>null}};`;

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
});
afterAll(async () => {
  await adapter.close();
});

async function call<T>(name: string, input: unknown, ctx: ExecutionContext = system): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function user(role: string): Promise<ExecutionContext> {
  const id = crypto.randomUUID();
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors (id,kind,display_name) VALUES (${id}::uuid,'human',${role})`,
    );
    await tx.execute(
      sql`INSERT INTO users (id,email,password_hash) VALUES (${id}::uuid,${`${id}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles (user_id,role_id) SELECT ${id}::uuid,id FROM roles WHERE name=${role}`,
    );
  });
  return { ...system, actorId: id, actorKind: "human" };
}

/** A runtime-installed plugin whose `cms_admin_schema` grant is on the running version. */
async function runningInstallation(label: string) {
  const slug = `owner-tools-${label}-${RUN}`;
  const staged = await call<{ installationId: string; pluginId: string; artifactDigest: string }>(
    "plugins.stage_installation",
    { manifest: manifestFor(slug), source: sourceFor(slug) },
  );
  const list = await call<{ installations: { id: string; currentStateDigest: string }[] }>(
    "plugins.list_installations",
    {},
  );
  const expectedStateDigest = list.installations.find(
    (i) => i.id === staged.installationId,
  )?.currentStateDigest;
  const owner = await user("owner");
  const approved = await call<{ grantIds: string[] }>(
    "plugins.approve_installation",
    {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest,
      capabilities: ["cms_admin_schema"],
    },
    owner,
  );
  await call("plugins.finalize_installation", {
    installationId: staged.installationId,
    artifactDigest: staged.artifactDigest,
    grantIds: approved.grantIds,
  });
  return { slug, owner, ...staged };
}

async function pluginStatus(slug: string): Promise<string> {
  const v = await call<{ plugin: { status: string } }>("plugins.get", { slug });
  return v.plugin.status;
}

async function rowStatus(id: string): Promise<string | undefined> {
  const rows = (await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(sql`SELECT status FROM plugin_pending_actions WHERE id = ${id}::uuid`),
  )) as unknown as { status: string }[];
  return rows[0]?.status;
}

describe("propose_revoke_plugin_capability", () => {
  it("AI reads the grant, proposes; only an Owner with plugins.install applies it", async () => {
    const inst = await runningInstallation("revoke");
    const grants = await call<{ grants: { capability: string; installationStatus: string }[] }>(
      "plugins.list_capability_grants",
      { slug: inst.slug },
      ai,
    );
    expect(grants.grants).toEqual([
      expect.objectContaining({ capability: "cms_admin_schema", installationStatus: "active" }),
    ]);

    const proposed = await call<{ proposalId: string; preview: { disablesPlugin: boolean } }>(
      "plugins.propose_revoke_capability",
      { slug: inst.slug, capability: "cms_admin_schema" },
      ai,
    );
    expect(proposed.preview.disablesPlugin).toBe(true);
    const queue = await call<{ proposals: { id: string; kind: string }[] }>(
      "plugins.list_pending_actions",
      {},
      ai,
    );
    expect(queue.proposals).toContainEqual(
      expect.objectContaining({ id: proposed.proposalId, kind: "revoke_capability" }),
    );

    const byAi = await execute(registry, adapter, ai, "plugins.execute_proposal", {
      proposalId: proposed.proposalId,
    });
    expect(byAi.ok).toBe(false);
    const editor = await user("editor");
    const byEditor = await execute(registry, adapter, editor, "plugins.execute_proposal", {
      proposalId: proposed.proposalId,
    });
    expect(byEditor.ok).toBe(false);
    expect(await rowStatus(proposed.proposalId)).toBe("pending");

    const applied = await call<{ slug: string; revokedCapability: string; disabled: boolean }>(
      "plugins.execute_proposal",
      { proposalId: proposed.proposalId },
      inst.owner,
    );
    expect(applied).toEqual({
      slug: inst.slug,
      revokedCapability: "cms_admin_schema",
      disabled: true,
    });
    expect(await pluginStatus(inst.slug)).toBe("disabled");
    expect(await rowStatus(proposed.proposalId)).toBe("applied");
    const after = await call<{ grants: unknown[] }>(
      "plugins.list_capability_grants",
      { slug: inst.slug },
      ai,
    );
    expect(after.grants).toHaveLength(0);
  });

  it("refuses a capability the plugin does not hold", async () => {
    const inst = await runningInstallation("nogrant");
    const r = await execute(registry, adapter, ai, "plugins.propose_revoke_capability", {
      slug: inst.slug,
      capability: "image_generation",
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("nothing to revoke");
  });

  it("the chat's gated execute applies it end to end after the Approve", async () => {
    const inst = await runningInstallation("gated");
    const tool = createDefaultToolRegistry()
      .catalogue()
      .find((t) => t.name === "propose_revoke_plugin_capability");
    expect(tool?.gated).toEqual({
      proposeOp: "plugins.propose_revoke_capability",
      executeOp: "plugins.execute_proposal",
    });
    if (!tool) throw new Error("tool not registered");
    const gated = attachGatedExecute(tool, registry, adapter, ai, inst.owner);
    const out = (await gated.execute?.({ slug: inst.slug, capability: "cms_admin_schema" })) as {
      ok: boolean;
      value?: { disabled: boolean };
    };
    expect(out).toEqual({ ok: true, value: expect.objectContaining({ disabled: true }) });
    expect(await pluginStatus(inst.slug)).toBe("disabled");
  });

  it("Owner reject and AI cancel both close a pending row", async () => {
    const inst = await runningInstallation("queue");
    const a = await call<{ proposalId: string }>(
      "plugins.propose_revoke_capability",
      { slug: inst.slug, capability: "cms_admin_schema", reason: "first" },
      ai,
    );
    await call("plugins.reject_proposal", { proposalId: a.proposalId, reason: "no" }, inst.owner);
    expect(await rowStatus(a.proposalId)).toBe("rejected");
    const b = await call<{ proposalId: string }>(
      "plugins.propose_revoke_capability",
      { slug: inst.slug, capability: "cms_admin_schema", reason: "second" },
      ai,
    );
    const cancelled = await call<{ domain: string }>(
      "pending_proposals.cancel",
      { proposalId: b.proposalId },
      ai,
    );
    expect(cancelled.domain).toBe("plugins");
    expect(await rowStatus(b.proposalId)).toBe("cancelled");
    expect(await pluginStatus(inst.slug)).toBe("active");
  });
});

describe("plugins.execute_proposal kind guard", () => {
  it("refuses an activation row instead of running the uninstall path on it", async () => {
    const inst = await runningInstallation("kindguard");
    const rows = (await adapter.withAdminTransaction(system, (tx) =>
      tx.execute(sql`
        INSERT INTO plugin_pending_actions
          (kind, proposed_by, plugin_id, payload, preview, status, payload_hash)
        VALUES ('activate', ${system.actorId}::uuid, ${inst.pluginId}::uuid,
                ${JSON.stringify({ slug: inst.slug, pluginId: inst.pluginId })}::jsonb,
                '{}'::jsonb, 'pending', ${`kindguard-${RUN}`})
        RETURNING id::text AS id`),
    )) as unknown as { id: string }[];
    const id = rows[0]?.id ?? "";
    const r = await execute(registry, adapter, inst.owner, "plugins.execute_proposal", {
      proposalId: id,
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("'activate' action");
    expect(await pluginStatus(inst.slug)).toBe("active");
  });
});

describe("reject_plugin / revalidate_plugin for the AI", () => {
  it("rejects a submission, re-files it, and refuses to revalidate a running plugin", async () => {
    const slug = `owner-tools-submit-${RUN}`;
    const { adminSchema: _a, capabilityReasons: _c, ...manifest } = manifestFor(slug);
    await call(
      "plugins.submit",
      {
        slug,
        version: "1.0.0",
        manifest: { ...manifest, requestedCapabilities: [] },
        source: sourceFor(slug),
      },
      ai,
    );
    await call("plugins.reject", { slug, reason: "operator changed their mind" }, ai);
    expect(await pluginStatus(slug)).toBe("rejected");

    const re = await call<{ status: string }>("plugins.revalidate", { slug }, ai);
    expect(["awaiting_activation", "draft"]).toContain(re.status);
    expect(await pluginStatus(slug)).toBe(re.status);

    await adapter.withAdminTransaction(system, (tx) =>
      tx.execute(sql`UPDATE plugins SET status = 'active' WHERE slug = ${slug}`),
    );
    const running = await execute(registry, adapter, ai, "plugins.revalidate", { slug });
    expect(running.ok).toBe(false);
    expect(await pluginStatus(slug)).toBe("active");
    await adapter.withAdminTransaction(system, (tx) =>
      tx.execute(sql`DELETE FROM plugins WHERE slug = ${slug}`),
    );
  });
});

// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  loadedPlugins,
  pluginToolsRegistry,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { withExternalAuthorization } from "../../../plugin-host/src/external-authorization.js";
import { attachPluginGatedExecute } from "../ai/tools/gated-tools.js";
import { submitPluginTool } from "../ai/tools/submit-plugin.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";

let adapter: DatabaseAdapter;
let pluginsRoot: string;
const registry = new OperationRegistry();
const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "installation-receipts-test",
};
const manifest = {
  slug: "installation-notes",
  version: "1.0.0",
  tier: 2,
  schema: {},
  adminSchema: { notes: { body: "text" } },
  operations: ["save"],
  requestedCapabilities: ["cms_admin_schema"],
  capabilityReasons: { cms_admin_schema: "Keep unpublished authoring notes private" },
};
const source =
  'export default {slug:"installation-notes",version:"1.0.0",tier:2,operations:{save:async()=>null}};';
beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(sql`DROP SCHEMA IF EXISTS plugin_external_private_notes CASCADE`),
  );
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-grants-test-"));
  await bootstrap({ infra: { adapter, registry }, pluginsRoot, systemActorId: system.actorId });
});
afterAll(async () => {
  resetPluginHost();
  await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(sql`DROP SCHEMA IF EXISTS plugin_external_private_notes CASCADE`),
  );
  await rm(pluginsRoot, { recursive: true, force: true });
  await adapter.close();
});

it("stages immutable updates without changing active source or issuing AI-owned receipts", async () => {
  const first = await execute(
    registry,
    adapter,
    { ...system, actorKind: "ai" },
    "plugins.stage_installation",
    { manifest, source },
  );
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  const initial = first.value as {
    installationId: string;
    pluginId: string;
    artifactDigest: string;
  };
  await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(sql`UPDATE plugins SET status = 'active' WHERE id = ${initial.pluginId}::uuid`),
  );
  const replacement = await execute(registry, adapter, system, "plugins.stage_installation", {
    manifest,
    source: `${source}\n// new artifact`,
  });
  expect(replacement.ok).toBe(true);
  const current = await execute(registry, adapter, system, "plugins.get", { slug: manifest.slug });
  if (!current.ok) throw new Error(JSON.stringify(current.error));
  expect(
    (current.value as { plugin: { sourceCode: string; status: string } }).plugin,
  ).toMatchObject({ sourceCode: source, status: "active" });
  await expect(
    adapter.withAdminTransaction(system, (tx) =>
      tx.execute(
        sql`UPDATE plugin_installation_versions SET source_code = 'changed' WHERE id = ${initial.installationId}::uuid`,
      ),
    ),
  ).rejects.toThrow();
  await expect(
    adapter.withAdminTransaction({ ...system, actorKind: "ai" }, (tx) =>
      tx.execute(sql`
    INSERT INTO plugin_capability_grants (plugin_id, artifact_digest, capability, approved_by)
    VALUES (${initial.pluginId}::uuid, ${initial.artifactDigest}, 'cms_admin_schema', ${system.actorId}::uuid)
  `),
    ),
  ).rejects.toThrow();
  const grants = await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(
      sql`SELECT id FROM plugin_capability_grants WHERE plugin_id = ${initial.pluginId}::uuid`,
    ),
  );
  expect(grants).toHaveLength(0);
});

async function call(
  name: string,
  input: unknown,
  ctx = system as { actorId: string; actorKind: "system" | "human" | "ai"; requestId: string },
) {
  const result = await execute(registry, adapter, ctx, name, input);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}
async function user(role: string) {
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
  return { ...system, actorId: id, actorKind: "human" as const };
}
async function stage(label: string) {
  const slug = `installation-${label}`;
  return (await call("plugins.stage_installation", {
    manifest: { ...manifest, slug },
    source: source.replaceAll(manifest.slug, slug),
  })) as { installationId: string; pluginId: string; artifactDigest: string };
}
async function review(installationId: string) {
  const result = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  const item = result.installations.find((row) => row.id === installationId);
  if (!item) throw new Error("Review missing");
  return item.currentStateDigest;
}
async function decision(item: Awaited<ReturnType<typeof stage>>) {
  return {
    installationId: item.installationId,
    artifactDigest: item.artifactDigest,
    expectedStateDigest: await review(item.installationId),
    capabilities: ["cms_admin_schema"],
  };
}

it("allows Owner approval but denies AI, editor and moderation-only reviewer", async () => {
  const item = await stage("authority");
  const input = await decision(item);
  for (const ctx of [
    { ...system, actorKind: "ai" as const },
    await user("editor"),
    await user("reviewer"),
  ]) {
    const result = await execute(registry, adapter, ctx, "plugins.approve_installation", input);
    expect(result.ok).toBe(false);
    const raw = await adapter.withAdminTransaction(ctx, (tx) =>
      tx.execute(
        sql`UPDATE plugin_installation_versions SET status='approved' WHERE id=${item.installationId}::uuid RETURNING id`,
      ),
    );
    expect(raw).toHaveLength(0);
  }
  const owner = await user("owner");
  const approved = (await call("plugins.approve_installation", input, owner)) as {
    grantIds: string[];
  };
  expect(approved.grantIds).toHaveLength(1);
  const current = (await call("plugins.get", { slug: "installation-authority" })) as {
    plugin: { status: string };
  };
  expect(current.plugin.status).toBe("awaiting_activation");
  const receipts = await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(
      sql`SELECT approved_by::text AS approved_by, capability FROM plugin_capability_grants WHERE plugin_id=${item.pluginId}::uuid`,
    ),
  );
  expect(receipts).toMatchObject([{ approved_by: owner.actorId, capability: "cms_admin_schema" }]);
});

it("rejects omitted capabilities, changed artifacts and stale review state without granting access", async () => {
  const item = await stage("stale");
  const input = await decision(item);
  const owner = await user("owner");
  for (const altered of [
    { ...input, capabilities: [] },
    { ...input, artifactDigest: "0".repeat(64) },
    { ...input, capabilities: ["cms_admin_schema", "cms_admin_schema"] },
  ]) {
    expect(
      (await execute(registry, adapter, owner, "plugins.approve_installation", altered)).ok,
    ).toBe(false);
  }
  await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(
      sql`UPDATE plugins SET status='disabled', updated_at=now() WHERE id=${item.pluginId}::uuid`,
    ),
  );
  expect((await execute(registry, adapter, owner, "plugins.approve_installation", input)).ok).toBe(
    false,
  );
  const receipts = await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(sql`SELECT id FROM plugin_capability_grants WHERE plugin_id=${item.pluginId}::uuid`),
  );
  expect(receipts).toHaveLength(0);
});

it("requires exact current receipts for host finalization and disables the active version on revocation", async () => {
  const item = await stage("lifecycle");
  const owner = await user("owner");
  const approved = (await call("plugins.approve_installation", await decision(item), owner)) as {
    grantIds: string[];
  };
  const finalization = {
    installationId: item.installationId,
    artifactDigest: item.artifactDigest,
    grantIds: approved.grantIds,
  };
  expect(
    (await execute(registry, adapter, owner, "plugins.finalize_installation", finalization)).ok,
  ).toBe(false);
  expect(
    (
      await execute(registry, adapter, system, "plugins.finalize_installation", {
        ...finalization,
        grantIds: [],
      })
    ).ok,
  ).toBe(false);
  await call("plugins.finalize_installation", finalization);
  const current = (await call("plugins.get", { slug: "installation-lifecycle" })) as {
    plugin: { status: string };
  };
  expect(current.plugin.status).toBe("active");
  const otherOwner = await user("owner");
  expect(
    await call(
      "plugins.revoke_capability",
      { installationId: item.installationId, capability: "cms_admin_schema" },
      otherOwner,
    ),
  ).toEqual({ slug: "installation-lifecycle", disabled: true });
  expect(
    (await execute(registry, adapter, system, "plugins.finalize_installation", finalization)).ok,
  ).toBe(false);
  const fresh = (await call("plugins.approve_installation", await decision(item), owner)) as {
    grantIds: string[];
  };
  expect(fresh.grantIds).not.toEqual(approved.grantIds);
  expect(
    (await execute(registry, adapter, system, "plugins.finalize_installation", finalization)).ok,
  ).toBe(false);
  await expect(
    adapter.withAdminTransaction(system, (tx) =>
      tx.execute(
        sql`UPDATE plugin_capability_grants SET revoked_at=NULL, revoked_by=NULL WHERE id=${approved.grantIds[0]}::bigint`,
      ),
    ),
  ).rejects.toThrow();
});

it("revoking a pending update preserves the active version and cancels its preparation", async () => {
  const item = await stage("update");
  const owner = await user("owner");
  const approved = (await call("plugins.approve_installation", await decision(item), owner)) as {
    grantIds: string[];
  };
  await call("plugins.finalize_installation", {
    installationId: item.installationId,
    artifactDigest: item.artifactDigest,
    grantIds: approved.grantIds,
  });
  const next = (await call("plugins.stage_installation", {
    manifest: { ...manifest, slug: "installation-update", version: "1.0.1" },
    source: `${source.replaceAll(manifest.slug, "installation-update")}\n// update`,
  })) as Awaited<ReturnType<typeof stage>>;
  const nextApproval = (await call(
    "plugins.approve_installation",
    await decision(next),
    owner,
  )) as { grantIds: string[] };
  expect(
    await call(
      "plugins.revoke_capability",
      { installationId: next.installationId, capability: "cms_admin_schema" },
      owner,
    ),
  ).toEqual({ slug: "installation-update", disabled: false });
  expect(
    (
      await execute(registry, adapter, system, "plugins.finalize_installation", {
        installationId: next.installationId,
        artifactDigest: next.artifactDigest,
        grantIds: nextApproval.grantIds,
      })
    ).ok,
  ).toBe(false);
  const current = (await call("plugins.get", { slug: "installation-update" })) as {
    plugin: { status: string; version: string };
  };
  expect(current.plugin).toMatchObject({ status: "active", version: "1.0.0" });
});

it("stages AI-authored capability packages through the author tool without activating them", async () => {
  const authored = { ...manifest, slug: "ai-private-notes" };
  const result = await submitPluginTool.handler(
    { ...system, actorKind: "ai" },
    {
      slug: authored.slug,
      version: authored.version,
      manifest: authored,
      source: source.replaceAll(manifest.slug, authored.slug),
    },
    { adapter, registry } as Parameters<typeof submitPluginTool.handler>[2],
  );
  expect(result.ok).toBe(true);
  expect(result.content).toContain("/security/plugins/installations");
  const review = (await call("plugins.list_installations", {})) as {
    installations: { slug: string; status: string; origin: string }[];
  };
  expect(review.installations.find((i) => i.slug === authored.slug)).toMatchObject({
    status: "pending",
    origin: "runtime-authored",
  });
  expect(loadedPlugins.bySlug(authored.slug)).toBeUndefined();
});

it("runs approved author tools in Deno with private storage, trusted chat identity and restart/revocation checks", async () => {
  const slug = "external-private-notes";
  const privateManifest = {
    ...manifest,
    slug,
    operations: ["save", "read", "identity", "public_probe", "approved_save"],
    publicOperations: ["public_probe"],
    requestedCapabilities: ["cms_admin_schema", "chat_runner_tools"],
    capabilityReasons: {
      ...manifest.capabilityReasons,
      chat_runner_tools: "Let authors save private notes from the CMS chat",
    },
    tools: [
      {
        name: "external_private_notes__save",
        operationName: "save",
        description: "Save a private note",
        inputJsonSchema: {
          type: "object",
          properties: { body: { type: "string" } },
          required: ["body"],
          additionalProperties: false,
        },
      },
    ],
  };
  privateManifest.tools.push({
    ...privateManifest.tools[0]!,
    name: "external_private_notes__approved_save",
    operationName: "approved_save",
    approvalMode: "user-approval",
  } as (typeof privateManifest.tools)[number]);
  const privateSource = `export default {slug:"${slug}",version:"1.0.0",tier:2,operations:{
    save:async(ctx,args)=>ctx.adminQuery.insert("notes",{body:args.body}),
    approved_save:async(ctx,args)=>ctx.adminQuery.insert("notes",{body:args.body}),
    read:async(ctx)=>ctx.adminQuery.list("notes"),
    identity:async(ctx)=>ctx.invocation,
    public_probe:async(ctx)=>({privateAccess:!!ctx.adminQuery,identity:ctx.invocation??null})
  }};`;
  const item = (await call("plugins.stage_installation", {
    manifest: privateManifest,
    source: privateSource,
  })) as Awaited<ReturnType<typeof stage>>;
  const owner = await user("owner");
  const actor = { ...system, actorKind: "ai" as const, chatBranchId: crypto.randomUUID() };
  const authorContext = { actor, operatorActorId: owner.actorId };
  expect((await activateApprovedExternalPlugin(item.installationId)).loaded).toBe(false);
  // Existing activation APIs must not bypass the individual grants.
  expect((await execute(registry, adapter, owner, "plugins.prepare_activation", { slug })).ok).toBe(
    false,
  );
  expect(
    (
      await execute(registry, adapter, owner, "plugins.activate", {
        slug,
        artifactDigest: item.artifactDigest,
      })
    ).ok,
  ).toBe(false);
  await call(
    "plugins.approve_installation",
    { ...(await decision(item)), capabilities: privateManifest.requestedCapabilities },
    owner,
  );
  expect(await activateApprovedExternalPlugin(item.installationId)).toEqual({ loaded: true });
  expect(pluginToolsRegistry.resolve("external_private_notes__save")?.pluginSlug).toBe(slug);
  const saved = await runPluginOperation({
    pluginSlug: slug,
    operationName: "save",
    args: { body: "unpublished" },
    authorContext,
  });
  expect(saved.ok).toBe(true);
  expect(
    (
      await runPluginOperation({
        pluginSlug: slug,
        operationName: "save",
        args: { body: 123 },
        authorContext,
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await runPluginOperation({
        pluginSlug: slug,
        operationName: "approved_save",
        args: { body: "needs approval" },
        authorContext,
      })
    ).ok,
  ).toBe(false);
  // Simulate a finalized artifact whose in-memory registration was lost after a load failure.
  loadedPlugins.unload(slug);
  expect(await activateApprovedExternalPlugin(item.installationId)).toEqual({ loaded: true });
  expect(loadedPlugins.bySlug(slug)).toBeDefined();
  const gatedTool = () =>
    attachPluginGatedExecute(
      {
        name: "external_private_notes__approved_save",
        description: "Save after approval",
        inputSchema: privateManifest.tools[0]!.inputJsonSchema,
        pluginGated: { pluginSlug: slug, operationName: "approved_save" },
      },
      authorContext,
    );
  const originalTool = gatedTool();
  const approvedArgs = { body: "approved" };
  expect(await originalTool.execute!(approvedArgs, { toolCallId: "missing" })).toMatchObject({
    ok: false,
  });
  await originalTool.prepareApproval!("approved-call", approvedArgs);
  await originalTool.prepareApproval!("approved-call", approvedArgs); // idempotent retry
  await expect(originalTool.prepareApproval!("approved-call", { body: "changed" })).rejects.toThrow(
    "BindingChanged",
  );
  expect(
    await originalTool.execute!({ body: "changed" }, { toolCallId: "approved-call" }),
  ).toMatchObject({ ok: false });
  expect(await originalTool.execute!(approvedArgs, { toolCallId: "approved-call" })).toMatchObject({
    ok: true,
  });
  await originalTool.prepareApproval!("restart-call", { body: "after restart" });
  await originalTool.prepareApproval!("stale-call", { body: "must never execute" });
  await expect(
    adapter.withAdminTransaction(actor, (tx) =>
      tx.execute(sql`
    INSERT INTO plugin_tool_approval_bindings (plugin_id,chat_branch_id,tool_call_id,operator_actor_id,binding_digest)
    VALUES (${loadedPlugins.bySlug(slug)!.pluginId}::uuid,${actor.chatBranchId}::uuid,'forged',${owner.actorId}::uuid,${"a".repeat(64)})
  `),
    ),
  ).rejects.toThrow();
  expect(
    await adapter.withAdminTransaction(actor, (tx) =>
      tx.execute(sql`
    SELECT * FROM plugin_tool_approval_bindings
  `),
    ),
  ).toHaveLength(0);

  const identity = await runPluginOperation({
    pluginSlug: slug,
    operationName: "identity",
    args: { actorId: "forged", chatBranchId: "forged" },
    authorContext,
  });
  expect(identity).toEqual({
    ok: true,
    value: {
      actorId: actor.actorId,
      operatorActorId: owner.actorId,
      chatBranchId: actor.chatBranchId,
    },
  });
  expect(
    await runPluginOperation({
      pluginSlug: slug,
      operationName: "public_probe",
      args: {},
      visitorContext: { visitorId: "test-visitor", sessionToken: null },
    }),
  ).toEqual({ ok: true, value: { privateAccess: false, identity: null } });
  expect((await runPluginOperation({ pluginSlug: slug, operationName: "read", args: {} })).ok).toBe(
    false,
  );
  const reviewer = await user("reviewer");
  expect(
    (
      await runPluginOperation({
        pluginSlug: slug,
        operationName: "read",
        args: {},
        authorContext: { actor: reviewer, operatorActorId: reviewer.actorId },
      })
    ).ok,
  ).toBe(false);
  resetPluginHost();
  await bootstrap({ infra: { adapter, registry }, pluginsRoot, systemActorId: system.actorId });
  expect(
    await runPluginOperation({ pluginSlug: slug, operationName: "read", args: {}, authorContext }),
  ).toMatchObject({ ok: true, value: [{ body: "unpublished" }, { body: "approved" }] });
  expect(
    await gatedTool().execute!({ body: "after restart" }, { toolCallId: "restart-call" }),
  ).toMatchObject({ ok: true });
  const wrongBranchTool = attachPluginGatedExecute(originalTool, {
    ...authorContext,
    actor: { ...actor, chatBranchId: crypto.randomUUID() },
  });
  expect(
    await wrongBranchTool.execute!(approvedArgs, { toolCallId: "approved-call" }),
  ).toMatchObject({ ok: false });
  const wrongAuthorTool = attachPluginGatedExecute(originalTool, {
    ...authorContext,
    operatorActorId: reviewer.actorId,
  });
  expect(
    await wrongAuthorTool.execute!(approvedArgs, { toolCallId: "approved-call" }),
  ).toMatchObject({ ok: false });
  configureMcpBridge({ adapter, registry, resolveProvider: async () => null });
  const token = (await call(
    "mcp_tokens.create",
    { displayName: "external-notes-test", scope: "admin" },
    owner,
  )) as { plaintextToken: string };
  const session = (await call("mcp.open_session", {
    plaintextToken: token.plaintextToken,
    title: "Private plugin via MCP",
  })) as { chatSessionId: string };
  const mcpResult = (await call("mcp.execute_tool", {
    plaintextToken: token.plaintextToken,
    chatSessionId: session.chatSessionId,
    toolName: "external_private_notes__save",
    args: { body: "authenticated MCP author" },
  })) as { ok: boolean; content: string };
  expect(mcpResult.ok).toBe(true);
  const mcpNote = JSON.parse(mcpResult.content) as { id: string };
  expect(
    await runPluginOperation({ pluginSlug: slug, operationName: "read", args: {}, authorContext }),
  ).toMatchObject({
    ok: true,
    value: expect.arrayContaining([
      expect.objectContaining({ id: mcpNote.id, body: "authenticated MCP author" }),
    ]),
  });
  const mcpGated = (await call("mcp.execute_tool", {
    plaintextToken: token.plaintextToken,
    chatSessionId: session.chatSessionId,
    toolName: "external_private_notes__approved_save",
    args: { body: "must ask in chat" },
  })) as { ok: boolean; content: string };
  expect(mcpGated.ok).toBe(false);
  expect(mcpGated.content).toContain("in-chat approval");
  const loaded = loadedPlugins.bySlug(slug)!;
  let releaseWrite!: () => void;
  let enteredWrite!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredWrite = resolve;
  });
  const write = withExternalAuthorization(loaded, { adapter, registry }, async (tx) => {
    await tx.execute(
      sql`SELECT set_config('caelo.actor_kind','plugin',true),set_config('caelo.actor_id',${loaded.pluginActorId},true),set_config('caelo.plugin_id',${loaded.pluginId},true)`,
    );
    await tx.execute(
      sql`INSERT INTO plugin_external_private_notes.notes(body) VALUES ('accepted before revocation')`,
    );
    enteredWrite();
    await release;
  });
  await entered;
  const revoked = call(
    "plugins.revoke_capability",
    { installationId: item.installationId, capability: "cms_admin_schema" },
    owner,
  );
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const rows = (await adapter.withAdminTransaction(system, (tx) =>
        tx.execute(
          sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%plugin_installation_versions%' AND query LIKE '%FOR UPDATE%') AS waiting`,
        ),
      )) as unknown as { waiting: boolean }[];
      waiting = rows[0]?.waiting === true;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
  } finally {
    releaseWrite();
  }
  await write;
  await revoked;
  await expect(
    withExternalAuthorization(loaded, { adapter, registry }, async () => {}),
  ).rejects.toThrow("ExternalPluginApprovalChanged");

  expect(
    (await runPluginOperation({ pluginSlug: slug, operationName: "read", args: {}, authorContext }))
      .ok,
  ).toBe(false);
  expect(
    (
      await runPluginOperation({
        pluginSlug: slug,
        operationName: "public_probe",
        args: {},
        visitorContext: { visitorId: "test-visitor", sessionToken: null },
      })
    ).ok,
  ).toBe(false);
  // Reapproval of identical bytes issues fresh receipts: old SDK cards stay stale.
  await call(
    "plugins.approve_installation",
    {
      ...(await decision(item)),
      capabilities: privateManifest.requestedCapabilities,
    },
    owner,
  );
  expect(await activateApprovedExternalPlugin(item.installationId)).toEqual({ loaded: true });
  expect(
    await gatedTool().execute!({ body: "must never execute" }, { toolCallId: "stale-call" }),
  ).toMatchObject({ ok: false });
  await expect(
    gatedTool().prepareApproval!("stale-call", { body: "must never execute" }),
  ).rejects.toThrow("BindingChanged");
  await gatedTool().prepareApproval!("update-call", { body: "old version" });
  const updated = (await call("plugins.stage_installation", {
    manifest: { ...privateManifest, version: "1.0.1" },
    source: privateSource.replace('version:"1.0.0"', 'version:"1.0.1"'),
  })) as Awaited<ReturnType<typeof stage>>;
  await call(
    "plugins.approve_installation",
    {
      ...(await decision(updated)),
      capabilities: privateManifest.requestedCapabilities,
    },
    owner,
  );
  expect(await activateApprovedExternalPlugin(updated.installationId)).toEqual({ loaded: true });
  expect(
    await originalTool.execute!({ body: "old version" }, { toolCallId: "update-call" }),
  ).toMatchObject({ ok: false });
  resetPluginHost();
  await bootstrap({ infra: { adapter, registry }, pluginsRoot, systemActorId: system.actorId });
  expect(
    await gatedTool().execute!({ body: "old version" }, { toolCallId: "update-call" }),
  ).toMatchObject({ ok: false });
  await gatedTool().prepareApproval!("fresh-call", { body: "new version" });
  expect(
    await gatedTool().execute!({ body: "new version" }, { toolCallId: "fresh-call" }),
  ).toMatchObject({ ok: true });
});

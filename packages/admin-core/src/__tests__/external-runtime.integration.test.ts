// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
/** Actual submit → approve → isolated execution → restart → revoke with PostgreSQL. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  loadActivatedPlugin,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { registerAdminOps } from "../register.js";

const system: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "external-runtime-test",
};
const slug = "external-runtime-probe";
const manifest = {
  slug,
  version: "1.0.0",
  tier: 2,
  schema: { notes: { id: "uuid", body: "text" } },
  operations: ["save", "read"],
  publicOperations: ["read"],
  hasStaticRender: false,
};
const source = `import { definePlugin } from "@caelo-cms/plugin-sdk";
export default definePlugin({ slug:"${slug}",version:"1.0.0",tier:2,schema:{},operations:{
 save:async(ctx,args)=>ctx.query.insert("notes",{body:args.body}),
 read:async(ctx)=>ctx.query.list("notes")}});`;
let pluginsRoot: string;
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
async function call(name: string, input: unknown, ctx = system) {
  const result = await execute(registry, adapter, ctx, name, input);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}
async function boot() {
  return bootstrap({
    infra: { adapter, registry },
    pluginsRoot,
    systemActorId: system.actorId,
  });
}
beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-external-test-"));
  await boot();
});
afterAll(async () => {
  resetPluginHost();
  await adapter.close();
  await rm(pluginsRoot, { recursive: true, force: true });
});

describe("external plugin installation", () => {
  it("requires approval, executes with real storage, survives restart and stops after disable", async () => {
    await call(
      "plugins.submit",
      { slug, version: "1.0.0", manifest, source },
      { ...system, actorKind: "ai" },
    );
    expect(
      (await runPluginOperation({ pluginSlug: slug, operationName: "read", args: {} })).ok,
    ).toBe(false);
    const denied = await execute(
      registry,
      adapter,
      { ...system, actorKind: "ai" },
      "plugins.activate",
      { slug },
    );
    expect(denied.ok).toBe(false);
    const prep = (await call("plugins.prepare_activation", { slug })) as {
      pluginId: string;
      schemaName: string;
      appliedSql: string;
      artifactDigest: string;
      version: string;
    };
    await adapter.provisionPluginPublicSchema({ pluginId: prep.pluginId, sql: prep.appliedSql });
    await call("plugins.activate", {
      slug,
      schemaName: prep.schemaName,
      appliedSql: prep.appliedSql,
      version: prep.version,
      artifactDigest: prep.artifactDigest,
    });
    expect(await loadActivatedPlugin(slug)).toEqual({ loaded: true });
    const saved = await runPluginOperation({
      pluginSlug: slug,
      operationName: "save",
      args: { body: "persistent" },
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    const replacement = await execute(registry, adapter, system, "plugins.submit", {
      slug,
      version: "1.0.0",
      manifest,
      source: `${source}\n// changed`,
    });
    expect(replacement.ok).toBe(false);
    resetPluginHost();
    const report = await boot();
    expect(report.failed).toEqual([]);
    const result = await runPluginOperation({ pluginSlug: slug, operationName: "read", args: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toEqual(
      expect.arrayContaining([expect.objectContaining({ body: "persistent" })]),
    );
    const visitorWrite = await runPluginOperation({
      pluginSlug: slug,
      operationName: "save",
      args: { body: "private" },
      visitorContext: { visitorId: "visitor", sessionToken: null },
    });
    expect(visitorWrite.ok).toBe(false);
    await call("plugins.disable", { slug });
    expect(
      (await runPluginOperation({ pluginSlug: slug, operationName: "read", args: {} })).ok,
    ).toBe(false);
  });
  it("adds public columns on upgrade while preserving stored rows", async () => {
    const upgradeSlug = "external-upgrade-probe";
    const firstManifest = { ...manifest, slug: upgradeSlug };
    const firstSource = source.replaceAll(slug, upgradeSlug);
    async function activate() {
      const prep = (await call("plugins.prepare_activation", { slug: upgradeSlug })) as {
        pluginId: string;
        schemaName: string;
        appliedSql: string;
        artifactDigest: string;
        version: string;
      };
      await adapter.provisionPluginPublicSchema({ pluginId: prep.pluginId, sql: prep.appliedSql });
      await call("plugins.activate", {
        slug: upgradeSlug,
        schemaName: prep.schemaName,
        appliedSql: prep.appliedSql,
        artifactDigest: prep.artifactDigest,
        version: prep.version,
      });
      expect(await loadActivatedPlugin(upgradeSlug)).toEqual({ loaded: true });
    }
    await call("plugins.submit", {
      slug: upgradeSlug,
      version: "1.0.0",
      manifest: firstManifest,
      source: firstSource,
    });
    await activate();
    expect(
      (
        await runPluginOperation({
          pluginSlug: upgradeSlug,
          operationName: "save",
          args: { body: "preserved" },
        })
      ).ok,
    ).toBe(true);
    await call("plugins.disable", { slug: upgradeSlug });
    const upgraded = {
      ...firstManifest,
      version: "1.1.0",
      schema: { notes: { ...manifest.schema.notes, tags: "jsonb" } },
    };
    const nextSource = firstSource
      .replace('version:"1.0.0"', 'version:"1.1.0"')
      .replace("{body:args.body}", "{body:args.body,tags:args.tags}");
    await call("plugins.submit", {
      slug: upgradeSlug,
      version: "1.1.0",
      manifest: upgraded,
      source: nextSource,
    });
    await activate();
    expect(
      (
        await runPluginOperation({
          pluginSlug: upgradeSlug,
          operationName: "save",
          args: { body: "new", tags: ["illustrated", "published"] },
        })
      ).ok,
    ).toBe(true);
    expect(
      await runPluginOperation({ pluginSlug: upgradeSlug, operationName: "read", args: {} }),
    ).toMatchObject({
      ok: true,
      value: expect.arrayContaining([
        expect.objectContaining({ body: "preserved", tags: null }),
        expect.objectContaining({ body: "new", tags: ["illustrated", "published"] }),
      ]),
    });
  });
  it("binds both activation paths to reviewed source and provisions chat installations", async () => {
    const chatSlug = "external-chat-probe";
    const chatManifest = { ...manifest, slug: chatSlug };
    const chatSource = source.replaceAll(slug, chatSlug);
    await call("plugins.submit", {
      slug: chatSlug,
      version: "1.0.0",
      manifest: chatManifest,
      source: chatSource,
    });
    const prep = (await call("plugins.prepare_activation", { slug: chatSlug })) as {
      artifactDigest: string;
    };
    const stale = (await call("plugins.propose_activation", { slug: chatSlug })) as {
      proposalId: string;
    };
    await call("plugins.submit", {
      slug: chatSlug,
      version: "1.0.0",
      manifest: chatManifest,
      source: `${chatSource}\n// replacement`,
    });
    const refused = await execute(registry, adapter, system, "plugins.activate", {
      slug: chatSlug,
      artifactDigest: prep.artifactDigest,
    });
    expect(refused.ok).toBe(false);
    const staleCard = await execute(registry, adapter, system, "plugins.execute_activation", {
      proposalId: stale.proposalId,
    });
    expect(staleCard.ok).toBe(false);
    const fresh = (await call("plugins.propose_activation", { slug: chatSlug })) as {
      proposalId: string;
    };
    await call("plugins.execute_activation", { proposalId: fresh.proposalId });
    expect(await loadActivatedPlugin(chatSlug)).toEqual({ loaded: true });
    const result = await runPluginOperation({
      pluginSlug: chatSlug,
      operationName: "save",
      args: { body: "from chat" },
    });
    expect(result.ok).toBe(true);
  });
  it("rejects inconsistent submitted identity", async () => {
    const result = await execute(registry, adapter, system, "plugins.submit", {
      slug: "different-name",
      version: "1.0.0",
      manifest,
      source,
    });
    expect(result.ok).toBe(false);
  });
});

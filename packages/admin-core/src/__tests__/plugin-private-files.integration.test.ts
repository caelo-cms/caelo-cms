// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  loadedPlugins,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import type { PluginContextTier1, PluginPrivateFile } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { makePluginContext } from "../../../plugin-host/src/capabilities.js";
import { resolvePrivatePreviewImages } from "../media/private-preview-images.js";
import { registerAdminOps } from "../register.js";

let adapter: DatabaseAdapter;
let root: string;
const registry = new OperationRegistry();
const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "private-files-test",
};
const owner = { ...system, actorId: crypto.randomUUID(), actorKind: "human" as const };
const authorContext = { actor: owner, operatorActorId: owner.actorId };
const items: { slug: string; installationId: string; pluginId: string }[] = [];
async function op<T>(
  name: string,
  input: unknown,
  actor = system as typeof system | typeof owner,
): Promise<T> {
  const result = await execute(registry, adapter, actor, name, input);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value as T;
}
async function run<T>(action: string, input: unknown, index = 0, preview = false): Promise<T> {
  const result = await runPluginOperation({
    pluginSlug: items[index]!.slug,
    operationName: preview ? "preview" : "run",
    args: { action, input },
    authorContext,
    ...(preview ? { readOnlyPreview: true } : {}),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value as T;
}
beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("Dedicated test DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  root = await mkdtemp(join(tmpdir(), "caelo-private-files-test-"));
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors(id,kind,display_name) VALUES (${owner.actorId}::uuid,'human','Private files test')`,
    );
    await tx.execute(
      sql`INSERT INTO users(id,email,password_hash) VALUES (${owner.actorId}::uuid,${`${owner.actorId}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles(user_id,role_id) SELECT ${owner.actorId}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: root,
    systemActorId: system.actorId,
  });
  for (let i = 0; i < 2; i++) {
    const slug = `private-files-${crypto.randomUUID().slice(0, 8)}`;
    const source = `export default {slug:"${slug}",version:"1.0.0",tier:2,operations:{
      run:async(ctx,args)=>ctx.privateFiles ? ctx.privateFiles[args.action](args.input) : "absent",
      preview:async(ctx,args)=>ctx.privateFiles[args.action](args.input)
    }};`;
    const manifest = {
      slug,
      version: "1.0.0",
      tier: 2,
      schema: {},
      operations: ["run", "preview"],
      requestedCapabilities: ["private_files"],
      capabilityReasons: { private_files: "Store unpublished files privately" },
    };
    const staged = await op<{ installationId: string; pluginId: string; artifactDigest: string }>(
      "plugins.stage_installation",
      { manifest, source },
    );
    items.push({ slug, ...staged });
    expect((await activateApprovedExternalPlugin(staged.installationId)).loaded).toBe(false);
    const list = await op<{ installations: { id: string; currentStateDigest: string }[] }>(
      "plugins.list_installations",
      {},
    );
    await op(
      "plugins.approve_installation",
      {
        installationId: staged.installationId,
        artifactDigest: staged.artifactDigest,
        expectedStateDigest: list.installations.find((item) => item.id === staged.installationId)!
          .currentStateDigest,
        capabilities: ["private_files"],
      },
      owner,
    );
    expect(await activateApprovedExternalPlugin(staged.installationId)).toEqual({ loaded: true });
  }
});
afterAll(async () => {
  resetPluginHost();
  if (adapter) {
    await adapter.withAdminTransaction(system, async (tx) => {
      for (const item of items)
        await tx.execute(sql`DELETE FROM plugins WHERE id=${item.pluginId}::uuid`);
      await tx.execute(sql`DELETE FROM user_roles WHERE user_id=${owner.actorId}::uuid`);
      await tx.execute(sql`DELETE FROM users WHERE id=${owner.actorId}::uuid`);
      // Audit history may retain this actor; keep its non-secret fixture identity.
    });
    await adapter.close();
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test("actual Deno transfers immutable private chunks, survives restart and enforces live grants", async () => {
  const bytes = Buffer.alloc(262_147, 47);
  bytes[262_146] = 99;
  const input = {
    id: crypto.randomUUID(),
    mediaType: "application/octet-stream",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const chunk0 = { id: input.id, offset: 0, base64: bytes.subarray(0, 262_144).toString("base64") };
  const chunk1 = {
    id: input.id,
    offset: 262_144,
    base64: bytes.subarray(262_144).toString("base64"),
  };
  const pending = await Promise.all([
    run<PluginPrivateFile>("begin", input),
    run<PluginPrivateFile>("begin", input),
  ]);
  expect(pending[0]).toEqual({ ...input, status: "pending" });
  expect(pending[1]).toEqual(pending[0]);
  await expect(run("begin", { ...input, sha256: "a".repeat(64) })).rejects.toThrow(
    "IdentityConflict",
  );
  await run("writeChunk", chunk1);
  await expect(run("commit", { id: input.id })).rejects.toThrow("Incomplete");
  await expect(run("readChunk", { id: input.id, offset: 0 })).rejects.toThrow("NotReady");
  await run("writeChunk", chunk0);
  await run("writeChunk", chunk0);
  await expect(run("writeChunk", { ...chunk1, base64: "YWJj" })).rejects.toThrow("ChunkConflict");
  expect(await run("commit", { id: input.id })).toEqual({ ...input, status: "ready" });
  expect(await run("commit", { id: input.id })).toEqual({ ...input, status: "ready" });
  const second = await run<{ base64: string }>("readChunk", { id: input.id, offset: 262_144 });
  expect(Buffer.from(second.base64, "base64").equals(bytes.subarray(262_144))).toBe(true);
  expect(await run("stat", { id: input.id }, 0, true)).toEqual({ ...input, status: "ready" });
  await expect(run("remove", { id: input.id, sha256: input.sha256 }, 0, true)).rejects.toThrow(
    "PluginPreviewReadOnly",
  );
  await expect(run("stat", { id: input.id }, 1)).rejects.toThrow("NotFound");
  const anonymous = await runPluginOperation({
    pluginSlug: items[0]!.slug,
    operationName: "run",
    args: {},
  });
  expect(anonymous).toEqual({ ok: true, value: "absent" });
  const publicRows = await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(sql`SELECT id FROM plugin_private_files`),
  );
  expect(publicRows).toHaveLength(0); // Forced RLS also denies a generic system query.

  resetPluginHost();
  await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: root,
    systemActorId: system.actorId,
  });
  expect(await run("stat", { id: input.id })).toEqual({ ...input, status: "ready" });
  const first = await run<{ base64: string }>("readChunk", { id: input.id, offset: 0 });
  expect(Buffer.from(first.base64, "base64").equals(bytes.subarray(0, 262_144))).toBe(true);
  const context = (await makePluginContext({
    plugin: loadedPlugins.bySlug(items[0]!.slug)!,
    infra: { adapter, registry },
    authorContext,
  })) as PluginContextTier1;
  await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(sql`DELETE FROM user_roles WHERE user_id=${owner.actorId}::uuid`),
  );
  await expect(context.privateFiles!.stat({ id: input.id })).rejects.toThrow(
    "AuthorPermissionDenied",
  );
  await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(
      sql`INSERT INTO user_roles(user_id,role_id) SELECT ${owner.actorId}::uuid,id FROM roles WHERE name='owner'`,
    ),
  );
  await op(
    "plugins.revoke_capability",
    { installationId: items[0]!.installationId, capability: "private_files" },
    owner,
  );
  await expect(context.privateFiles!.stat({ id: input.id })).rejects.toThrow("ApprovalChanged");
}, 30_000);

test("bad hashes never publish bytes and removing a file permanently retires its identity", async () => {
  const input = {
    id: crypto.randomUUID(),
    mediaType: "image/png",
    sizeBytes: 3,
    sha256: "a".repeat(64),
  };
  await run("begin", input, 1);
  await run("writeChunk", { id: input.id, offset: 0, base64: "YWJj" }, 1);
  await expect(run("commit", { id: input.id }, 1)).rejects.toThrow("DigestMismatch");
  await expect(run("readChunk", { id: input.id, offset: 0 }, 1)).rejects.toThrow("NotReady");
  await expect(run("remove", { id: input.id, sha256: "b".repeat(64) }, 1)).rejects.toThrow(
    "IdentityConflict",
  );
  await run("remove", { id: input.id, sha256: input.sha256 }, 1);
  await run("remove", { id: input.id, sha256: input.sha256 }, 1);
  await expect(run("begin", input, 1)).rejects.toThrow("IdentityRetired");
  await expect(run("commit", { id: input.id }, 1)).rejects.toThrow("NotFound");
  expect(await run("stat", { id: input.id }, 1)).toEqual({ ...input, status: "deleted" });
}, 30_000);

test("parallel upload reservations cannot exceed the plugin byte quota", async () => {
  const context = (await makePluginContext({
    plugin: loadedPlugins.bySlug(items[1]!.slug)!,
    infra: { adapter, registry },
    authorContext,
  })) as PluginContextTier1;
  const files = context.privateFiles!;
  const reservations: { id: string; sha256: string }[] = [];
  try {
    for (let i = 0; i < 51; i++) {
      const input = {
        id: crypto.randomUUID(),
        mediaType: "application/octet-stream",
        sizeBytes: 20 * 1024 * 1024,
        sha256: "b".repeat(64),
      };
      await files.begin(input);
      reservations.push(input);
    }
    const contenders = [0, 1].map(() => ({
      id: crypto.randomUUID(),
      mediaType: "application/octet-stream",
      sizeBytes: 3 * 1024 * 1024,
      sha256: "c".repeat(64),
    }));
    const results = await Promise.allSettled(contenders.map((input) => files.begin(input)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") reservations.push(contenders[index]!);
      else expect(String(result.reason)).toContain("QuotaExceeded");
    }
  } finally {
    for (const input of reservations) await files.remove({ id: input.id, sha256: input.sha256 });
  }
}, 30_000);

test("private preview refuses SVG bytes even when a file claims to be a PNG", async () => {
  const context = (await makePluginContext({
    plugin: loadedPlugins.bySlug(items[1]!.slug)!,
    infra: { adapter, registry },
    authorContext,
  })) as PluginContextTier1;
  const files = context.privateFiles!;
  const bytes = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>',
  );
  const input = {
    id: crypto.randomUUID(),
    mediaType: "image/png",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await files.begin(input);
  await files.writeChunk({ id: input.id, offset: 0, base64: bytes.toString("base64") });
  await files.commit({ id: input.id });
  await expect(
    resolvePrivatePreviewImages(
      `<img src="caelo-file:${input.id}:${input.sha256}">`,
      async () => files,
    ),
  ).rejects.toThrow("PrivatePreviewImageType");
  // Plain story text that mentions the scheme needs no file capability.
  expect(
    (
      await resolvePrivatePreviewImages("<p>caelo-file: is a reference scheme</p>", async () => {
        throw new Error("Unexpected access");
      })
    ).size,
  ).toBe(0);
});

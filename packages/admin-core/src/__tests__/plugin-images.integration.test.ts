// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import type { PluginImageResult } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import sharp from "sharp";

import { transformPluginImage } from "../ai/plugin-image-transform.js";
import { registerAdminOps } from "../register.js";

let calls = 0;
let failProvider = false;
let adapter: DatabaseAdapter;
let root: string;
const registry = new OperationRegistry();
const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "private-images-test",
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
  root = await mkdtemp(join(tmpdir(), "caelo-private-images-test-"));
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors(id,kind,display_name) VALUES (${owner.actorId}::uuid,'human','Private images test')`,
    );
    await tx.execute(
      sql`INSERT INTO users(id,email,password_hash) VALUES (${owner.actorId}::uuid,${`${owner.actorId}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles(user_id,role_id) SELECT ${owner.actorId}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  await bootstrap({
    infra: {
      imageTransform: transformPluginImage,
      adapter,
      registry,
      imageProvider: {
        describe: async () => ({
          model: "test-image-model",
          maxCostMicrocents: 100,
          imageSizes: ["4K"],
        }),
        generate: async () => {
          calls++;
          if (failProvider) throw new Error("secret-key-not-for-errors");
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 150);
          });
          return {
            bytes: await sharp({
              create: { width: 3000, height: 3000, channels: 3, background: "orange" },
            })
              .jpeg()
              .toBuffer(),
            width: 3000,
            height: 3000,
            costMicrocents: 42,
            durationMs: 150,
          };
        },
      },
    },
    pluginsRoot: root,
    systemActorId: system.actorId,
  });
  for (let i = 0; i < 2; i++) {
    const slug = `private-images-${crypto.randomUUID().slice(0, 8)}`;
    const source = `export default {slug:"${slug}",version:"1.0.0",tier:2,operations:{
      run:async(ctx,args)=>ctx.images ? ctx.images[args.action](args.input) : "absent",
      preview:async(ctx,args)=>ctx.images ? ctx.images[args.action](args.input) : "absent"
    }};`;
    const manifest = {
      slug,
      version: "1.0.0",
      tier: 2,
      schema: {},
      operations: ["run", "preview"],
      requestedCapabilities: ["private_files", "image_generation"],
      capabilityReasons: {
        private_files: "Store unpublished files privately",
        image_generation: "Create private test illustrations",
      },
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
        capabilities: ["private_files", "image_generation"],
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

const request = () => ({
  requestId: crypto.randomUUID(),
  prompt: "Illustrate a fox without lettering",
  imageSize: "4K",
  references: [],
  maxCostMicrocents: 100,
});
test("Deno paid calls are idempotent, private, metered and denied in preview/visitor contexts", async () => {
  const input = request();
  const before = calls;
  await Promise.all([
    run<PluginImageResult>("generate", input),
    run<PluginImageResult>("generate", input),
  ]);
  expect(calls - before).toBe(1);
  const ready = await run<PluginImageResult>("get", { requestId: input.requestId });
  expect(ready.status).toBe("ready");
  expect(ready.costMicrocents).toBe(42);
  expect(ready.file!.status).toBe("ready");
  expect(ready.width).toBe(3000);
  expect(await run("generate", input)).toEqual(ready);
  expect(calls - before).toBe(1);
  expect(await run("get", { requestId: input.requestId }, 1)).toBeNull();
  await expect(run("generate", { ...input, prompt: "changed" })).rejects.toThrow("RequestConflict");
  await expect(
    run(
      "generate",
      { ...request(), references: [{ id: ready.file!.id, sha256: ready.file!.sha256 }] },
      1,
    ),
  ).rejects.toThrow("PrivateFileNotFound");
  const transform = {
    source: { id: ready.file!.id, sha256: ready.file!.sha256 },
    width: 1752,
    height: 1752,
    quality: 90,
  };
  const derivative = await run<{
    file: { id: string; sizeBytes: number };
    width: number;
    height: number;
  }>("transform", transform);
  expect(derivative.width).toBe(1752);
  expect(derivative.height).toBe(1752);
  expect(derivative.file.id).not.toBe(ready.file!.id);
  expect(derivative.file.sizeBytes).toBeLessThan(ready.file!.sizeBytes);
  expect(await run("transform", transform)).toEqual(derivative);
  expect(calls - before).toBe(1);
  await expect(run("transform", transform, 1)).rejects.toThrow("PrivateFileNotFound");
  await expect(
    run("transform", { ...transform, source: { ...transform.source, sha256: "0".repeat(64) } }),
  ).rejects.toThrow("SourceInvalid");
  await expect(run("transform", { ...transform, width: 9000 })).rejects.toThrow();
  expect(await run("transform", transform, 0, true)).toBe("absent");
  const larger = await run<{ width: number; height: number }>("transform", {
    ...transform,
    width: 6000,
    height: 6000,
  });
  expect(larger.width).toBe(3000);
  expect(larger.height).toBe(3000);
  expect(await run("describe", {}, 0, true)).toBe("absent");
  const visitor = await runPluginOperation({
    pluginSlug: items[0]!.slug,
    operationName: "run",
    args: { action: "describe", input: {} },
    visitorContext: { visitorId: "visitor", sessionToken: null },
  });
  expect(visitor.ok).toBe(false);
  const rows = (await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(
      sql`SELECT cost_estimate_microcents,plugin_id,actor_id FROM ai_calls WHERE plugin_id=${items[0]!.pluginId}::uuid`,
    ),
  )) as unknown as { cost_estimate_microcents: string; plugin_id: string; actor_id: string }[];
  expect(rows).toHaveLength(1);
  expect(Number(rows[0]!.cost_estimate_microcents)).toBe(42);
  expect(rows[0]!.actor_id).toBe(owner.actorId);
}, 30000);
test("uncertain calls retain their reservation and cannot silently spend twice", async () => {
  failProvider = true;
  const input = request();
  const before = calls;
  await expect(run("generate", input)).rejects.toThrow("OutcomeUncertain");
  const result = await run<PluginImageResult>("generate", input);
  expect(result.status).toBe("uncertain");
  expect(result.costMicrocents).toBe(100);
  expect(calls - before).toBe(1);
  failProvider = false;
}, 30000);
test("global image budget reserves concurrent requests before paid calls", async () => {
  const budgets = await op<{
    rows: {
      scope: string;
      operationType: string;
      capMicrocents: number | null;
      warnAtPct: number;
    }[];
  }>("ai_budgets.list", {});
  const previous = budgets.rows.find(
    (b) => b.scope === "day-global" && b.operationType === "image",
  );
  const usage = (await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(
      sql`SELECT coalesce(sum(cost_estimate_microcents),0)::bigint AS spent FROM ai_calls WHERE operation_type='image' AND created_at>now()-interval '24 hours'`,
    ),
  )) as unknown as { spent: string }[];
  await op("ai_budgets.set", {
    scope: "day-global",
    operationType: "image",
    capMicrocents: Number(usage[0]!.spent) + 100,
  });
  const before = calls;
  try {
    const results = await Promise.allSettled([
      run("generate", request()),
      run("generate", request(), 1),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(calls - before).toBe(1);
  } finally {
    await op("ai_budgets.set", {
      scope: "day-global",
      operationType: "image",
      capMicrocents: previous?.capMicrocents ?? null,
      warnAtPct: previous?.warnAtPct ?? 0.8,
    });
  }
}, 30000);

test("per-plugin caps and live grant revocation fail closed", async () => {
  await op("plugins.set_ai_cost_cap", { pluginId: items[0]!.pluginId, capMicrocents: 0 });
  const before = calls;
  await expect(run("generate", request())).rejects.toThrow("PluginBudgetExceeded");
  expect(calls).toBe(before);
  await op(
    "plugins.revoke_capability",
    { installationId: items[0]!.installationId, capability: "image_generation" },
    owner,
  );
  await expect(run("describe", {})).rejects.toThrow();
}, 30000);

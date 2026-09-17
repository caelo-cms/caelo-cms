// SPDX-License-Identifier: MPL-2.0
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fontMetadata } from "@caelo-cms/font-service";
import {
  bootstrap,
  loadedPlugins,
  makePluginContext,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { definePlugin, type PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { registerAdminOps } from "../register.js";

const adapter = new DatabaseAdapter({
  adminDatabaseUrl: process.env.ADMIN_DATABASE_URL!,
  publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL!,
});
const registry = new OperationRegistry();
registerAdminOps(registry);
const system: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "font-capability-test",
};
const owner = { ...system, actorId: crypto.randomUUID(), actorKind: "human" as const };
const infra = { adapter, registry };
const slug = `font-test-${crypto.randomUUID().slice(0, 8)}`;
afterAll(async () => {
  resetPluginHost();
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(sql`DELETE FROM users WHERE id=${owner.actorId}::uuid`);
    await tx.execute(sql`DELETE FROM actors WHERE id=${owner.actorId}::uuid`);
  });
  await adapter.close();
});
test("release plugins read the core registry only during authorized author invocations; cached handles revoke live", async () => {
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors(id,kind,display_name) VALUES (${owner.actorId}::uuid,'human','Font test author')`,
    );
    await tx.execute(
      sql`INSERT INTO users(id,email,password_hash) VALUES (${owner.actorId}::uuid,${`${owner.actorId}@test.invalid`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles(user_id,role_id) SELECT ${owner.actorId}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  const definition = definePlugin<PluginContextTier1>({
    slug,
    version: "1.0.0",
    tier: 1,
    schema: {},
    requestedCapabilities: ["font_assets"],
    operations: { read: async (ctx) => ctx.fonts?.find({}) },
  });
  const report = await bootstrap({
    infra,
    pluginsRoot: "/unused",
    systemActorId: system.actorId,
    testPlugins: [{ definition }],
  });
  expect(report.failed).toEqual([]);
  const plugin = loadedPlugins.bySlug(slug)!;
  expect(
    ((await makePluginContext({ plugin, infra })) as PluginContextTier1).fonts,
  ).toBeUndefined();
  const authorContext = { actor: owner, operatorActorId: owner.actorId };
  const author = (await makePluginContext({ plugin, infra, authorContext })) as PluginContextTier1;
  expect(author.fonts).toBeDefined();
  const imported = await execute(registry, adapter, system, "fonts.import", {
    dataBase64: readFileSync(
      new URL("../../../font-service/src/fixtures/NotoSans-Regular.base64.txt", import.meta.url),
      "utf8",
    ).trim(),
    license: {
      name: "OFL-1.1",
      text: "fixture license",
      webEmbedding: true,
      documentEmbedding: true,
    },
    source: "font-capability-test",
  });
  expect(imported.ok).toBe(true);
  if (!imported.ok) return;
  const font = fontMetadata.parse(imported.value);
  const ref = { id: font.id, sha256: font.sha256 };
  expect(await author.fonts!.inspect(ref)).toEqual(font);
  expect(
    (await author.fonts!.readChunk({ ...ref, offset: 0, length: 128 })).dataBase64.length,
  ).toBeGreaterThan(0);
  await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(sql`DELETE FROM user_roles WHERE user_id=${owner.actorId}::uuid`),
  );
  await expect(author.fonts!.inspect(ref)).rejects.toThrow("PluginFontAuthorPermissionDenied");
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO user_roles(user_id,role_id) SELECT ${owner.actorId}::uuid,id FROM roles WHERE name='owner'`,
    );
    await tx.execute(sql`UPDATE plugins SET status='disabled' WHERE id=${plugin.pluginId}::uuid`);
  });
  await expect(author.fonts!.readChunk({ ...ref, offset: 0, length: 128 })).rejects.toThrow(
    "PluginFontInactive",
  );
});

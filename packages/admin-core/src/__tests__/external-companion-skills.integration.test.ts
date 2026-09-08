// SPDX-License-Identifier: MPL-2.0

import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  deregisterPlugin,
  loadedPlugins,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { manifestFromDefinition, type PluginSkillSpec } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { registerAdminOps } from "../register.js";

let adapter: DatabaseAdapter;
let pluginsRoot: string;
let owner: ExecutionContext;
const registry = new OperationRegistry();
const fixtureSuffix = crypto.randomUUID();
const fixtureSkills = new Set<string>();
const system: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "external-companion-skills-test",
};
const ai: ExecutionContext = { ...system, actorKind: "ai" };

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  owner = { ...system, actorId: crypto.randomUUID(), actorKind: "human" };
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors(id,kind,display_name) VALUES (${owner.actorId}::uuid,'human','companion test owner')`,
    );
    await tx.execute(
      sql`INSERT INTO users(id,email,password_hash) VALUES (${owner.actorId}::uuid,${`${owner.actorId}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles(user_id,role_id) SELECT ${owner.actorId}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-companions-"));
  await boot();
});
afterAll(async () => {
  resetPluginHost();
  if (fixtureSkills.size)
    await adapter.withAdminTransaction(system, (tx) =>
      tx.execute(sql`
    DELETE FROM skills WHERE slug IN (${sql.join(
      [...fixtureSkills].map((slug) => sql`${slug}`),
      sql`, `,
    )})
  `),
    );
  await rm(pluginsRoot, { recursive: true, force: true });
  await adapter.close();
});
async function boot() {
  resetPluginHost();
  await bootstrap({ infra: { adapter, registry }, pluginsRoot, systemActorId: system.actorId });
}
async function call(name: string, input: unknown, ctx = system) {
  const result = await execute(registry, adapter, ctx, name, input);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}
function skill(slug: string, body = "Guide the author through the plugin tools."): PluginSkillSpec {
  return {
    slug,
    body,
    displayName: slug,
    description: "Companion authoring guide",
    allowlistedTools: [],
    autoEngagementHints: { keywords: ["picture book"] },
  };
}
async function stage(slug: string, version: string, skills: PluginSkillSpec[]) {
  for (const guide of skills) fixtureSkills.add(guide.slug);
  // Uses the public SDK projection, the same path as independently built packages.
  const manifest = manifestFromDefinition({
    slug,
    version,
    tier: 2,
    schema: {},
    operations: { noop: () => null },
    skills,
    requestedCapabilities: ["companion_skills"],
    capabilityReasons: { companion_skills: "Teach the CMS how to use this plugin" },
  });
  return (await call("plugins.stage_installation", {
    manifest,
    source: `export default {slug:"${slug}",version:"${version}",tier:2,operations:{noop:async()=>null}};`,
  })) as { installationId: string; pluginId: string; artifactDigest: string };
}
async function approve(item: Awaited<ReturnType<typeof stage>>) {
  const reviews = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  const review = reviews.installations.find((r) => r.id === item.installationId)!;
  await call(
    "plugins.approve_installation",
    {
      installationId: item.installationId,
      artifactDigest: item.artifactDigest,
      expectedStateDigest: review.currentStateDigest,
      capabilities: ["companion_skills"],
    },
    owner,
  );
}
async function get(slug: string, ctx = ai) {
  return (
    (await call("skills.get", { slug }, ctx)) as {
      skill: { id: string; body: string; status: string; activatedAt: string } | null;
    }
  ).skill;
}

it("activates reviewed skills with the plugin and hides them on disable, restart and revocation", async () => {
  const slug = `external-skill-guide-${fixtureSuffix}`;
  const guide = skill(`${slug}-authoring`);
  const item = await stage(slug, "1.0.0", [guide]);
  expect(await get(guide.slug)).toBeNull();
  await approve(item);
  expect(await get(guide.slug)).toBeNull();
  expect(await activateApprovedExternalPlugin(item.installationId)).toEqual({ loaded: true });
  expect(loadedPlugins.bySlug(slug)?.definition.skills).toEqual([guide]);
  const active = await get(guide.slug);
  expect(active).toMatchObject({ body: guide.body, status: "active" });
  expect(active?.activatedAt).toMatch(/^\d{4}-/);
  await call("skills.set_pin_defaults", { skillIds: [active!.id] }, owner);
  expect(await call("skills.list_pin_defaults", {}, owner)).toMatchObject({
    pinDefaults: [{ slug: guide.slug }],
  });
  await boot();
  expect(await get(guide.slug)).toEqual(active);
  await call("plugins.disable", { slug }, owner);
  expect(await get(guide.slug)).toBeNull();
  expect(await call("skills.list_pin_defaults", {}, owner)).toEqual({ pinDefaults: [] });
  await boot();
  expect(await get(guide.slug)).toBeNull();
  await approve(item);
  expect(await activateApprovedExternalPlugin(item.installationId)).toEqual({ loaded: true });
  expect(await get(guide.slug)).toMatchObject({ body: guide.body });
  await call(
    "plugins.revoke_capability",
    { installationId: item.installationId, capability: "companion_skills" },
    owner,
  );
  expect(await get(guide.slug)).toBeNull();
  const available = (await call("skills.list", {}, ai)) as { skills: { slug: string }[] };
  expect(available.skills.some((s) => s.slug === guide.slug)).toBe(false);
});

it("updates owned skills atomically, preserves an archive, removes obsolete guides and refuses foreign slugs", async () => {
  const slug = `external-skill-update-${fixtureSuffix}`;
  const first = skill(`${slug}-first`, "original guide");
  const archived = skill(`${slug}-archived`);
  const removed = skill(`${slug}-removed`);
  const one = await stage(slug, "1.0.0", [first, archived, removed]);
  await approve(one);
  expect(await activateApprovedExternalPlugin(one.installationId)).toEqual({ loaded: true });
  await call("skills.archive", { slug: archived.slug }, owner);
  const two = await stage(slug, "1.0.1", [{ ...first, body: "updated guide" }, archived]);
  await approve(two);
  expect(await get(first.slug)).toMatchObject({ body: "original guide" });
  expect(await activateApprovedExternalPlugin(two.installationId)).toEqual({ loaded: true });
  expect(await get(first.slug)).toMatchObject({ body: "updated guide" });
  expect(await get(archived.slug)).toMatchObject({ status: "archived" });
  expect(await get(removed.slug)).toBeNull();
  const occupied = skill(`${slug}-occupied`, "independent Owner guide");
  await call(
    "skills.set",
    {
      slug: occupied.slug,
      displayName: occupied.displayName,
      description: occupied.description,
      body: occupied.body,
      allowlistedTools: [],
    },
    owner,
  );
  const three = await stage(slug, "1.0.2", [{ ...first, body: "must roll back" }, occupied]);
  await approve(three);
  const result = await activateApprovedExternalPlugin(three.installationId);
  expect(result.loaded).toBe(false);
  expect(result.reason).toContain("belongs to another author or plugin");
  expect(await get(first.slug)).toMatchObject({ body: "updated guide" });
  expect(await get(occupied.slug)).toMatchObject({ body: "independent Owner guide" });
  expect(loadedPlugins.bySlug(slug)?.version).toBe("1.0.1");
  expect(await call("plugins.get", { slug })).toMatchObject({
    plugin: { version: "1.0.1", status: "active" },
  });
});

it("checks live receipts even without a lifecycle notification and does not elevate the AI reader", async () => {
  const slug = `external-skill-receipt-${fixtureSuffix}`;
  const guide = skill(`${slug}-guide`);
  const item = await stage(slug, "1.0.0", [guide]);
  await approve(item);
  expect(await activateApprovedExternalPlugin(item.installationId)).toEqual({ loaded: true });
  expect(await get(guide.slug)).not.toBeNull();
  await adapter.withAdminTransaction(owner, (tx) =>
    tx.execute(sql`
    UPDATE plugin_capability_grants SET revoked_at=now(),revoked_by=${owner.actorId}::uuid
    WHERE plugin_id=${item.pluginId}::uuid AND capability='companion_skills' AND revoked_at IS NULL
  `),
  );
  expect(await get(guide.slug)).toBeNull();
  const rows = await adapter.withAdminTransaction(ai, (tx) =>
    tx.execute(sql`
    SELECT plugin_skill_available(${item.pluginId}::uuid,${item.artifactDigest}) AS available,
      current_setting('caelo.actor_kind') AS actor_kind,
      plugin_skill_available(NULL,${item.artifactDigest}) AS detached_available
  `),
  );
  expect(rows).toMatchObject([{ available: false, actor_kind: "ai", detached_available: false }]);
  await expect(
    adapter.withAdminTransaction(ai, (tx) =>
      tx.execute(sql`
    INSERT INTO plugin_capability_grants(plugin_id,artifact_digest,capability,approved_by)
    VALUES (${item.pluginId}::uuid,${item.artifactDigest},'companion_skills',${ai.actorId}::uuid)
  `),
    ),
  ).rejects.toThrow();
});

it("retains namespace ownership through uninstall without exposing detached guides", async () => {
  const slug = `external-skill-reinstall-${fixtureSuffix}`;
  const guide = skill(`${slug}-guide`);
  const initial = await stage(slug, "1.0.0", [guide]);
  await approve(initial);
  expect(await activateApprovedExternalPlugin(initial.installationId)).toEqual({ loaded: true });
  const original = await get(guide.slug);
  await call("skills.archive", { slug: guide.slug }, owner);
  // Exercise the same archival + FK detachment used by plugin uninstall.
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`DELETE FROM plugin_schema_migrations WHERE plugin_id=${initial.pluginId}::uuid`,
    );
    await tx.execute(sql`DELETE FROM plugins WHERE id=${initial.pluginId}::uuid`);
  });
  deregisterPlugin(slug);
  expect(await get(guide.slug)).toBeNull();
  const replacement = await stage(slug, "1.0.1", [{ ...guide, body: "reinstalled guide" }]);
  expect(replacement.pluginId).not.toBe(initial.pluginId);
  await approve(replacement);
  expect(await activateApprovedExternalPlugin(replacement.installationId)).toEqual({
    loaded: true,
  });
  expect(await get(guide.slug)).toMatchObject({
    id: original!.id,
    status: "archived",
    body: "reinstalled guide",
  });
});

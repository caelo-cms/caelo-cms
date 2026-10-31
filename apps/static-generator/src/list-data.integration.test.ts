// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107, PR #1121 review — a build renders the first-publication
 * time of a published page that was never live as the build's own
 * `publishAt` (the deploy run's start, which Publish live then stores).
 * Without it the page carried `null`, sorted last in "latest news", and
 * a newly published article was missing from the list it was published
 * for until another rebuild.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { localBuildPluginServices } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { loadBuildListRenderData } from "./list-data.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "list-data-first-published-test",
};
const PFX = `ldfp-${Date.now().toString(36)}`;
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let languageBefore: string | null = null;

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const db = new SQL(ADMIN_URL as string);
  try {
    return await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx);
    });
  } finally {
    await db.end();
  }
}

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYSTEM, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const row = (await asSystem(
    (tx) => tx`SELECT site_language FROM site_defaults WHERE id = 1`,
  )) as { site_language: string | null }[];
  languageBefore = row[0]?.site_language ?? null;
  await asSystem((tx) => tx`UPDATE site_defaults SET site_language = 'en' WHERE id = 1`);
});

afterAll(async () => {
  await asSystem(async (tx) => {
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`UPDATE site_defaults SET site_language = ${languageBefore} WHERE id = 1`;
  });
  await adapter.close();
});

describe("build list data: first publication", () => {
  it("a published, never-live page carries the build's publishAt; a draft carries none", async () => {
    const tpl = await asSystem(
      (tx) =>
        tx`SELECT definition->>'defaultTemplate' AS id FROM page_types
           WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL`,
    );
    const templateId = (tpl as { id: string }[])[0]?.id;
    if (!templateId) throw new Error("no home page type seeded");
    const published = await op<{ pageId: string }>("pages.create", {
      slug: `${PFX}-pub`,
      title: "Pub",
      templateId,
      status: "published",
    });
    const draft = await op<{ pageId: string }>("pages.create", {
      slug: `${PFX}-draft`,
      title: "Draft",
      templateId,
      status: "draft",
    });
    const publishAt = "2026-10-26T09:00:00.000Z";
    const data = await adapter.admin.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('caelo.actor_kind', 'system', true)`);
      return loadBuildListRenderData(tx, {
        env: "production",
        plugins: localBuildPluginServices,
        publishAt,
      });
    });
    expect(data.pages.get(published.pageId)?.firstPublishedAt).toBe(publishAt);
    expect(data.pages.get(draft.pageId)?.firstPublishedAt).toBeNull();
  });
});

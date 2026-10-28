// SPDX-License-Identifier: MPL-2.0

/**
 * #1214 — consent-manager's embed verdicts follow every write, on the
 * writer's branch, so its render hooks can read them instead of
 * rescanning the site.
 *
 * Core tells plugins with a `moduleChangesOperation` which modules a
 * committed write changed (snapshot emitter → plugin-host
 * `notifyModuleChanges`). This suite drives the real engine: a live edit
 * rewrites the main-line verdict at once, a chat-branch edit rewrites it
 * on that branch only (the draft's banner offers the new category, the
 * live one does not), and the merge carries it to main.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import consentPlugin from "@caelo-cms/plugin-consent-manager";
import {
  bootstrap,
  type PluginHostInfra,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const PFX = "t1214-";
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t1214" };
const YOUTUBE = '<iframe src="https://www.youtube.com/embed/abc"></iframe>';
const OSM = '<iframe src="https://www.openstreetmap.org/export/embed.html"></iframe>';

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let moduleId = "";

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_consent_manager" CASCADE');
    const byPluginActor =
      "SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'consent-manager')";
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (${byPluginActor})`);
    await tx.unsafe(`DELETE FROM site_snapshots WHERE actor_id IN (${byPluginActor})`);
    await tx.unsafe(
      `DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'consent-manager')`,
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'consent-manager'");
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
  });
  const pub = new SQL(PUBLIC_URL);
  try {
    await pub.unsafe('DROP SCHEMA IF EXISTS "plugin_consent_manager" CASCADE');
  } finally {
    await pub.end();
  }
}

/** Main-line guard rows (what the deployed site's render reads). */
async function mainGuards(): Promise<{ status: string; category_key: string }[]> {
  return sqlSystem(async (tx) => {
    // The plugin's own RLS scope: its rows are invisible without it.
    await tx`SELECT set_config('caelo.plugin_id',
      (SELECT id::text FROM plugins WHERE slug = 'consent-manager'), true)`;
    return (await tx`
      SELECT status, category_key FROM plugin_consent_manager.module_guards
      WHERE module_id = ${moduleId}::uuid
        AND caelo_chat_branch_id IS NULL AND caelo_deleted_at IS NULL
    `) as { status: string; category_key: string }[];
  });
}

/** The banner's category keys as a render in `chatBranchId` (null = main) sees them. */
async function offered(chatBranchId: string | null): Promise<string[]> {
  const r = await runPluginOperation({
    invocation: {
      origin: "render",
      actorId: SYSTEM_ACTOR_ID,
      ...(chatBranchId ? { chatBranchId } : {}),
    },
    pluginSlug: "consent-manager",
    operationName: "consent_data_lists",
    args: { pageIds: ["p"] },
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const sources = (r.value as { sources: Record<string, { consent_categories: { id: string }[] }> })
    .sources;
  return (sources.p?.consent_categories ?? []).map((c) => c.id);
}

async function setHtml(ctx: ExecutionContext, html: string): Promise<void> {
  const r = await execute(registry, adapter, ctx, "modules.update", { moduleId, html });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  const infra: PluginHostInfra = { adapter, registry, lockPluginRow };
  const report = await bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: consentPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  const m = await execute(registry, adapter, SYS, "modules.create", {
    slug: `${PFX}embed`,
    displayName: "Embed",
    html: "<p>nothing external yet</p>",
    css: "",
    js: "",
    fields: [],
  });
  if (!m.ok) throw new Error(JSON.stringify(m.error));
  moduleId = (m.value as { moduleId: string }).moduleId;
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("#1214 — verdicts follow the write that changed the module", () => {
  it("records a live edit's embed at once, and drops it when the embed goes", async () => {
    expect(await mainGuards()).toEqual([]);
    await setHtml(SYS, YOUTUBE);
    expect(await mainGuards()).toEqual([{ status: "gated", category_key: "marketing" }]);
    expect(await offered(null)).toEqual(["necessary", "marketing"]);

    await setHtml(SYS, "<p>nothing external again</p>");
    expect(await mainGuards()).toEqual([]);
    expect(await offered(null)).toEqual(["necessary"]);
  });

  it("keeps a chat's verdict on its branch until the merge", async () => {
    const chat = await execute(registry, adapter, SYS, "chat.create_session", {
      isolation: "experiment",
      title: `${PFX}draft`,
    });
    if (!chat.ok) throw new Error(JSON.stringify(chat.error));
    const { chatSessionId, chatBranchId } = chat.value as {
      chatSessionId: string;
      chatBranchId: string;
    };
    await setHtml({ ...SYS, chatBranchId, chatTaskId: chatSessionId }, OSM);

    // The draft's banner offers what the draft's map needs; the live one
    // does not, because the live module still reaches nothing.
    expect(await offered(chatBranchId)).toEqual(["necessary", "functional"]);
    expect(await offered(null)).toEqual(["necessary"]);
    expect(await mainGuards()).toEqual([]);

    const merged = await execute(registry, adapter, SYS, "chat.merge_to_main", { chatSessionId });
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    expect(await mainGuards()).toEqual([{ status: "gated", category_key: "functional" }]);
    expect(await offered(null)).toEqual(["necessary", "functional"]);
  });
});

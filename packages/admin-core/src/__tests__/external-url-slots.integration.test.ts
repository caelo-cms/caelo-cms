// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 (decision Q7 A) — a runtime-installed plugin shapes page
 * addresses with declared URL tables (docs/dev/external-plugin-brokers.md
 * §6.8), end to end on a real Postgres and the real Deno sandbox: staged,
 * approved by an Owner, activated, then its tables changed through
 * approval-gated tools.
 *
 * - The host reads the tables inside the composing transaction: the
 *   URL migration diffs `/x` → `/de/x` and applies it with its 301.
 * - Only an Owner-approved call writes the tables; a chat write is refused.
 * - A segment that collides with a page, is reserved or is a path trick,
 *   a host the install does not serve, and a second value claiming one
 *   segment are refused at the write; so is removing a value a page names.
 * - An approval that decides about the chat's draft lands on the chat's
 *   branch: the chat sees the new address, main keeps the old one.
 * - Another plugin cannot claim the slots this one holds.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  collectUrlAnnotations,
  declaredUrlContributions,
  MAIN_RENDER,
  resetPluginHost,
  resolvePageUrl,
  runPluginOperation,
  urlContributionsRegistry,
} from "@caelo-cms/plugin-host";
import type { PluginInvocation } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { attachPluginGatedExecute } from "../ai/tools/gated-tools.js";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { rawSystemSql } from "./_raw-system-sql.js";
import { adoptTemplateIntoHomePageType } from "./_template-page-type.js";

let adapter: DatabaseAdapter;
let pluginsRoot: string;
const registry = new OperationRegistry();
const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "external-url-slots-test",
};
const SLUG = "url-probe";
const SCHEMA = "plugin_url_probe";
const PFX = "t1729u";
const DOMAIN = "de.t1729u.example";
const UPDATE_SLUG = "url-probe-update";
const UPDATE_SCHEMA = "plugin_url_probe_update";

const URL_TABLES = {
  pages: { table: "page_markets", valueColumn: "market" },
  values: { table: "markets", valueColumn: "code", segmentColumn: "segment", hostColumn: "host" },
};
const tool = (name: string, operationName: string, properties: Record<string, unknown>) => ({
  name: `url_probe__${name}`,
  operationName,
  description: `Change the probe's ${name}`,
  approvalMode: "user-approval" as const,
  inputJsonSchema: { type: "object", additionalProperties: false, properties },
});
function ungated<T extends { approvalMode?: unknown }>(t: T): Omit<T, "approvalMode"> {
  const { approvalMode: _gated, ...rest } = t;
  return rest;
}
const manifest = {
  slug: SLUG,
  version: "1.0.0",
  tier: 2,
  schema: {},
  adminSchema: {
    page_markets: { page_id: "uuid", market: "text" },
    markets: { code: "text", segment: "text", host: "text" },
  },
  indexes: { adminSchema: { page_markets: [["page_id"], ["market"]] } },
  operations: ["set_market", "assign_page", "assign_draft", "try_set"],
  urlTables: URL_TABLES,
  urlContributions: [{ slot: "host" }, { slot: "path-prefix" }],
  tools: [
    tool("set_market", "set_market", {
      code: { type: "string", maxLength: 64 },
      segment: { type: "string", maxLength: 80 },
      host: { type: "string", maxLength: 253 },
      remove: { type: "boolean" },
    }),
    tool("assign_page", "assign_page", {
      pageId: { type: "string", format: "uuid" },
      market: { type: "string", maxLength: 64 },
    }),
    {
      ...tool("assign_draft", "assign_draft", {
        pageId: { type: "string", format: "uuid" },
        market: { type: "string", maxLength: 64 },
      }),
      // The decision is about the chat's draft: it stays on the branch.
      approvedOnChatBranch: true,
    },
    // The same write without the approval: what the host handle refuses.
    ungated(tool("try_set", "try_set", { code: { type: "string", maxLength: 64 } })),
  ],
  requestedCapabilities: ["cms_admin_schema", "url_slots", "chat_runner_tools"],
  capabilityReasons: {
    cms_admin_schema: "Keep the markets",
    url_slots: "Prefix each market's pages",
    chat_runner_tools: "Let the AI propose market changes",
  },
};
const source = `export default {slug:"${SLUG}",version:"1.0.0",tier:2,operations:{
  set_market: async (ctx, args) => {
    const rows = await ctx.adminQuery.list("markets", { limit: 100 });
    const row = rows.find((r) => r.code === args.code);
    if (args.remove) { await ctx.adminQuery.delete("markets", row.id); return { removed: true }; }
    const values = { segment: args.segment ?? null, host: args.host ?? null };
    if (row) await ctx.adminQuery.update("markets", row.id, values);
    else await ctx.adminQuery.insert("markets", { code: args.code, ...values });
    return { ok: true };
  },
  try_set: async (ctx, args) => ctx.adminQuery.insert("markets", { code: args.code, segment: args.code }),
  assign_draft: async (ctx, args) => {
    await ctx.adminQuery.insert("page_markets", { page_id: args.pageId, market: args.market });
    return { ok: true };
  },
  assign_page: async (ctx, args) => {
    const rows = await ctx.adminQuery.list("page_markets", { page_id: args.pageId, limit: 1 });
    if (rows[0]) await ctx.adminQuery.update("page_markets", rows[0].id, { market: args.market });
    else await ctx.adminQuery.insert("page_markets", { page_id: args.pageId, market: args.market });
    return { ok: true };
  },
}};`;

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  await cleanup();
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-url-slots-test-"));
  await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot,
    systemActorId: system.actorId,
  });
});
afterAll(async () => {
  resetPluginHost();
  await cleanup();
  await rm(pluginsRoot, { recursive: true, force: true });
  await adapter.close();
});

/** The plugin's schema and the rows this file creates, which outlive the per-file reset. */
const cleanup = () =>
  rawSystemSql(async (tx) => {
    await tx.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await tx.unsafe(`DROP SCHEMA IF EXISTS ${UPDATE_SCHEMA} CASCADE`);
    await tx.unsafe("DELETE FROM url_migration_pending_actions");
    await tx.unsafe(
      `DELETE FROM pending_redirects WHERE from_path LIKE '/${PFX}-%' OR to_path LIKE '/de/${PFX}-%'`,
    );
    await tx.unsafe(`DELETE FROM domains WHERE hostname = '${DOMAIN}'`);
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${PFX}-%'`);
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

async function owner() {
  const id = crypto.randomUUID();
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors (id,kind,display_name) VALUES (${id}::uuid,'human','owner')`,
    );
    await tx.execute(
      sql`INSERT INTO users (id,email,password_hash) VALUES (${id}::uuid,${`${id}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles (user_id,role_id) SELECT ${id}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  return { ...system, actorId: id, actorKind: "human" as const };
}

async function install(ownerCtx: Awaited<ReturnType<typeof owner>>): Promise<void> {
  const loaded = await activateApprovedExternalPlugin(await approve(ownerCtx, manifest, source));
  if (!loaded.loaded) throw new Error(`activation failed: ${loaded.reason}`);
}

/** Stage `m` with `src` and approve it as `ownerCtx`; the installation's id. */
async function approve(
  ownerCtx: Awaited<ReturnType<typeof owner>>,
  m: { requestedCapabilities: string[] },
  src: string,
): Promise<string> {
  const staged = (await call("plugins.stage_installation", { manifest: m, source: src })) as {
    installationId: string;
    artifactDigest: string;
  };
  const review = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  const item = review.installations.find((row) => row.id === staged.installationId);
  if (!item) throw new Error("review missing");
  await call(
    "plugins.approve_installation",
    {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest: item.currentStateDigest,
      capabilities: m.requestedCapabilities,
    },
    ownerCtx,
  );
  return staged.installationId;
}

/** A published top-level page at `/<slug>`. */
async function seedPage(slug: string): Promise<string> {
  const db = new SQL(process.env.ADMIN_DATABASE_URL as string);
  try {
    return await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const lay = (await tx.unsafe(
        `INSERT INTO layouts (slug, display_name, html, css)
         VALUES ('${slug}-lay', 'L', '<html><body><caelo-layout-content></caelo-layout-content></body></html>', '')
         RETURNING id::text AS id`,
      )) as { id: string }[];
      const tpl = (await tx.unsafe(
        `INSERT INTO templates (slug, display_name, html, css, layout_id)
         VALUES ('${slug}-tpl', 'T', '<main></main>', '', '${lay[0]?.id}')
         RETURNING id::text AS id`,
      )) as { id: string }[];
      await adoptTemplateIntoHomePageType(tx as unknown as Bun.SQL, tpl[0]?.id ?? "");
      const pg = (await tx.unsafe(
        `INSERT INTO pages (slug, short_title, title, template_id, status, page_type_confirmed)
         VALUES ('${slug}', 'P', 'P', '${tpl[0]?.id}', 'published', true)
         RETURNING id::text AS id`,
      )) as { id: string }[];
      const id = pg[0]?.id;
      if (!id) throw new Error("seed failed");
      return id;
    });
  } finally {
    await db.end();
  }
}

async function storedPath(pageId: string): Promise<string> {
  const rows = (await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(sql`SELECT current_path FROM pages WHERE id = ${pageId}::uuid`),
  )) as unknown as { current_path: string }[];
  return rows[0]?.current_path ?? "";
}

/** One approval-gated tool call as the chat runs it: the Owner's click, then the call. */
async function approved(chat: PluginInvocation, name: string, args: Record<string, unknown>) {
  const gated = attachPluginGatedExecute(
    {
      name: `url_probe__${name}`,
      description: name,
      inputSchema: (
        manifest.tools.find((t) => t.name === `url_probe__${name}`) as never as {
          inputJsonSchema: Record<string, unknown>;
        }
      ).inputJsonSchema,
      pluginGated: { pluginSlug: SLUG, operationName: name },
    } as never,
    chat,
  );
  const toolCallId = crypto.randomUUID();
  await gated.prepareApproval?.(toolCallId, args);
  return (await gated.execute?.(args, { toolCallId })) as {
    ok: boolean;
    error?: unknown;
    value?: unknown;
  };
}

it("an installed plugin's URL tables shape addresses, change only when approved, and move pages with their 301s", async () => {
  const ownerCtx = await owner();
  await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(
      sql`INSERT INTO domains (hostname, kind) VALUES (${DOMAIN}, 'public') ON CONFLICT DO NOTHING`,
    ),
  );
  const pricing = await seedPage(`${PFX}-pricing`);
  const about = await seedPage(`${PFX}-about`);
  await install(ownerCtx);
  // The AI in a chat on the shared draft, for an Owner who may publish:
  // an approval that is not draft-bound applies on main.
  const branch = crypto.randomUUID();
  const chat: PluginInvocation = {
    origin: "chat",
    actorId: system.actorId,
    operatorActorId: ownerCtx.actorId,
    chatBranchId: branch,
  };

  // A chat write is not the gate: refused before anything is stored.
  const direct = await runPluginOperation({
    pluginSlug: SLUG,
    operationName: "try_set",
    args: { code: "de" },
    invocation: chat,
  });
  expect(direct.ok).toBe(false);
  if (!direct.ok) expect(direct.error.message).toContain("Owner approved");

  // Approved: a value with a prefix and a served host.
  expect(
    await approved(chat, "set_market", { code: "de", segment: "de", host: DOMAIN }),
  ).toMatchObject({ ok: true });

  // Refused at the write, each naming the fix.
  const refusedWith = async (args: Record<string, unknown>, text: string) => {
    const r = await approved(chat, "set_market", args);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.error)).toContain(text);
  };
  await refusedWith({ code: "x1", segment: "api" }, "reserved for the site's own services");
  await refusedWith({ code: "x2", segment: "../de" }, "is not a path segment");
  await refusedWith({ code: "x3", segment: "a%2fb" }, "is not a path segment");
  await refusedWith({ code: "x4", segment: "de\\u0000" }, "is not a path segment");
  await refusedWith({ code: "x5", segment: "de" }, 'both claim the segment \\"de\\"');
  await refusedWith({ code: "x6", segment: `${PFX}-about` }, "is already the address of a page");
  await refusedWith({ code: "x7", host: "evil.example.net" }, "not a domain this install serves");

  // A page names a value that does not exist: refused.
  const unknown = await approved(chat, "assign_page", { pageId: pricing, market: "zz" });
  expect(JSON.stringify(unknown.error)).toContain("is not in markets");

  // A page's value, approved by an Owner who may publish: applied on main.
  expect(await approved(chat, "assign_page", { pageId: pricing, market: "de" })).toMatchObject({
    ok: true,
  });

  // The host composes from the tables: path prefix and host.
  const annotations = await collectUrlAnnotations([pricing], MAIN_RENDER);
  expect(
    resolvePageUrl({
      pageId: pricing,
      slug: `${PFX}-pricing`,
      ancestorSlugs: [],
      isHomePage: false,
      annotations: annotations.get(pricing) ?? {},
    }),
  ).toEqual({ path: `/de/${PFX}-pricing`, host: DOMAIN });

  // The stored path moves only through the approved URL migration, with its 301.
  expect(await storedPath(pricing)).toBe(`/${PFX}-pricing`);
  const proposed = (await call("url_migrations.propose_migrate", { reason: "markets" })) as {
    proposalId: string;
    preview: { sample: string[] };
  };
  expect(proposed.preview.sample).toContain(`/${PFX}-pricing → /de/${PFX}-pricing`);
  expect(
    await call("url_migrations.execute_proposal", { proposalId: proposed.proposalId }, ownerCtx),
  ).toMatchObject({ redirectsCreated: 1 });
  expect(await storedPath(pricing)).toBe(`/de/${PFX}-pricing`);
  const redirects = (await rawSystemSql(
    (tx) =>
      tx`SELECT to_path, status_code FROM pending_redirects WHERE from_path = ${`/${PFX}-pricing`}`,
  )) as unknown as { to_path: string; status_code: number }[];
  expect(redirects).toEqual([{ to_path: `/de/${PFX}-pricing`, status_code: 301 }]);

  // A value a page still names cannot be removed.
  const removed = await approved(chat, "set_market", { code: "de", remove: true });
  expect(JSON.stringify(removed.error)).toContain("still shapes the address of page");

  // A plugin cannot move a published page without its 301.
  const pluginCtx = await adapter.withAdminTransaction(system, async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT a.id::text AS id, p.id::text AS plugin_id FROM actors a JOIN plugins p ON p.id = a.plugin_id WHERE p.slug = ${SLUG}`,
    )) as unknown as { id: string; plugin_id: string }[];
    return rows[0];
  });
  const skip = await execute(
    registry,
    adapter,
    {
      actorId: pluginCtx?.id ?? "",
      actorKind: "plugin",
      pluginId: pluginCtx?.plugin_id ?? "",
      requestId: "skip",
    },
    "pages.refresh_current_path",
    { pageId: pricing, redirectFromOld: "skip" },
  );
  expect(skip.ok).toBe(false);
  if (!skip.ok) expect(JSON.stringify(skip.error)).toContain("keeps a 301 when it moves");

  // Draft-bound approval in a chat: the chat sees the new address, main does not.
  expect(await approved(chat, "assign_draft", { pageId: about, market: "de" })).toMatchObject({
    ok: true,
  });
  const onBranch = await collectUrlAnnotations([about], { chatBranchId: branch });
  const onMain = await collectUrlAnnotations([about], MAIN_RENDER);
  expect(onBranch.get(about)).toBeDefined();
  expect(onMain.get(about)).toBeUndefined();
  expect(await storedPath(about)).toBe(`/${PFX}-about`);

  // The slots are this plugin's: another cannot claim them.
  expect(() =>
    urlContributionsRegistry.assertClaimable(
      "another-plugin",
      declaredUrlContributions("another-plugin", URL_TABLES),
    ),
  ).toThrow(`already claimed by plugin "${SLUG}"`);
}, 240_000);

it("refuses an update whose URL slot another running plugin holds, and keeps the running version (#1729)", async () => {
  // Runs after the test above: url-probe holds the host and path-prefix slots.
  const ownerCtx = await owner();
  const first = {
    slug: UPDATE_SLUG,
    version: "1.0.0",
    tier: 2,
    schema: {},
    adminSchema: manifest.adminSchema,
    indexes: manifest.indexes,
    operations: ["ping"],
    requestedCapabilities: ["cms_admin_schema"],
    capabilityReasons: { cms_admin_schema: "Keep the markets" },
  };
  const firstSource = (version: string) =>
    `export default {slug:"${UPDATE_SLUG}",version:"${version}",tier:2,operations:{ping:async()=>({version:"${version}"})}};`;
  expect(
    await activateApprovedExternalPlugin(await approve(ownerCtx, first, firstSource("1.0.0"))),
  ).toEqual({ loaded: true });
  const update = {
    ...first,
    version: "1.1.0",
    urlTables: URL_TABLES,
    urlContributions: [{ slot: "host" }, { slot: "path-prefix" }],
    requestedCapabilities: ["cms_admin_schema", "url_slots"],
    capabilityReasons: { ...first.capabilityReasons, url_slots: "Prefix each market's pages" },
  };
  const refused = await activateApprovedExternalPlugin(
    await approve(ownerCtx, update, firstSource("1.1.0")),
  );
  expect(refused.loaded).toBe(false);
  expect(refused.reason).toContain(`already claimed by plugin "${SLUG}"`);
  // The running version was not retired: it is still the active one, and it runs.
  const version = await adapter.withAdminTransaction(system, async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT version FROM plugins WHERE slug = ${UPDATE_SLUG}`,
    )) as unknown as { version: string }[];
    return rows[0]?.version;
  });
  expect(version).toBe("1.0.0");
  expect(
    await runPluginOperation({
      invocation: { origin: "system", actorId: system.actorId },
      pluginSlug: UPDATE_SLUG,
      operationName: "ping",
      args: {},
    }),
  ).toMatchObject({ ok: true, value: { version: "1.0.0" } });
}, 120_000);

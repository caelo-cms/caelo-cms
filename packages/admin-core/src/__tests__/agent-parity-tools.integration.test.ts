// SPDX-License-Identifier: MPL-2.0

/**
 * Integration tests for the agent-tool-parity tools against real Postgres:
 * each tool dispatched through the default ToolRegistry as the AI actor on a
 * chat branch, exactly as the chat-runner and the Power-MCP dispatch it.
 *
 * Pins the op-level safety contracts the tools rely on:
 *  - modules.delete(_many): an AI cannot delete a placed module; the delete
 *    is BRANCHED (live row untouched until publish; merge applies it) and
 *    the chat stops listing the module;
 *  - media.delete_many: an asset embedded by this chat's unpublished module
 *    edit counts as in use;
 *  - imports.accept_page(s): branch-scoped + snapshotted (was raw SQL);
 *  - email_config.send_test: AI recipients restricted to the sender domain;
 *  - cleanup_import_run: queued for the AI, applied for the approving Owner.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { createDefaultToolRegistry, type ToolContext } from "../ai/tools/index.js";
import { setMediaStorage } from "../media/storage.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const P = "parity-int";
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: `${P}-sys`,
};
const AI_ACTOR = "00000000-0000-0000-0000-000000000a1a";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let toolCtx: ToolContext;
const tools = createDefaultToolRegistry();
let templateId: string;

async function sqlAdmin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await sqlAdmin(async (tx) => {
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${P}%`}`;
    await tx`DELETE FROM experiments WHERE slug LIKE ${`${P}%`}`;
    await tx`DELETE FROM import_runs WHERE source_url LIKE ${`https://${P}%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${P}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${P}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${`${P}%`} OR display_name LIKE ${`${P}%`})`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${P}%`} OR display_name LIKE ${`${P}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${P}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${P}%`}`;
    await tx`DELETE FROM media_assets WHERE original_name LIKE ${`${P}%`}`;
    await tx`DELETE FROM domains WHERE hostname LIKE ${`${P}%`}`;
    await tx`DELETE FROM provisioning_outputs WHERE environment = 'dev' AND provider = 'self-hosted'`;
  });
}

async function ok<T>(name: string, input: unknown, ctx: ExecutionContext = SYSTEM): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** A chat session's AI context (branch + task), as the chat-runner builds it. */
async function openChat(label: string): Promise<{ ai: ExecutionContext; chatSessionId: string }> {
  const s = await ok<{ chatSessionId: string; chatBranchId: string }>("chat.create_session", {
    title: `${P}-${label}`,
  });
  return {
    chatSessionId: s.chatSessionId,
    ai: {
      actorId: AI_ACTOR,
      actorKind: "ai",
      requestId: `${P}-${label}`,
      chatBranchId: s.chatBranchId,
      chatTaskId: s.chatSessionId,
    },
  };
}

async function dispatch(name: string, args: unknown, ctx: ExecutionContext) {
  return tools.dispatch(name, args, ctx, {
    ...toolCtx,
    ...(ctx.chatTaskId ? { chatSessionId: ctx.chatTaskId } : {}),
    ...(ctx.chatBranchId ? { chatBranchId: ctx.chatBranchId } : {}),
  });
}

async function seedModule(slug: string, html = "<p>parity</p>"): Promise<string> {
  const m = await ok<{ moduleId: string }>("modules.create", {
    slug,
    displayName: slug,
    html,
    fields: [{ name: "body", kind: "text", label: "Body" }],
  });
  return m.moduleId;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  toolCtx = { adapter, registry };
  await wipe();
  const t = await ok<{ templateId: string }>("templates.create", {
    slug: `${P}-tpl`,
    displayName: "Parity template",
    html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  templateId = t.templateId;
  await ok("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("delete_modules_many — branched delete + AI in-use guard", () => {
  it("refuses a placed module, deletes it on the branch once unplaced, and publish applies it", async () => {
    const moduleId = await seedModule(`${P}-hero`);
    const page = await ok<{ pageId: string }>("pages.create", {
      slug: `${P}-home`,
      title: "Parity home",
      templateId,
    });
    await ok("pages.set_modules", {
      pageId: page.pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    const { ai, chatSessionId } = await openChat("modules");

    const refused = await dispatch("delete_modules_many", { moduleIds: [moduleId] }, ai);
    expect(refused.ok).toBe(false);
    expect(refused.content).toContain("still placed");
    expect(refused.content).toContain(`${P}-home`);

    const unplaced = await dispatch(
      "remove_module_from",
      { target: "page", targetRef: `${P}-home`, moduleId },
      ai,
    );
    expect(unplaced.ok).toBe(true);

    const deleted = await dispatch("delete_modules_many", { moduleIds: [moduleId] }, ai);
    expect(deleted.ok).toBe(true);
    expect(deleted.content).toContain("Deleted 1 module(s)");

    // Branched: the live row is untouched until the operator publishes …
    const live = await sqlAdmin(
      (tx) => tx`SELECT deleted_at FROM modules WHERE id = ${moduleId}::uuid`,
    );
    expect((live as unknown as { deleted_at: Date | null }[])[0]?.deleted_at).toBeNull();
    // … the chat no longer lists it, main still does …
    const inChat = await ok<{ modules: { id: string }[] }>("modules.list", {}, ai);
    expect(inChat.modules.some((m) => m.id === moduleId)).toBe(false);
    const onMain = await ok<{ modules: { id: string }[] }>("modules.list", {});
    expect(onMain.modules.some((m) => m.id === moduleId)).toBe(true);
    // … a second delete is idempotent …
    const again = await dispatch("delete_modules_many", { moduleIds: [moduleId] }, ai);
    expect(again.content).toContain("1 were already deleted");

    // … and publishing the chat applies the delete to main.
    await ok("chat.merge_to_main", { chatSessionId });
    const merged = await sqlAdmin(
      (tx) => tx`SELECT deleted_at FROM modules WHERE id = ${moduleId}::uuid`,
    );
    expect((merged as unknown as { deleted_at: Date | null }[])[0]?.deleted_at).not.toBeNull();
  });

  it("a human (panel) delete keeps the direct, unguarded path", async () => {
    const moduleId = await seedModule(`${P}-panel`);
    await ok("modules.delete", { moduleId });
    const live = await sqlAdmin(
      (tx) => tx`SELECT deleted_at FROM modules WHERE id = ${moduleId}::uuid`,
    );
    expect((live as unknown as { deleted_at: Date | null }[])[0]?.deleted_at).not.toBeNull();
  });
});

describe("delete_media_many — in-use guard sees this chat's unpublished edits", () => {
  it("blocks an asset embedded by a branched module edit and deletes an unused one", async () => {
    const upload = (name: string, sha: string) =>
      ok<{ assetId: string; slug: string }>("media.upload", {
        sha256: sha,
        originalName: `${P}-${name}.png`,
        name: `${P} ${name}`,
        mime: "image/png",
        sizeBytes: 10,
        width: 1,
        height: 1,
        storageKey: `${P}/${name}`,
        variants: [
          {
            variant: "original",
            format: "png",
            width: 1,
            height: 1,
            sizeBytes: 10,
            storageKey: `${P}/${name}`,
          },
        ],
      });
    const used = await upload("used", "a".repeat(64));
    const unused = await upload("unused", "b".repeat(64));
    const moduleId = await seedModule(`${P}-gallery`);
    const { ai } = await openChat("media");
    // Branched edit: the live usage_count stays 0 until publish.
    await ok(
      "modules.update",
      { moduleId, html: `<img src="/_caelo/media/${used.slug}/w800.webp" alt="">` },
      ai,
    );

    const r = await dispatch("delete_media_many", { assetIds: [used.assetId, unused.assetId] }, ai);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Deleted 1 of 2");
    expect(r.content).toContain(`${used.assetId}: still used by ${P}-gallery`);
    const rows = await sqlAdmin(
      (tx) =>
        tx`SELECT id::text AS id, deleted_at FROM media_assets WHERE id IN (${used.assetId}::uuid, ${unused.assetId}::uuid)`,
    );
    const byId = new Map(
      (rows as unknown as { id: string; deleted_at: Date | null }[]).map((x) => [x.id, x]),
    );
    expect(byId.get(used.assetId)?.deleted_at).toBeNull();
    expect(byId.get(unused.assetId)?.deleted_at).not.toBeNull();
  });
});

describe("accept_import_pages — branch-scoped, snapshotted verbatim import", () => {
  async function seedRun(slug: string): Promise<{ runId: string; importPageId: string }> {
    const run = await ok<{ runId: string }>("imports.create_run", {
      sourceUrl: `https://${P}.example.com/${slug}`,
      depth: 1,
      maxPages: 5,
    });
    await ok("imports.write_extracted_pages", {
      runId: run.runId,
      pages: [
        {
          sourceUrl: `https://${P}.example.com/${slug}/about`,
          proposedSlug: `${P}-${slug}-about`,
          proposedTitle: "About",
          proposedModules: [
            { blockName: "header", position: 0, html: "<header>H</header>", displayName: "Header" },
            {
              blockName: "content",
              position: 1,
              html: "<main><p>We make tools.</p></main>",
              displayName: `${P} content`,
            },
          ],
          proposedThemeTokens: {},
        },
      ],
    });
    const got = await ok<{ pages: { id: string }[] }>("imports.get", { runId: run.runId });
    const importPageId = got.pages[0]?.id;
    if (!importPageId) throw new Error("import page missing");
    return { runId: run.runId, importPageId };
  }

  it("creates a draft page on the chat branch, links it, snapshots it, and refuses a second accept", async () => {
    const { importPageId } = await seedRun("accept");
    const { ai } = await openChat("accept");
    const r = await dispatch(
      "accept_import_pages",
      { importPageIds: [importPageId], templateId },
      ai,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain(`${P}-accept-about`);

    const pages = (await sqlAdmin(
      (tx) =>
        tx`SELECT id::text AS id, status, chat_branch_id::text AS branch FROM pages WHERE slug = ${`${P}-accept-about`}`,
    )) as unknown as { id: string; status: string; branch: string | null }[];
    expect(pages).toHaveLength(1);
    expect(pages[0]?.status).toBe("draft");
    expect(pages[0]?.branch).toBe(ai.chatBranchId ?? null);
    const pageId = pages[0]?.id as string;

    const link = (await sqlAdmin(
      (tx) =>
        tx`SELECT accepted_page_id::text AS p FROM import_pages WHERE id = ${importPageId}::uuid`,
    )) as unknown as { p: string | null }[];
    expect(link[0]?.p).toBe(pageId);
    const snaps = (await sqlAdmin(
      (tx) => tx`
        SELECT count(*)::int AS c FROM page_snapshots ps
        JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
        WHERE ps.page_id = ${pageId}::uuid AND ss.chat_branch_id = ${ai.chatBranchId as string}::uuid`,
    )) as unknown as { c: number }[];
    expect(snaps[0]?.c).toBeGreaterThan(0);

    const twice = await dispatch("accept_import_pages", { importPageIds: [importPageId] }, ai);
    expect(twice.ok).toBe(false);
    expect(twice.content).toContain("already accepted");
  });

  it("cleanup_import_run is queued for the AI and applied for the approving Owner", async () => {
    const { runId, importPageId } = await seedRun("cleanup");
    const { ai } = await openChat("cleanup");
    const queued = await dispatch("cleanup_import_run", { runId }, ai);
    expect(queued.ok).toBe(true);
    expect(queued.content).toMatch(/^Queued proposal [0-9a-f-]{36}:/);
    const still = (await sqlAdmin(
      (tx) => tx`SELECT count(*)::int AS c FROM import_pages WHERE id = ${importPageId}::uuid`,
    )) as unknown as { c: number }[];
    expect(still[0]?.c).toBe(1);

    setMediaStorage({ delete: async () => undefined } as never);
    const applied = await dispatch("cleanup_import_run", { runId }, SYSTEM);
    expect(applied.ok).toBe(true);
    const gone = (await sqlAdmin(
      (tx) => tx`SELECT count(*)::int AS c FROM import_pages WHERE id = ${importPageId}::uuid`,
    )) as unknown as { c: number }[];
    expect(gone[0]?.c).toBe(0);
  });
});

describe("create_experiment / list_experiments / get_experiment_results", () => {
  it("creates a draft the AI can find and read results for", async () => {
    const page = await ok<{ pageId: string }>("pages.create", {
      slug: `${P}-exp`,
      title: "Experiment page",
      templateId,
    });
    const { ai } = await openChat("exp");
    const created = await dispatch(
      "create_experiment",
      {
        slug: `${P}-cta`,
        pageId: page.pageId,
        variants: [
          { label: "control", weight: 0.5 },
          { label: "b", weight: 0.5, htmlPatches: [{ find: "Sign up", replace: "Try it" }] },
        ],
      },
      ai,
    );
    expect(created.ok).toBe(true);
    const experimentId = (created.value as { experimentId: string }).experimentId;

    const listed = await dispatch("list_experiments", { status: "draft" }, ai);
    expect(listed.content).toContain(`${P}-cta`);
    const results = await dispatch("get_experiment_results", { experimentId }, ai);
    expect(results.ok).toBe(true);
    expect(results.content).toContain("No visitors assigned yet");

    const badWeights = await dispatch(
      "create_experiment",
      {
        slug: `${P}-bad`,
        pageId: page.pageId,
        variants: [
          { label: "a", weight: 0.5 },
          { label: "b", weight: 0.2 },
        ],
      },
      ai,
    );
    expect(badWeights.ok).toBe(false);
    expect(badWeights.content).toContain("sum to 1");
  });
});

describe("verify_domains / verify_dns_records", () => {
  it("reports an unresolvable registered domain as not resolved", async () => {
    await ok("domains.add", { hostname: `${P}-site.invalid`, kind: "public" });
    const { ai } = await openChat("dns");
    const r = await dispatch("verify_domains", { hostnames: [`${P}-site.invalid`] }, ai);
    expect(r.ok).toBe(true);
    expect(r.content).toContain(`${P}-site.invalid (public): not resolved yet`);
  });

  it("checks the installer's required records by default and keeps the AI denylist", async () => {
    await ok("provisioning_outputs.set", {
      provider: "self-hosted",
      environment: "dev",
      outputs: {
        dnsRecordsRequired: [
          { hostname: `${P}-cert.invalid`, type: "TXT", value: "token", purpose: "certificate" },
        ],
      },
    });
    const { ai } = await openChat("dns-records");
    const r = await dispatch("verify_dns_records", { environment: "dev" }, ai);
    expect(r.content).toContain(`TXT ${P}-cert.invalid (certificate): pending`);
    const denied = await dispatch(
      "verify_dns_records",
      { records: [{ hostname: "db.internal", type: "A", expectedValue: "10.0.0.1" }] },
      ai,
    );
    expect(denied.ok).toBe(false);
    expect(denied.content).toContain("denylist");
  });
});

describe("send_test_email", () => {
  it("fails loudly on transport none and keeps AI recipients on the sender's domain", async () => {
    const before = await ok<{
      config: { transport: string; fromAddress: string; config: Record<string, unknown> };
    }>("email_config.get", {});
    const { ai } = await openChat("email");
    try {
      await ok("email_config.set", { transport: "none", fromAddress: "", config: {} });
      const none = await dispatch("send_test_email", { to: "team@example.com" }, ai);
      expect(none.ok).toBe(false);
      expect(none.content).toContain("transport is `none`");

      await ok("email_config.set", {
        transport: "resend",
        fromAddress: "Site <noreply@example.com>",
        config: { apiKey: "re_parity_test_key" },
      });
      // Refused before any provider call — no network in this test.
      const foreign = await dispatch("send_test_email", { to: "someone@other.org" }, ai);
      expect(foreign.ok).toBe(false);
      expect(foreign.content).toContain("@example.com");
    } finally {
      await ok("email_config.set", {
        transport: before.config.transport,
        fromAddress: before.config.fromAddress,
        config: before.config.config,
      });
    }
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 Part C — the Open changes overview and its multi-chat Stage,
 * against a real Postgres and real self-hosted staging builds.
 *
 *   chat.list_open_changes  lists every open chat with unstaged changes or
 *                           held entities (own + other editors'), with the
 *                           change refs, locks and takeovers per chat.
 *   stageChatSessions       stages a SELECTION of chats in one Stage: each
 *                           merged, ONE staging build, each finalized, ONE
 *                           audit with the classifications combined; chats
 *                           left out stay pending.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { listUnpublishedChangesTool } from "../ai/tools/history-tools.js";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { stageChatSessions } from "../stage/stage-chats.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const OWNER_ID = crypto.randomUUID();
const OTHER_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t620-stage" };
const OTHER: ExecutionContext = { actorId: OTHER_ID, actorKind: "human", requestId: "t620-other" };
const PFX = "t620-stage-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prevSkip: string | undefined;
let prevOutputRoot: string | undefined;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLang: (() => Promise<void>) | null = null;
const moduleIds: string[] = [];

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    let out: T | undefined;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      out = await fn(tx as unknown as SQL);
    });
    return out as T;
  } finally {
    await sql.end();
  }
}

/** Templates survive the per-file reset (seed-bearing) — drop ours. */
async function wipeTemplates(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT p.id FROM pages p JOIN templates t ON t.id = p.template_id WHERE t.slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
  });
}

async function seedUser(id: string, role: string): Promise<void> {
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${id}::uuid, 'human', ${`t620 ${role}`})
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${id}::uuid, ${`${id}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${id}::uuid, id FROM roles WHERE name = ${role}`;
  });
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function openChat(
  ctx: ExecutionContext,
  title: string,
): Promise<{ id: string; branch: ExecutionContext }> {
  const s = await op<{ chatSessionId: string; chatBranchId: string }>(ctx, "chat.create_session", {
    title: `${PFX}${title}`,
  });
  return { id: s.chatSessionId, branch: { ...ctx, chatBranchId: s.chatBranchId } };
}

interface OpenChatRow {
  chatSessionId: string;
  isMine: boolean;
  pendingCount: number;
  locks: { entityKind: string; entityId: string }[];
  takeovers: { direction: string; otherChatTitle: string }[];
}

async function openChanges(ctx: ExecutionContext, mineOnly = false): Promise<OpenChatRow[]> {
  return (await op<{ chats: OpenChatRow[] }>(ctx, "chat.list_open_changes", { mineOnly })).chats;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await wipeTemplates();
  await seedUser(OWNER_ID, "owner");
  await seedUser(OTHER_ID, "owner");
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLang = await pinSiteLanguage(ADMIN_URL as string, "en");
  testRoot = await mkdtemp(join(tmpdir(), "caelo-t620-stage-"));
  prevSkip = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  prevOutputRoot = process.env.CAELO_OUTPUT_ROOT;
  process.env.CAELO_OUTPUT_ROOT = testRoot;

  const { templateId } = await op<{ templateId: string }>(OWNER, "templates.create", {
    slug: `${PFX}tpl`,
    displayName: "T",
    html: `<!doctype html><html lang="en"><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  await op(OWNER, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  for (const slug of ["one", "two", "three"]) {
    moduleIds.push(
      (
        await op<{ moduleId: string }>(OWNER, "modules.create", {
          slug: `${PFX}${slug}`,
          displayName: slug,
          html: `<p>${slug} v0</p>`,
        })
      ).moduleId,
    );
  }
  const { pageId } = await op<{ pageId: string }>(OWNER, "pages.create", {
    slug: "home",
    title: "home",
    templateId,
    status: "published",
  });
  await op(OWNER, "pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds }],
  });
});

afterAll(async () => {
  if (prevSkip === undefined) delete process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  else process.env.CAELO_SKIP_STAGING_SERVE_CHECK = prevSkip;
  if (prevOutputRoot === undefined) delete process.env.CAELO_OUTPUT_ROOT;
  else process.env.CAELO_OUTPUT_ROOT = prevOutputRoot;
  await wipeTemplates();
  await restoreBase?.();
  await restoreLang?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("#620 Open changes + multi-chat Stage", () => {
  it("lists every open chat's changes and locks, marks whose chat it is, and stages a selection", async () => {
    const [m1, m2, m3] = moduleIds as [string, string, string];
    const a = await openChat(OWNER, "Header work");
    const b = await openChat(OWNER, "Footer work");
    const c = await openChat(OWNER, "Half-finished");
    const other = await openChat(OTHER, "Colleague");
    const idle = await openChat(OWNER, "Just talking");
    await op(a.branch, "modules.update", { moduleId: m1, html: "<p>one from A</p>" });
    await op(b.branch, "modules.update", { moduleId: m2, html: "<p>two from B</p>" });
    await op(c.branch, "modules.update", { moduleId: m3, html: "<p>three half done</p>" });
    await op(other.branch, "pages.update", {
      pageId: (
        await withSql(
          (tx) =>
            tx`SELECT id::text AS id FROM pages WHERE slug = 'home'` as Promise<{ id: string }[]>,
        )
      )[0]?.id,
      title: "home by colleague",
    });

    const listed = await openChanges(OWNER);
    const byId = new Map(listed.map((r) => [r.chatSessionId, r]));
    for (const own of [a, b, c]) {
      expect(byId.get(own.id)).toMatchObject({ isMine: true, pendingCount: 1 });
      expect(byId.get(own.id)?.locks.map((l) => l.entityKind)).toEqual(["module"]);
    }
    expect(byId.get(other.id)?.isMine).toBe(false);
    // A chat with nothing unstaged and nothing held is just a conversation.
    expect(byId.has(idle.id)).toBe(false);
    expect((await openChanges(OWNER, true)).some((r) => r.chatSessionId === other.id)).toBe(false);

    // Stage A + B together; C (half-finished) stays out.
    const staged = await stageChatSessions({ registry, adapter }, OWNER, [a.id, b.id]);
    if (!staged.ok) throw new Error(`stage: ${JSON.stringify(staged.error)}`);
    expect(staged.value.chats.map((x) => x.entityCount)).toEqual([1, 1]);
    expect(staged.value.mergedEntityCount).toBe(2);

    const runs = await withSql(
      (tx) =>
        tx`
        SELECT r.id::text AS id FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
        WHERE t.env = 'staging' AND r.status = 'succeeded'
      ` as Promise<{ id: string }[]>,
    );
    expect(runs.map((r) => r.id)).toEqual([staged.value.runId]);
    const audits = await withSql(
      (tx) =>
        tx`
        SELECT chat_session_id::text AS chat, classification FROM quality_audit_runs
        WHERE deploy_run_id = ${staged.value.runId}::uuid
      ` as Promise<{ chat: string; classification: { reasons: { entityId: string | null }[] } }[]>,
    );
    expect(audits).toHaveLength(1);
    expect([a.id, b.id]).toContain(audits[0]?.chat as string);

    const live = await withSql(
      (tx) =>
        tx`
        SELECT id::text AS id, html FROM modules WHERE id IN (${m1}::uuid, ${m2}::uuid, ${m3}::uuid)
      ` as Promise<{ id: string; html: string }[]>,
    );
    const html = new Map(live.map((r) => [r.id, r.html]));
    expect(html.get(m1)).toBe("<p>one from A</p>");
    expect(html.get(m2)).toBe("<p>two from B</p>");
    expect(html.get(m3)).not.toContain("half done");

    const after = new Map((await openChanges(OWNER)).map((r) => [r.chatSessionId, r]));
    expect(after.has(a.id)).toBe(false);
    expect(after.has(b.id)).toBe(false);
    expect(after.get(c.id)?.pendingCount).toBe(1);
  });

  it("refuses another editor's chat without staging anything", async () => {
    const mine = await openChat(OWNER, "Mine");
    const theirs = await openChat(OTHER, "Theirs");
    const [m1] = moduleIds as [string];
    await op(mine.branch, "modules.update", { moduleId: m1, html: "<p>mine</p>" });
    const before = await withSql(
      (tx) => tx`SELECT count(*)::int AS n FROM deploy_runs` as Promise<{ n: number }[]>,
    );
    // Mine first: the selection is verified before anything merges, so my
    // chat is not left merged-but-unconsumed by the refusal.
    const r = await stageChatSessions({ registry, adapter }, OWNER, [mine.id, theirs.id]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.step).toBe("select");
    expect(r.error.chatSessionId).toBe(theirs.id);
    const afterRuns = await withSql(
      (tx) => tx`SELECT count(*)::int AS n FROM deploy_runs` as Promise<{ n: number }[]>,
    );
    expect(afterRuns[0]?.n).toBe(before[0]?.n);
    const live = await withSql(
      (tx) => tx`SELECT html FROM modules WHERE id = ${m1}::uuid` as Promise<{ html: string }[]>,
    );
    expect(live[0]?.html).not.toBe("<p>mine</p>");
  });

  it("lists and stages a chat whose only change is a theme edit (PR #622 review)", async () => {
    const t = await openChat(OWNER, "Theme only");
    await op(t.branch, "themes.update_tokens", {
      themeSlug: "site-default",
      set: { fontBody: "serif" },
    });
    const row = (await openChanges(OWNER)).find((r) => r.chatSessionId === t.id);
    expect(row?.pendingCount).toBe(1);
    const staged = await stageChatSessions({ registry, adapter }, OWNER, [t.id]);
    if (!staged.ok) throw new Error(JSON.stringify(staged.error));
    expect(staged.value.mergedEntityCount).toBe(1);
  });

  it("keeps an older chat with open work although many newer chats are idle (PR #622 review)", async () => {
    const [m1] = moduleIds as [string];
    const old = await openChat(OWNER, "Old but open");
    await op(old.branch, "modules.update", { moduleId: m1, html: "<p>old open work</p>" });
    for (let i = 0; i < 101; i += 1) await openChat(OWNER, `idle ${i}`);
    expect((await openChanges(OWNER)).some((r) => r.chatSessionId === old.id)).toBe(true);
  });

  it("marks the operator's own chats as theirs in the AI's view (PR #622 review)", async () => {
    const mine = await openChat(OWNER, "Seen by the AI");
    const [, m2] = moduleIds as [string, string];
    await op(mine.branch, "modules.update", { moduleId: m2, html: "<p>for the AI view</p>" });
    // The chat-runner's AI ctx may carry an AI actor; the human ctx is the operator.
    const aiCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "t620-ai-view",
      chatBranchId: mine.branch.chatBranchId,
      chatTaskId: mine.id,
    };
    const r = await listUnpublishedChangesTool.handler(
      aiCtx,
      { allChats: true },
      { registry, adapter, chatSessionId: mine.id, humanCtx: OWNER },
    );
    expect(r.ok).toBe(true);
    const line = r.content.split("\n").find((l) => l.includes(mine.id)) ?? "";
    expect(line).toContain("Seen by the AI");
    expect(line).not.toContain("[another editor]");
  });
});

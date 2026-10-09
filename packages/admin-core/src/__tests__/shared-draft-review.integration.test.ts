// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 (PR #624 review) — regressions for the shared draft's
 * edges, against a real Postgres and real self-hosted staging builds:
 *
 *   - the draft tools run in the browser chat, where the AI actor is not
 *     the chat's creator (they act under the operator's context; the Stage
 *     still opens the AI hold);
 *   - layout chrome placed in a chat is draft state (not live, undoable,
 *     replayed by a Stage) and an AI Stage opens the hold whatever it merged;
 *   - a Stage takes along the rows another chat created that it references;
 *   - an undo of a chat that created a page warns about the page's later
 *     section changes by another chat;
 *   - a Stage merges exactly the classified headers and marks exactly the
 *     merged headers staged;
 *   - revert_chat_changes finds the snapshot right before the chat by owner;
 *   - a status flip is the flipping chat's own change;
 *   - a draft chat with unstaged changes cannot be archived.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import {
  stageChangesTool,
  startIsolatedBranchTool,
  undoThisChatTool,
} from "../ai/tools/draft-tools.js";
import { revertChatChangesTool } from "../ai/tools/revert-chat-changes.js";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { stageChatSessions } from "../stage/stage-chats.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const OWNER_ID = crypto.randomUUID();
/** The browser chat's AI actor — NOT the chat's creator. */
const AI_ID = crypto.randomUUID();
const OWNER: ExecutionContext = { actorId: OWNER_ID, actorKind: "human", requestId: "t620-rv" };
const PFX = "t620-rv-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let prevSkip: string | undefined;
let prevOutputRoot: string | undefined;
let restoreBase: (() => Promise<void>) | null = null;
let restoreLang: (() => Promise<void>) | null = null;
let templateId: string;

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

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** Run a write that may first meet a draft version conflict ("re-read, then redo"). */
async function writeWithReread<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const first = await execute(registry, adapter, ctx, name, input);
  if (first.ok) return first.value as T;
  if (first.error.kind !== "HandlerError" || !first.error.message.startsWith("Conflict:")) {
    throw new Error(`${name}: ${JSON.stringify(first.error)}`);
  }
  return op<T>(ctx, name, input);
}

interface Chat {
  id: string;
  branch: string;
  /** The browser chat's AI context: AI actor, chat task, chat branch. */
  ai: ExecutionContext;
}

async function chat(title: string): Promise<Chat> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(
    OWNER,
    "chat.create_session",
    { title: `${PFX}${title}` },
  );
  return {
    id: v.chatSessionId,
    branch: v.chatBranchId,
    ai: {
      actorId: AI_ID,
      actorKind: "ai",
      requestId: `t620-rv-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

/** The tool context the chat-runner hands a tool: the operator rides along as humanCtx. */
function toolCtx(c: Chat) {
  return {
    registry,
    adapter,
    chatSessionId: c.id,
    chatBranchId: c.branch,
    humanCtx: { ...OWNER, chatBranchId: c.branch },
  };
}

async function seedModule(slug: string): Promise<string> {
  return (
    await op<{ moduleId: string }>(OWNER, "modules.create", {
      slug: `${PFX}${slug}`,
      displayName: slug,
      html: `<p>${slug} v0</p>`,
    })
  ).moduleId;
}

async function seedPage(slug: string, moduleIds: string[]): Promise<string> {
  const { pageId } = await op<{ pageId: string }>(OWNER, "pages.create", {
    slug,
    title: slug,
    templateId,
    status: "published",
  });
  await op(OWNER, "pages.set_modules", { pageId, blocks: [{ blockName: "content", moduleIds }] });
  return pageId;
}

async function openHolds(): Promise<number> {
  const rows = await withSql(
    (tx) =>
      tx`SELECT count(*)::int AS n FROM ai_stage_holds WHERE released_at IS NULL` as Promise<
        { n: number }[]
      >,
  );
  return rows[0]?.n ?? 0;
}

async function chatPending(chatSessionId: string): Promise<number> {
  const rows = await withSql(
    (tx) =>
      tx`SELECT count(*)::int AS n FROM site_snapshots
         WHERE caelo_chat_owner(chat_task_id) = ${chatSessionId}::uuid
           AND staged_at IS NULL AND undone_at IS NULL` as Promise<{ n: number }[]>,
  );
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  await wipeTemplates();
  await withSql(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${OWNER_ID}::uuid, 'human', 't620 rv owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${OWNER_ID}::uuid, ${`${OWNER_ID}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${OWNER_ID}::uuid, id FROM roles WHERE name = 'owner'`;
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${AI_ID}::uuid, 'ai', 't620 rv ai')`;
  });
  restoreBase = await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com");
  restoreLang = await pinSiteLanguage(ADMIN_URL as string, "en");
  testRoot = await mkdtemp(join(tmpdir(), "caelo-t620-rv-"));
  prevSkip = process.env.CAELO_SKIP_STAGING_SERVE_CHECK;
  process.env.CAELO_SKIP_STAGING_SERVE_CHECK = "1";
  prevOutputRoot = process.env.CAELO_OUTPUT_ROOT;
  process.env.CAELO_OUTPUT_ROOT = testRoot;

  templateId = (
    await op<{ templateId: string }>(OWNER, "templates.create", {
      slug: `${PFX}tpl`,
      displayName: "T",
      html: `<!doctype html><html lang="en"><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
  await op(OWNER, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  // The staging build needs a homepage.
  await seedPage("home", [await seedModule("home-hero")]);
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

describe("#620 review — the draft tools in the browser chat", () => {
  it("stage_changes, undo_this_chat and start_isolated_branch work with the AI actor plus the operator's context", async () => {
    const m = await seedModule("tool-stage");
    const a = await chat("Stage from the chat");
    await op(a.ai, "modules.update", { moduleId: m, html: "<p>staged by the AI</p>" });
    const holdsBefore = await openHolds();
    const staged = await stageChangesTool.handler(
      a.ai,
      { scope: "this_chat" },
      { ...toolCtx(a), operatorBrowserAttached: true },
    );
    expect(staged.ok).toBe(true);
    expect(staged.content).toContain("Staged 1 change");
    // The operator's open chat delivers the check's result; polling it
    // cost the real-AI homepage turn 19 full model calls (PR #624).
    expect(staged.content).toContain("do NOT poll get_quality_audit");
    // The AI initiated it: the production hold is open although the ops ran
    // under the operator's context.
    expect(await openHolds()).toBe(holdsBefore + 1);
    const live = await withSql(
      (tx) => tx`SELECT html FROM modules WHERE id = ${m}::uuid` as Promise<{ html: string }[]>,
    );
    expect(live[0]?.html).toBe("<p>staged by the AI</p>");

    const b = await chat("Undo from the chat");
    await op(b.ai, "modules.update", { moduleId: m, html: "<p>to be undone</p>" });
    const undone = await undoThisChatTool.handler(b.ai, {}, toolCtx(b));
    expect(undone.ok).toBe(true);
    expect(undone.content).toContain("Undid this chat's unstaged changes");
    expect(await chatPending(b.id)).toBe(0);

    const c = await chat("Isolate from the chat");
    const isolated = await startIsolatedBranchTool.handler(
      c.ai,
      { reason: "experiment" },
      toolCtx(c),
    );
    expect(isolated.ok).toBe(true);
    const kind = await withSql(
      (tx) =>
        tx`SELECT branch_kind FROM chat_sessions WHERE id = ${c.id}::uuid` as Promise<
          { branch_kind: string }[]
        >,
    );
    expect(kind[0]?.branch_kind).toBe("experiment");
  });

  it("opens the AI hold for an AI Stage that merged nothing (it still triggered the staging build)", async () => {
    const idle = await chat("Nothing to stage");
    const before = await openHolds();
    const staged = await stageChatSessions({ registry, adapter }, OWNER, [idle.id], {
      aiInitiated: true,
    });
    if (!staged.ok) throw new Error(JSON.stringify(staged.error));
    expect(staged.value.mergedEntityCount).toBe(0);
    expect(await openHolds()).toBe(before + 1);
  });
});

describe("#620 review — layout chrome is draft state", () => {
  it("is not live, shows in the chat's view, is undone by an undo and replayed by an AI Stage that opens the hold", async () => {
    const layout = await withSql(
      (tx) =>
        tx`SELECT id::text AS id FROM layouts WHERE slug = 'centered'` as Promise<{ id: string }[]>,
    );
    const layoutId = layout[0]?.id;
    if (!layoutId) throw new Error("seeded layout 'centered' missing");
    const chrome = await seedModule("chrome-header");
    const liveHeader = async (): Promise<string[]> =>
      (
        await withSql(
          (tx) =>
            tx`SELECT module_id::text AS id FROM layout_modules
               WHERE layout_id = ${layoutId}::uuid AND block_name = 'header' ORDER BY position` as Promise<
              { id: string }[]
            >,
        )
      ).map((r) => r.id);
    const before = await liveHeader();
    const viewOf = async (ctx: ExecutionContext): Promise<string[]> =>
      (
        await op<{ moduleIds: string[] }>(ctx, "layout_modules.get", {
          layoutId,
          blockName: "header",
        })
      ).moduleIds;

    const d = await chat("Header experiment");
    await op(d.ai, "layout_modules.set", { layoutId, blockName: "header", moduleIds: [chrome] });
    expect(await liveHeader()).toEqual(before);
    expect(await viewOf(d.ai)).toEqual([chrome]);
    expect(await viewOf(OWNER)).toEqual(before);

    const undone = await op<{ applied: boolean; undoneSnapshots: number }>(
      OWNER,
      "chat.undo_changes",
      { chatSessionId: d.id },
    );
    expect(undone).toMatchObject({ applied: true, undoneSnapshots: 1 });
    expect(await viewOf(d.ai)).toEqual(before);
    expect(await liveHeader()).toEqual(before);

    const e = await chat("Header for real");
    await writeWithReread(e.ai, "layout_modules.set", {
      layoutId,
      blockName: "header",
      moduleIds: [chrome],
    });
    const holds = await openHolds();
    const staged = await stageChatSessions({ registry, adapter }, OWNER, [e.id], {
      aiInitiated: true,
    });
    if (!staged.ok) throw new Error(JSON.stringify(staged.error));
    expect(staged.value.mergedEntityCount).toBe(1);
    expect(await liveHeader()).toEqual([chrome]);
    expect(await openHolds()).toBe(holds + 1);

    await op(OWNER, "layout_modules.set", { layoutId, blockName: "header", moduleIds: before });
  });
});

describe("#620 review — closures", () => {
  it("a Stage takes along a module another chat created in the draft when it places it", async () => {
    const base = await seedModule("closure-base");
    const pageId = await seedPage(`${PFX}closure`, [base]);
    const a = await chat("Builds a module");
    const b = await chat("Places it");
    const created = (
      await op<{ moduleId: string }>(a.ai, "modules.create", {
        slug: `${PFX}made-by-a`,
        displayName: "Made by A",
        html: "<p>new module</p>",
      })
    ).moduleId;
    await writeWithReread(b.ai, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [base, created] }],
    });

    const staged = await stageChatSessions({ registry, adapter }, OWNER, [b.id]);
    if (!staged.ok) throw new Error(JSON.stringify(staged.error));
    expect(staged.value.alsoIncludes.map((x) => x.title)).toContain(`${PFX}Builds a module`);
    const module = await withSql(
      (tx) =>
        tx`SELECT chat_branch_id::text AS branch, deleted_at FROM modules WHERE id = ${created}::uuid` as Promise<
          { branch: string | null; deleted_at: unknown }[]
        >,
    );
    // Graduated to main with the placement — not left behind in the draft.
    expect(module[0]).toMatchObject({ branch: null, deleted_at: null });
    const placed = await withSql(
      (tx) =>
        tx`SELECT count(*)::int AS n FROM page_modules
           WHERE page_id = ${pageId}::uuid AND module_id = ${created}::uuid` as Promise<
          { n: number }[]
        >,
    );
    expect(placed[0]?.n).toBe(1);
  });

  it("an undo of a chat that created a page warns about another chat's later sections on it", async () => {
    const a = await chat("Creates a page");
    const b = await chat("Fills its sections");
    const { pageId } = await op<{ pageId: string }>(a.ai, "pages.create", {
      slug: `${PFX}made-by-a`,
      title: "Made by A",
      templateId,
      status: "draft",
    });
    const filler = await seedModule("filler");
    await writeWithReread(b.ai, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [filler] }],
    });
    const refused = await op<{ applied: boolean; overlap: { title: string }[] }>(
      OWNER,
      "chat.undo_changes",
      { chatSessionId: a.id },
    );
    expect(refused.applied).toBe(false);
    expect(refused.overlap.map((o) => o.title)).toContain(`${PFX}Fills its sections`);
    const confirmed = await op<{ applied: boolean }>(OWNER, "chat.undo_changes", {
      chatSessionId: a.id,
      confirmOverlap: true,
    });
    expect(confirmed.applied).toBe(true);
    expect(await chatPending(b.id)).toBe(0);
  });
});

describe("#620 review — a Stage merges and consumes exact header sets", () => {
  it("merges only the classified headers and marks only the merged ones staged", async () => {
    const x = await seedModule("exact-x");
    const y = await seedModule("exact-y");
    const f = await chat("Exact set");
    await op(f.ai, "modules.update", { moduleId: x, html: "<p>x classified</p>" });
    const classified = await op<{ headerIds: string[] }>(OWNER, "quality_audits.classify_stage", {
      chatSessionIds: [f.id],
    });
    expect(classified.headerIds).toHaveLength(1);
    // A change committed after the classification: not audited, not merged.
    await op(f.ai, "modules.update", { moduleId: y, html: "<p>y after the check</p>" });
    const merged = await op<{ mergedAt: string; mergedHeaderIds: string[] }>(
      OWNER,
      "chat.merge_draft_to_main",
      { chatSessionIds: [f.id], deferConsume: true, headerIds: classified.headerIds },
    );
    expect(merged.mergedHeaderIds).toEqual(classified.headerIds);
    const live = await withSql(
      (tx) =>
        tx`SELECT id::text AS id, html FROM modules WHERE id IN (${x}::uuid, ${y}::uuid)` as Promise<
          { id: string; html: string }[]
        >,
    );
    const html = new Map(live.map((r) => [r.id, r.html]));
    expect(html.get(x)).toBe("<p>x classified</p>");
    expect(html.get(y)).not.toContain("after the check");

    // A write whose transaction started before the merge but committed
    // after it: created_at before mergedAt, never merged.
    const late = await withSql(
      (tx) =>
        tx`INSERT INTO site_snapshots (actor_id, op_kind, description, chat_task_id, chat_branch_id, created_at)
           VALUES (${OWNER_ID}::uuid, 'modules.update', 'late commit', ${f.id}::uuid, ${f.branch}::uuid,
                   ${merged.mergedAt}::timestamptz - interval '1 second')
           RETURNING id::text AS id` as Promise<{ id: string }[]>,
    );
    await op(OWNER, "chat.finalize_draft_stage", {
      chatSessionIds: [f.id],
      stagedAt: merged.mergedAt,
      headerIds: merged.mergedHeaderIds,
    });
    const states = await withSql(
      (tx) =>
        tx`SELECT id::text AS id, staged_at IS NOT NULL AS staged FROM site_snapshots
           WHERE caelo_chat_owner(chat_task_id) = ${f.id}::uuid` as Promise<
          { id: string; staged: boolean }[]
        >,
    );
    const staged = new Map(states.map((r) => [r.id, r.staged]));
    expect(staged.get(classified.headerIds[0] as string)).toBe(true);
    expect(staged.get(late[0]?.id as string)).toBe(false);
    expect(await chatPending(f.id)).toBe(2);

    // A classified set that moved on (a header got staged meanwhile) is
    // refused — the Stage flow classifies again.
    const stale = await execute(registry, adapter, OWNER, "chat.merge_draft_to_main", {
      chatSessionIds: [f.id],
      deferConsume: true,
      headerIds: classified.headerIds,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok && stale.error.kind === "HandlerError") {
      expect(stale.error.message).toStartWith("Conflict: the changes to stage moved on");
    }
  });
});

describe("#620 review — attribution on the shared draft", () => {
  it("revert_chat_changes rewinds to the snapshot right before the chat, another chat's draft change included", async () => {
    const m1 = await seedModule("revert-1");
    const m2 = await seedModule("revert-2");
    const h = await chat("Earlier draft chat");
    const g = await chat("Chat to revert");
    await op(h.ai, "modules.update", { moduleId: m1, html: "<p>by H</p>" });
    const hSnap = await withSql(
      (tx) =>
        tx`SELECT id::text AS id FROM site_snapshots
           WHERE caelo_chat_owner(chat_task_id) = ${h.id}::uuid
           ORDER BY created_at DESC LIMIT 1` as Promise<{ id: string }[]>,
    );
    await op(g.ai, "modules.update", { moduleId: m2, html: "<p>by G</p>" });
    const r = await revertChatChangesTool.handler(g.ai, { chatSessionId: g.id }, toolCtx(g));
    expect(r.ok, r.content).toBe(true);
    expect(r.content).toContain(`pre-chat snapshot ${hSnap[0]?.id}`);
  });

  it("a status flip by one chat leaves another chat's pending page snapshot as it was", async () => {
    const pageId = await seedPage(`${PFX}status`, [await seedModule("status-hero")]);
    const i = await chat("Retitles");
    const j = await chat("Unpublishes");
    await op(i.ai, "pages.update", { pageId, title: "Retitled by I" });
    await writeWithReread(j.ai, "pages.set_status", { pageId, status: "draft" });
    const snaps = await withSql(
      (tx) =>
        tx`SELECT caelo_chat_owner(ss.chat_task_id)::text AS owner, ps.state->>'status' AS status
           FROM page_snapshots ps JOIN site_snapshots ss ON ss.id = ps.site_snapshot_id
           WHERE ps.page_id = ${pageId}::uuid AND ss.chat_branch_id = ${i.branch}::uuid
           ORDER BY ss.created_at` as Promise<{ owner: string; status: string }[]>,
    );
    expect(snaps).toEqual([
      { owner: i.id, status: "published" },
      { owner: j.id, status: "draft" },
    ]);
  });

  it("refuses to archive a draft chat with unstaged changes until they are undone", async () => {
    const m = await seedModule("archive");
    const k = await chat("Leaves work behind");
    await op(k.ai, "modules.update", { moduleId: m, html: "<p>unstaged</p>" });
    const refused = await execute(registry, adapter, OWNER, "chat.archive_session", {
      chatSessionId: k.id,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.error.kind === "HandlerError") {
      expect(refused.error.message).toContain("1 unstaged change");
    }
    await op(OWNER, "chat.undo_changes", { chatSessionId: k.id });
    await op(OWNER, "chat.archive_session", { chatSessionId: k.id });
    const archived = await withSql(
      (tx) =>
        tx`SELECT archived_at IS NOT NULL AS a FROM chat_sessions WHERE id = ${k.id}::uuid` as Promise<
          { a: boolean }[]
        >,
    );
    expect(archived[0]?.a).toBe(true);
  });
});

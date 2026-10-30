// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — the entity change journal against real Postgres
 * (docs/dev/state-and-changes.md, migration 0430).
 *
 * Every committed change to a journaled table leaves journal rows, and a
 * rolled-back one leaves none, on every path that writes: an op, a Stage
 * (merge to main), an undo, a lock takeover, a discard, the layout
 * modules' child snapshots inserted outside the snapshot emitter, media,
 * settings, and a direct SQL update with no actor at all (a migration).
 * Two transactions writing different rows never wait on each other
 * through the journal; a cursor never skips a transaction that committed
 * late; a deactivated plugin's cursor is dropped and holds nothing back;
 * and a write on one admin instance reaches the live stream of another.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  checkJournalMark,
  collectJournalGarbage,
  commitChanges,
  DatabaseAdapter,
  execute,
  OperationRegistry,
  pollChanges,
  registerConsumer,
} from "@caelo-cms/query-api";
import type { ExecutionContext, LiveTopic } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { type LiveFanOut, startLiveFanOut, subscribeLiveTopics } from "../live-events.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const PFX = "t1267-";
const ACTOR = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: ACTOR, actorKind: "system", requestId: "t1267" };

let adapter: DatabaseAdapter;
let otherAdapter: DatabaseAdapter;
let registry: OperationRegistry;

interface JournalRow {
  table_name: string;
  row_id: string;
  kind: string;
  op: string;
  changed_columns: string[] | null;
  chat_branch_id: string | null;
  owner_chat_session_id: string | null;
  site_snapshot_id: string | null;
  prev_snapshot_id: string | null;
  op_name: string | null;
}

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

/** The journal rows of one entity, oldest transaction first. */
async function journalOf(rowId: string): Promise<JournalRow[]> {
  return asSystem(
    (tx) =>
      tx`
      SELECT table_name, row_id, kind, op, changed_columns, chat_branch_id::text AS chat_branch_id,
             owner_chat_session_id::text AS owner_chat_session_id,
             site_snapshot_id::text AS site_snapshot_id, prev_snapshot_id::text AS prev_snapshot_id,
             op_name
        FROM entity_changes WHERE row_id = ${rowId}
       ORDER BY xid, table_name` as Promise<JournalRow[]>,
  );
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function createModule(slug: string, ctx: ExecutionContext = SYS): Promise<string> {
  const v = await op<{ moduleId: string }>(ctx, "modules.create", {
    slug: `${PFX}${slug}`,
    displayName: slug,
    html: `<p>${slug}</p>`,
  });
  return v.moduleId;
}

async function chat(
  title: string,
  isolation?: "experiment",
): Promise<{ id: string; branch: string; ctx: ExecutionContext }> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    title: `${PFX}${title}`,
    ...(isolation ? { isolation } : {}),
  });
  return {
    id: v.chatSessionId,
    branch: v.chatBranchId,
    ctx: {
      actorId: ACTOR,
      actorKind: "ai",
      requestId: `t1267-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  otherAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_URL,
  });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
  await otherAdapter.close();
});

describe("#1267 — every committed change, on every path, is journaled", () => {
  it("an op write: the live row, its snapshot and the header, attributed to the op", async () => {
    const moduleId = await createModule("op-write");
    const rows = await journalOf(moduleId);
    expect(rows.map((r) => [r.table_name, r.kind, r.op])).toEqual([
      ["module_snapshots", "module", "insert"],
      ["modules", "module", "insert"],
    ]);
    for (const r of rows) expect(r.op_name).toBe("modules.create");
    const snap = rows.find((r) => r.table_name === "module_snapshots");
    expect(snap?.site_snapshot_id).not.toBeNull();
    const header = await journalOf(snap?.site_snapshot_id ?? "");
    expect(header.map((r) => [r.table_name, r.kind, r.op])).toEqual([
      ["site_snapshots", "snapshot", "insert"],
    ]);

    await op(SYS, "modules.update", { moduleId, html: "<p>changed</p>" });
    const after = await journalOf(moduleId);
    const live = after.filter((r) => r.table_name === "modules").at(-1);
    expect(live?.op).toBe("update");
    expect(live?.changed_columns).toContain("html");
    // The new snapshot names the one it replaced, so a consumer can diff.
    const snaps = after.filter((r) => r.table_name === "module_snapshots");
    expect(snaps.at(-1)?.prev_snapshot_id).toBe(snaps[0]?.site_snapshot_id ?? "missing");
  });

  it("a rolled-back write leaves no row; an update that changed nothing leaves none", async () => {
    const id = crypto.randomUUID();
    await adapter
      .withAdminTransaction(SYS, async (tx) => {
        await tx.execute(sql`
          INSERT INTO redirects (id, from_path, to_path, created_by)
          VALUES (${id}::uuid, ${`/${PFX}rollback`}, '/x', ${ACTOR}::uuid)`);
        throw new Error("roll back");
      })
      .catch(() => undefined);
    expect(await journalOf(id)).toEqual([]);

    const moduleId = await createModule("noop");
    const before = (await journalOf(moduleId)).length;
    await asSystem((tx) => tx`UPDATE modules SET html = html WHERE id = ${moduleId}::uuid`);
    await asSystem((tx) => tx`UPDATE modules SET updated_at = now() WHERE id = ${moduleId}::uuid`);
    expect((await journalOf(moduleId)).length).toBe(before);
  });

  it("a chat's write is on its branch and names its owner chat", async () => {
    const moduleId = await createModule("branch-write");
    const a = await chat("branch-write");
    await op(a.ctx, "modules.update", { moduleId, html: "<p>draft</p>" });
    const snap = (await journalOf(moduleId))
      .filter((r) => r.table_name === "module_snapshots")
      .at(-1);
    expect(snap?.chat_branch_id).toBe(a.branch);
    expect(snap?.owner_chat_session_id).toBe(a.id);
    expect(snap?.op_name).toBe("modules.update");
  });

  it("Stage (merge to main), undo, lock takeover and discard are journaled", async () => {
    // Stage: an isolated chat's change lands on the live row.
    const staged = await createModule("staged");
    const s = await chat("stage", "experiment");
    await op(s.ctx, "modules.update", { moduleId: staged, html: "<p>staged</p>" });
    await op(SYS, "chat.merge_to_main", { chatSessionId: s.id });
    const live = (await journalOf(staged)).filter((r) => r.table_name === "modules").at(-1);
    expect(live?.op).toBe("update");
    expect(live?.chat_branch_id).toBeNull();
    expect(live?.op_name).toBe("chat.merge_to_main");

    // Undo: the chat's headers are marked undone.
    const undone = await createModule("undone");
    const u = await chat("undo");
    await op(u.ctx, "modules.update", { moduleId: undone, html: "<p>to undo</p>" });
    const undoSnap = (await journalOf(undone))
      .filter((r) => r.table_name === "module_snapshots")
      .at(-1);
    await op(SYS, "chat.undo_changes", { chatSessionId: u.id, confirmOverlap: true });
    const undoHeader = (await journalOf(undoSnap?.site_snapshot_id ?? "")).at(-1);
    expect(undoHeader?.op).toBe("update");
    expect(undoHeader?.changed_columns).toContain("undone_at");
    expect(undoHeader?.op_name).toBe("chat.undo_changes");

    // Takeover: B adopts A's unstaged change — A's snapshot is re-pointed
    // to a header on B's branch (an UPDATE outside the emitter).
    const taken = await createModule("taken");
    const ta = await chat("take-a", "experiment");
    const tb = await chat("take-b", "experiment");
    await op(ta.ctx, "modules.update", { moduleId: taken, html: "<p>from A</p>" });
    await op(tb.ctx, "modules.update", { moduleId: taken, displayName: "B" });
    const moved = (await journalOf(taken)).find(
      (r) => r.table_name === "module_snapshots" && r.op === "update",
    );
    // Merged with B's own snapshot of the same transaction, it stays an
    // update: the branch it left can tell its state changed.
    expect(moved?.chat_branch_id).toBe(tb.branch);
    expect(moved?.op_name).toBe("modules.update");

    // Discard: the chat's branch-created module is dropped.
    const d = await chat("discard", "experiment");
    const created = await createModule("discarded", d.ctx);
    await op(SYS, "chat.discard_branch", { chatSessionId: d.id });
    const dropped = (await journalOf(created)).filter((r) => r.table_name === "modules").at(-1);
    expect(dropped?.op).toBe("update");
    expect(dropped?.changed_columns).toContain("deleted_at");
    expect(dropped?.chat_branch_id).toBe(d.branch);
  });

  it("child snapshots outside the emitter, media, settings and a direct SQL update", async () => {
    const { layoutId } = await op<{ layoutId: string }>(SYS, "layouts.create", {
      slug: `${PFX}layout-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Journal layout",
      html: `<!doctype html><html><head><title>L</title></head><body><caelo-slot name="header">_</caelo-slot><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
      blocks: [
        { name: "header", displayName: "Header", position: 0 },
        { name: "content", displayName: "Content", position: 1 },
      ],
    });
    const headerModule = await createModule("layout-header");
    await op(SYS, "layout_modules.set", {
      layoutId,
      blockName: "header",
      moduleIds: [headerModule],
    });
    const layoutRows = await journalOf(layoutId);
    expect(layoutRows.some((r) => r.table_name === "layout_module_snapshots")).toBe(true);
    expect(
      layoutRows.some((r) => r.table_name === "layout_modules" && r.kind === "layout_module"),
    ).toBe(true);

    const assetId = crypto.randomUUID();
    await asSystem(
      (tx) => tx`
        INSERT INTO media_assets (id, sha256, original_name, mime, size_bytes, storage_key, created_by, slug, alt)
        VALUES (${assetId}::uuid, ${"a".repeat(64)}, 'a.png', 'image/png', 1, ${`k-${assetId}`},
                ${ACTOR}::uuid, ${`${PFX}asset-${assetId.slice(0, 8)}`}, '')`,
    );
    await op(SYS, "media.update_alt", { assetId, alt: "A journal" });
    const media = (await journalOf(assetId)).at(-1);
    expect([media?.kind, media?.op, media?.changed_columns]).toEqual(["media", "update", ["alt"]]);
    expect(media?.op_name).toBe("media.update_alt");

    const defaults = await asSystem(
      (tx) =>
        tx`SELECT default_layout_id::text AS l, default_template_id::text AS t FROM site_defaults WHERE id = 1` as Promise<
          { l: string; t: string }[]
        >,
    );
    await op(SYS, "site_defaults.set", {
      defaultLayoutId: layoutId,
      defaultTemplateId: defaults[0]?.t ?? "",
    });
    const settings = (await journalOf("1")).filter((r) => r.table_name === "site_defaults").at(-1);
    expect(settings?.changed_columns).toContain("default_layout_id");
    await op(SYS, "site_defaults.set", {
      defaultLayoutId: defaults[0]?.l ?? "",
      defaultTemplateId: defaults[0]?.t ?? "",
    });

    // A migration: plain SQL as the migrations run it (system, no op).
    const raw = new SQL(ADMIN_URL as string);
    try {
      await raw.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`UPDATE modules SET html = '<p>by migration</p>' WHERE id = ${headerModule}::uuid`;
      });
    } finally {
      await raw.end();
    }
    const direct = (await journalOf(headerModule)).filter((r) => r.table_name === "modules").at(-1);
    expect(direct?.changed_columns).toContain("html");
    expect(direct?.op_name).toBeNull();
  });
});

describe("#1267 — the journal never serialises writers and its cursor never skips", () => {
  it("a cache check under a human's identity sees another transaction's committed change", async () => {
    const HUMAN: ExecutionContext = {
      actorId: ACTOR,
      actorKind: "human",
      requestId: "t1267-human",
    };
    const filter = { kinds: ["module"] };
    const first = await adapter.withAdminTransaction(HUMAN, (tx) =>
      checkJournalMark(tx, null, filter),
    );
    expect(first.fresh).toBe(false);
    const unchanged = await adapter.withAdminTransaction(HUMAN, (tx) =>
      checkJournalMark(tx, first.mark, filter),
    );
    expect(unchanged.fresh).toBe(true);
    await createModule("seen-by-human");
    const after = await adapter.withAdminTransaction(HUMAN, (tx) =>
      checkJournalMark(tx, first.mark, filter),
    );
    expect(after.fresh).toBe(false);
  });

  it("two transactions writing different rows never wait on each other", async () => {
    const a = await createModule("conc-a");
    const b = await createModule("conc-b");
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let wrote!: () => void;
    const hasWritten = new Promise<void>((r) => {
      wrote = r;
    });
    const holder = adapter.withAdminTransaction(SYS, async (tx) => {
      await tx.execute(sql`UPDATE modules SET html = '<p>A holds</p>' WHERE id = ${a}::uuid`);
      wrote();
      await released;
    });
    await hasWritten;
    const second = otherAdapter.withAdminTransaction(SYS, async (tx) => {
      await tx.execute(sql`UPDATE modules SET html = '<p>B</p>' WHERE id = ${b}::uuid`);
      return "done" as const;
    });
    const outcome = await Promise.race([
      second,
      new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 3000)),
    ]);
    release();
    await holder;
    expect(outcome).toBe("done");
  });

  it("a cursor delivers a transaction that committed after a later one was read (late commit)", async () => {
    const name = `test:${crypto.randomUUID()}`;
    const filter = { kinds: ["redirect"] };
    await adapter.withAdminTransaction(SYS, (tx) => registerConsumer(tx, name));
    const early = crypto.randomUUID();
    const late = crypto.randomUUID();
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let wrote!: () => void;
    const hasWritten = new Promise<void>((r) => {
      wrote = r;
    });
    // The EARLY transaction starts first (lower xid) and commits last.
    const slow = adapter.withAdminTransaction(SYS, async (tx) => {
      await tx.execute(sql`
        INSERT INTO redirects (id, from_path, to_path, created_by)
        VALUES (${early}::uuid, ${`/${PFX}early`}, '/x', ${ACTOR}::uuid)`);
      wrote();
      await released;
    });
    await hasWritten;
    await otherAdapter.withAdminTransaction(SYS, (tx) =>
      tx.execute(sql`
        INSERT INTO redirects (id, from_path, to_path, created_by)
        VALUES (${late}::uuid, ${`/${PFX}late`}, '/x', ${ACTOR}::uuid)`),
    );
    const first = await otherAdapter.withAdminTransaction(SYS, (tx) =>
      pollChanges(tx, name, { filter, limit: 100 }),
    );
    expect(first.changes.map((c) => c.rowId)).toEqual([late]);
    await otherAdapter.withAdminTransaction(SYS, (tx) => commitChanges(tx, name, first.token));
    release();
    await slow;
    const second = await otherAdapter.withAdminTransaction(SYS, (tx) =>
      pollChanges(tx, name, { filter, limit: 100 }),
    );
    // An `id > cursor` read would have skipped it: its id is below `late`'s.
    expect(second.changes.map((c) => c.rowId)).toEqual([early]);
  });

  it("drops a deactivated plugin's cursor, and GC never waits for any cursor", async () => {
    const pluginId = crypto.randomUUID();
    await asSystem(
      (tx) => tx`
        INSERT INTO plugins (id, slug, version, tier, status, manifest_json, manifest_signature, submitted_by)
        VALUES (${pluginId}::uuid, ${`${PFX}p-${pluginId.slice(0, 6)}`}, '0.1.0', 1, 'active',
                '{}'::jsonb, 'test-signature', ${ACTOR}::uuid)`,
    );
    const name = `plugin:${pluginId}`;
    await adapter.withAdminTransaction(SYS, (tx) => registerConsumer(tx, name, pluginId));
    await createModule("gc-after-cursor");
    // GC with no retention deletes the rows the cursor has not read yet.
    await adapter.withAdminTransaction(SYS, (tx) => collectJournalGarbage(tx, { retentionMs: 0 }));
    const behind = await adapter.withAdminTransaction(SYS, (tx) =>
      pollChanges(tx, name, { filter: { kinds: ["module"] }, limit: 10 }),
    );
    expect(behind.needsRebuild).toBe(true);
    // The Owner disables it (a human, whom the cursor table does not admit).
    await asSystem((tx) => tx`UPDATE plugins SET status = 'disabled' WHERE id = ${pluginId}::uuid`);
    const left = await asSystem(
      (tx) =>
        tx`SELECT count(*)::int AS n FROM change_consumers WHERE plugin_id = ${pluginId}::uuid` as Promise<
          { n: number }[]
        >,
    );
    expect(left[0]?.n).toBe(0);
    await asSystem((tx) => tx`DELETE FROM plugins WHERE id = ${pluginId}::uuid`);
  });
});

describe("#1267 — live topics cross admin instances", () => {
  it("a write on instance 1 reaches the live stream of instance 2, and so do its op topics", async () => {
    const fanOut: LiveFanOut = await startLiveFanOut({ adapter, instanceId: "instance-2" });
    const heard = new Set<LiveTopic>();
    const stop = subscribeLiveTopics((topics) => {
      for (const t of topics) heard.add(t);
    });
    try {
      const session = await op<{ chatSessionId: string }>(SYS, "chat.create_session", {
        title: `${PFX}cross-instance`,
      });
      // Settle what this process itself just did before the other writes.
      await fanOut.settled();
      heard.clear();
      // Instance 1: another process, its own pools and fan-out.
      const script = resolve(import.meta.dir, "fixtures/change-journal-instance.ts");
      const child = spawn("bun", [script, session.chatSessionId], {
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"],
      });
      const code = await new Promise<number | null>((r) => child.on("exit", r));
      expect(code).toBe(0);
      const deadline = Date.now() + 10_000;
      while ((!heard.has("draft") || !heard.has("agents")) && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      expect([...heard].sort()).toEqual(["agents", "draft"]);
    } finally {
      stop();
      await fanOut.stop();
    }
  });
});

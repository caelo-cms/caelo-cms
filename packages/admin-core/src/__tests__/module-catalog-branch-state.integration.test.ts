// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1746 — a chat's `update_modules_many` with a new `description`
 * answered "updated", html / css / fields changed, but `list_modules` (the
 * catalog "as this chat sees the site") kept the old description. Reported
 * on 0.12.16, tried three ways: description with html/css/fields,
 * description alone, description with an unchanged displayName and kind.
 *
 * Root cause: inside a chat a module write is branch state, recorded only
 * as a snapshot, and the module snapshot state carried no `description` /
 * `kind`. The branched write dropped both, the branch overlay kept the
 * live columns, and the Stage merge never wrote them: the new text was
 * lost, not only hidden.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { createDefaultToolRegistry, type ToolContext } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "t1746" };
const PFX = "t1746-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const tools = createDefaultToolRegistry();

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

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

interface Chat {
  readonly id: string;
  readonly ctx: ExecutionContext;
  readonly toolCtx: ToolContext;
}

async function chat(title: string): Promise<Chat> {
  const v = await op<{ chatSessionId: string; chatBranchId: string; branchKind: string }>(
    SYS,
    "chat.create_session",
    { title: `${PFX}${title}` },
  );
  expect(v.branchKind).toBe("draft");
  return {
    id: v.chatSessionId,
    ctx: {
      actorId: HUMAN,
      actorKind: "ai",
      requestId: `t1746-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
    toolCtx: {
      adapter,
      registry,
      chatSessionId: v.chatSessionId,
      chatBranchId: v.chatBranchId,
    },
  };
}

async function tool(c: Chat, name: string, input: unknown): Promise<string> {
  const r = await tools.dispatch(name, input, c.ctx, c.toolCtx);
  if (!r.ok) throw new Error(`${name}: ${r.content}`);
  return r.content;
}

/** The module as `ctx` reads it: description and kind. */
async function meta(ctx: ExecutionContext, moduleId: string) {
  const v = await op<{ module: { description: string; kind: string; html: string } }>(
    ctx,
    "modules.get",
    { moduleId },
  );
  return v.module;
}

async function listed(ctx: ExecutionContext, moduleId: string) {
  const v = await op<{ modules: { id: string; description: string; kind: string }[] }>(
    ctx,
    "modules.list",
    { moduleIds: [moduleId] },
  );
  return v.modules[0];
}

let moduleId = "";

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  moduleId = (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${PFX}schritte`,
      displayName: "Schritte",
      description: "Numbered steps of a process.",
      kind: "content",
      html: "<ol><li>{{step_one}}</li></ol>",
      fields: [{ name: "step_one", kind: "text", label: "Step one" }],
    })
  ).moduleId;
});

afterAll(async () => {
  await asSystem(async (tx) => {
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
  });
  await adapter.close();
});

describe("#1746 a chat's module description and kind", () => {
  it("are branch state: the chat reads them at once, main at Stage, revert restores them", async () => {
    const a = await chat("steps");
    const NEW = "Numbered steps of a process; three_columns lays them out side by side.";

    // 1) together with html, css and fields.
    await tool(a, "update_modules_many", {
      items: [
        {
          moduleId,
          description: NEW,
          html: '<ol class="{{three_columns}}"><li>{{step_one}}</li></ol>',
          css: "ol { margin: 0; }",
          fields: [
            { name: "step_one", kind: "text", label: "Step one" },
            { name: "three_columns", kind: "text", label: "Three columns" },
          ],
          bindThemeLiterals: false,
        },
      ],
    });
    expect((await meta(a.ctx, moduleId)).description).toBe(NEW);
    expect((await listed(a.ctx, moduleId))?.description).toBe(NEW);
    expect(await tool(a, "list_modules", {})).toContain(NEW);
    // Draft state: main keeps the old text until a Stage.
    expect((await meta(SYS, moduleId)).description).toBe("Numbered steps of a process.");

    // 2) description alone, 3) description with an unchanged displayName and a new kind.
    await tool(a, "update_modules_many", { items: [{ moduleId, description: `${NEW} v2` }] });
    expect((await listed(a.ctx, moduleId))?.description).toBe(`${NEW} v2`);
    await tool(a, "update_modules_many", {
      items: [{ moduleId, description: `${NEW} v3`, displayName: "Schritte", kind: "utility" }],
    });
    const seen = await listed(a.ctx, moduleId);
    expect(seen?.description).toBe(`${NEW} v3`);
    expect(seen?.kind).toBe("utility");
    // The html edit of step 1 survived the metadata-only writes.
    expect((await meta(a.ctx, moduleId)).html).toContain("three_columns");

    // Another chat on the draft sees them too (shared draft).
    const b = await chat("reader");
    expect((await listed(b.ctx, moduleId))?.description).toBe(`${NEW} v3`);

    // The Stage merges them into main.
    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [a.id] });
    const main = await meta(SYS, moduleId);
    expect(main.description).toBe(`${NEW} v3`);
    expect(main.kind).toBe("utility");

    // A revert to the module's first snapshot restores its description and kind.
    const first = await asSystem(
      (tx) =>
        tx`SELECT site_snapshot_id::text AS id FROM module_snapshots
            WHERE module_id = ${moduleId}::uuid ORDER BY created_at ASC LIMIT 1` as unknown as Promise<
          { id: string }[]
        >,
    );
    await op(SYS, "snapshots.revert_module", { snapshotId: first[0]?.id, moduleId });
    const reverted = await meta(SYS, moduleId);
    expect(reverted.description).toBe("Numbered steps of a process.");
    expect(reverted.kind).toBe("content");
  });

  it("keeps the live values when a snapshot predates them", async () => {
    // A pending snapshot written before #1746 has no description / kind:
    // the overlay and the merge keep what main has.
    const c = await chat("older");
    await op(c.ctx, "modules.update", { moduleId, html: "<ol><li>{{step_one}}</li></ol>" });
    await asSystem(async (tx) => {
      await tx`UPDATE module_snapshots SET state = state - 'description' - 'kind'
                WHERE module_id = ${moduleId}::uuid
                  AND site_snapshot_id IN (SELECT id FROM site_snapshots WHERE chat_task_id = ${c.id}::uuid)`;
    });
    expect((await listed(c.ctx, moduleId))?.description).toBe("Numbered steps of a process.");
    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [c.id] });
    const main = await meta(SYS, moduleId);
    expect(main.description).toBe("Numbered steps of a process.");
    expect(main.kind).toBe("content");
    expect(main.html).toBe("<ol><li>{{step_one}}</li></ol>");
  });
});

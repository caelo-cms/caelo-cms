// SPDX-License-Identifier: MPL-2.0

/**
 * templates.create — optional `blocks` metadata (catalogue-consistency with
 * create_layout / propose_update_template, both of which take `blocks`).
 *
 *   - omitted → auto-derive one block per <caelo-slot> (displayName = name,
 *     position = order of appearance) — the unchanged default.
 *   - provided → enrich the derived block's displayName + position; every
 *     entry's name must match a slot, else the create fails loudly (no slot =
 *     renders nothing → reject, CLAUDE.md §2).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "tpl-create-blocks",
};
const SLUGS = ["tcb-derive", "tcb-explicit", "tcb-orphan"] as const;

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      for (const slug of SLUGS) {
        await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${slug})`;
        await tx`DELETE FROM templates WHERE slug = ${slug}`;
      }
    });
  } finally {
    await sql.end();
  }
}

async function blocksOf(templateId: string): Promise<{ name: string; display_name: string; position: number }[]> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx`SELECT name, display_name, position FROM template_blocks
        WHERE template_id = ${templateId}::uuid ORDER BY position`;
    })) as unknown as { name: string; display_name: string; position: number }[];
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});
afterAll(async () => {
  await wipe();
  await adapter.close();
});

const HTML = `<body><caelo-slot name="header">h</caelo-slot><caelo-slot name="content">c</caelo-slot></body>`;

describe("templates.create blocks metadata", () => {
  it("omitted → derives one block per slot (displayName = name, position = order)", async () => {
    const r = await execute(registry, adapter, SYS, "templates.create", {
      slug: "tcb-derive",
      displayName: "Derive",
      html: HTML,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const blocks = await blocksOf((r.value as { templateId: string }).templateId);
    expect(blocks).toEqual([
      { name: "header", display_name: "header", position: 0 },
      { name: "content", display_name: "content", position: 1 },
    ]);
  });

  it("provided → enriches displayName + position for the matching slots", async () => {
    const r = await execute(registry, adapter, SYS, "templates.create", {
      slug: "tcb-explicit",
      displayName: "Explicit",
      html: HTML,
      blocks: [
        { name: "content", displayName: "Main Content", position: 0 },
        { name: "header", displayName: "Top Bar", position: 1 },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const blocks = await blocksOf((r.value as { templateId: string }).templateId);
    const byName = new Map(blocks.map((b) => [b.name, b]));
    expect(byName.get("content")).toEqual({ name: "content", display_name: "Main Content", position: 0 });
    expect(byName.get("header")).toEqual({ name: "header", display_name: "Top Bar", position: 1 });
  });

  it("a block with no matching <caelo-slot> fails loudly (no silent drop)", async () => {
    const r = await execute(registry, adapter, SYS, "templates.create", {
      slug: "tcb-orphan",
      displayName: "Orphan",
      html: HTML,
      blocks: [{ name: "sidebar", displayName: "Sidebar", position: 0 }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as { message?: string }).message).toContain("sidebar");
  });
});

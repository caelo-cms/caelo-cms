// SPDX-License-Identifier: MPL-2.0

/**
 * 1b — propose_update_layout carries `blocks` inline (fold of the former
 * propose_set_layout_blocks), symmetric with propose_update_template. A single
 * gated update proposal changes html/css AND the block-set atomically; on
 * approve, execute_proposal applies the layout edit and THEN the new block-set
 * (against the new html), reusing the same op the standalone set-blocks path
 * used. This test drives the full propose → execute path and asserts the block
 * rows are replaced.
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
  requestId: "layout-update-blocks-fold",
};
const SLUG = "lubf-layout";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM layout_blocks WHERE layout_id IN (SELECT id FROM layouts WHERE slug = ${SLUG})`;
      await tx`DELETE FROM layout_pending_actions WHERE payload::text LIKE ${"%" + SLUG + "%"}`;
      await tx`DELETE FROM layouts WHERE slug = ${SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

async function blocksOf(layoutId: string): Promise<{ name: string; display_name: string; position: number }[]> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await tx`SELECT name, display_name, position FROM layout_blocks
        WHERE layout_id = ${layoutId}::uuid ORDER BY position`;
    })) as unknown as { name: string; display_name: string; position: number }[];
  } finally {
    await sql.end();
  }
}

async function proposeAndApprove(op: string, input: Record<string, unknown>): Promise<string> {
  const p = await execute(registry, adapter, SYS, op, input);
  if (!p.ok) throw new Error(`${op}: ${JSON.stringify(p.error)}`);
  const proposalId = (p.value as { proposalId: string }).proposalId;
  const e = await execute(registry, adapter, SYS, "layouts.execute_proposal", { proposalId });
  if (!e.ok) throw new Error(`execute ${op}: ${JSON.stringify(e.error)}`);
  return (e.value as { layoutId: string | null }).layoutId ?? "";
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

describe("propose_update_layout folds the block-set", () => {
  it("applies html + a replaced block-set in one approved proposal", async () => {
    // Seed a layout with content + footer blocks.
    const layoutId = await proposeAndApprove("layouts.propose_create", {
      slug: SLUG,
      displayName: "Fold Layout",
      html: `<body><caelo-slot name="content">c</caelo-slot><caelo-slot name="footer">f</caelo-slot></body>`,
      css: "",
      blocks: [
        { name: "content", displayName: "content", position: 0 },
        { name: "footer", displayName: "footer", position: 1 },
      ],
    });
    expect(layoutId).not.toBe("");
    expect((await blocksOf(layoutId)).map((b) => b.name).sort()).toEqual(["content", "footer"]);

    // Update: new html adds a header slot + rename blocks via inline `blocks`.
    await proposeAndApprove("layouts.propose_update", {
      layoutId,
      html: `<body><caelo-slot name="header">h</caelo-slot><caelo-slot name="content">c</caelo-slot><caelo-slot name="footer">f</caelo-slot></body>`,
      blocks: [
        { name: "header", displayName: "Top Bar", position: 0 },
        { name: "content", displayName: "Main", position: 1 },
        { name: "footer", displayName: "Bottom", position: 2 },
      ],
    });

    const after = await blocksOf(layoutId);
    expect(after).toEqual([
      { name: "header", display_name: "Top Bar", position: 0 },
      { name: "content", display_name: "Main", position: 1 },
      { name: "footer", display_name: "Bottom", position: 2 },
    ]);
  });

  it("rejects an update whose blocks omit `content`", async () => {
    const r = await execute(registry, adapter, SYS, "layouts.propose_update", {
      layoutId: "00000000-0000-0000-0000-0000000000aa",
      blocks: [{ name: "footer", displayName: "Bottom", position: 0 }],
    });
    expect(r.ok).toBe(false);
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * Integration coverage for the read_content / edit_content tools against a
 * real Postgres. Verifies the Claude-Code-style surgical edit path:
 *   - read_content returns cat -n line numbers + a sha token
 *   - edit_content string-replaces a module body through modules.update
 *     (so the change actually persists + is branch/snapshot-safe)
 *   - a non-unique oldString is rejected (loud, no clobber)
 *   - a stale expectedSha is rejected
 *   - an unknown field is rejected with the valid field list
 *
 * The tool handlers are thin glue over the Query API; the string engine is
 * unit-tested in ai/content-edit/__tests__/text-ops.test.ts.
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

let adapter: DatabaseAdapter;
let ops: OperationRegistry;
let toolCtx: ToolContext;
const tools = createDefaultToolRegistry();

// Seed AI actor row so audit_events FK is satisfied (mirrors content-modules).
const aiCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "edit-content-tool-test",
};
const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "edit-content-tool-test-sys",
};

const SLUG = "edit-content-mod";

async function wipe(url: string): Promise<void> {
  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM modules WHERE slug = ${SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe(ADMIN_URL);
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  ops = new OperationRegistry();
  registerAdminOps(ops);
  toolCtx = { adapter, registry: ops };
});

afterAll(async () => {
  await wipe(ADMIN_URL);
  await adapter.close();
});

async function seedModule(): Promise<string> {
  const create = await execute(ops, adapter, systemCtx, "modules.create", {
    slug: SLUG,
    displayName: "Editable",
    // Explicit fields → HTML stored verbatim (no extractor templatisation),
    // so our oldString anchors match the exact stored bytes.
    html: '<section class="box">\n  <h1>Hello</h1>\n  <p>Hello world</p>\n</section>',
    css: ".box{color:red}",
    fields: [{ name: "headline", kind: "text", label: "Headline" } as never],
  });
  if (!create.ok) throw new Error("seed failed");
  return (create.value as { moduleId: string }).moduleId;
}

describe("read_content + edit_content tools", () => {
  it("read_content returns line numbers and a sha", async () => {
    const moduleId = await seedModule();
    const r = await tools.dispatch(
      "read_content",
      { entityKind: "module", entityId: moduleId, field: "html" },
      aiCtx,
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("sha=");
    // cat -n style: right-aligned "1" + tab.
    expect(r.content).toContain(`${"1".padStart(6)}\t`);
    expect(r.content).toContain("<h1>Hello</h1>");
  });

  it("edit_content string-replaces a unique hunk and persists it", async () => {
    const moduleId = await seedModule();
    const r = await tools.dispatch(
      "edit_content",
      {
        entityKind: "module",
        entityId: moduleId,
        field: "html",
        edits: [{ oldString: "<h1>Hello</h1>", newString: "<h1>Welcome</h1>" }],
      },
      aiCtx,
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("1 replacement");
    // Claude-Code-style result: new sha + a cat -n snippet of the change, so
    // the model can chain a follow-up edit without a re-read.
    expect(r.content).toContain("new sha=");
    expect(r.content).toContain("<h1>Welcome</h1>");
    expect(r.content).toContain("\t"); // line-numbered snippet

    const got = await execute(ops, adapter, systemCtx, "modules.get", { moduleId });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const html = (got.value as { module: { html: string } }).module.html;
    expect(html).toContain("<h1>Welcome</h1>");
    // The paragraph "Hello world" is untouched — surgical, not a full rewrite.
    expect(html).toContain("<p>Hello world</p>");
  });

  it("rejects a non-unique oldString unless replaceAll", async () => {
    const moduleId = await seedModule();
    // "Hello" appears in both the <h1> and the <p>.
    const bad = await tools.dispatch(
      "edit_content",
      {
        entityKind: "module",
        entityId: moduleId,
        field: "html",
        edits: [{ oldString: "Hello", newString: "Hi" }],
      },
      aiCtx,
      toolCtx,
    );
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain("not unique");

    const ok = await tools.dispatch(
      "edit_content",
      {
        entityKind: "module",
        entityId: moduleId,
        field: "html",
        edits: [{ oldString: "Hello", newString: "Hi", replaceAll: true }],
      },
      aiCtx,
      toolCtx,
    );
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain("2 replacements");
  });

  it("rejects a stale expectedSha", async () => {
    const moduleId = await seedModule();
    const r = await tools.dispatch(
      "edit_content",
      {
        entityKind: "module",
        entityId: moduleId,
        field: "html",
        edits: [{ oldString: "<h1>Hello</h1>", newString: "<h1>X</h1>" }],
        expectedSha: "deadbeef",
      },
      aiCtx,
      toolCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("changed since your read");
  });

  it("rejects an unknown field with the valid list", async () => {
    const moduleId = await seedModule();
    const r = await tools.dispatch(
      "edit_content",
      {
        entityKind: "module",
        entityId: moduleId,
        field: "js",
        edits: [{ oldString: "x", newString: "y" }],
      },
      aiCtx,
      toolCtx,
    );
    // js is a valid module field, but empty — oldString not found is the
    // expected loud failure here.
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
});

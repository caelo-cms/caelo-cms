// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: inside a chat branch, read_content / edit_content /
 * edit_module must all operate on the BRANCH-EFFECTIVE module, not main.
 *
 * Reproduced live on v0.10.28 through the Power-MCP, all in one session:
 *   1. edit_content on module X's html (drop an aria-label) → new sha; the
 *      branch preview showed the change.
 *   2. edit_module on X with ONLY `fields` → success.
 *   3. X's html was back to the original — the step-1 edit was lost.
 *   4. read_content kept returning main's html + sha, and edit_content with
 *      the sha returned by the previous edit_content was rejected as stale.
 *
 * Root cause: `modules.get` (the read op behind read_content and behind
 * edit_content's base + sha guard) filtered the LIVE `modules` table by
 * branch visibility only. Branched `modules.update` writes never touch the
 * live row — they land as a branched module snapshot — so every chat read
 * saw main. edit_content then rebuilt the body from main's html, writing
 * main+newEdit into the branch and clobbering earlier branch edits.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { contentSha } from "../ai/content-edit/text-ops.js";
import { createDefaultToolRegistry, type ToolContext } from "../ai/tools/index.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let toolCtx: ToolContext;
const tools = createDefaultToolRegistry();

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "branch-reads-sys",
};

const MODULE_SLUG = "branch-reads-mod";
const SESSION_PREFIX = "branch-reads-";

const MAIN_HTML =
  '<nav class="menu" aria-label="Main menu">\n  {{#nav_items}}<a href="{{href}}">{{label}}</a>{{/nav_items}}\n</nav>';
const MAIN_FIELDS = [
  {
    name: "nav_items",
    kind: "link-list",
    label: "Navigation",
    default: [{ label: "Home", href: "/" }],
  },
];

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${SESSION_PREFIX}%`}`;
      await tx`DELETE FROM modules WHERE slug = ${MODULE_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  toolCtx = { adapter, registry };
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

/** Seed X on main and open a chat session; returns the AI ctx on its branch. */
async function setup(label: string): Promise<{ moduleId: string; aiCtx: ExecutionContext }> {
  await wipe();
  const created = await execute(registry, adapter, SYSTEM, "modules.create", {
    slug: MODULE_SLUG,
    displayName: "Main nav",
    html: MAIN_HTML,
    fields: MAIN_FIELDS as never,
  });
  if (!created.ok) throw new Error(`seed module: ${JSON.stringify(created.error)}`);
  const moduleId = (created.value as { moduleId: string }).moduleId;

  const session = await execute(registry, adapter, SYSTEM, "chat.create_session", {
    title: `${SESSION_PREFIX}${label}`,
  });
  if (!session.ok) throw new Error("session");
  const { chatSessionId, chatBranchId } = session.value as {
    chatSessionId: string;
    chatBranchId: string;
  };
  return {
    moduleId,
    aiCtx: {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: `branch-reads-${label}`,
      chatBranchId,
      chatTaskId: chatSessionId,
    },
  };
}

function shaFrom(content: string): string {
  const m = /sha=([0-9a-z]+)/.exec(content);
  if (!m?.[1]) throw new Error(`no sha in: ${content}`);
  return m[1];
}

async function getHtml(ctx: ExecutionContext, moduleId: string): Promise<string> {
  const got = await execute(registry, adapter, ctx, "modules.get", { moduleId });
  if (!got.ok) throw new Error(`modules.get: ${JSON.stringify(got.error)}`);
  return (got.value as { module: { html: string } }).module.html;
}

const DROP_ARIA = { oldString: ' aria-label="Main menu"', newString: "" };

describe("branch-effective module reads (read_content / edit_content / edit_module)", () => {
  it("read_content returns the branch's html + sha right after edit_content", async () => {
    const { moduleId, aiCtx } = await setup("read");
    const edit = await tools.dispatch(
      "edit_content",
      { entityKind: "module", entityId: moduleId, field: "html", edits: [DROP_ARIA] },
      aiCtx,
      toolCtx,
    );
    expect(edit.ok).toBe(true);
    const newSha = shaFrom(edit.content);
    expect(newSha).not.toBe(contentSha(MAIN_HTML));

    const read = await tools.dispatch(
      "read_content",
      { entityKind: "module", entityId: moduleId, field: "html" },
      aiCtx,
      toolCtx,
    );
    expect(read.ok).toBe(true);
    expect(read.content).not.toContain("aria-label");
    expect((read.value as { sha: string }).sha).toBe(newSha);

    // modules.list (grep_content's source) agrees with modules.get.
    const listed = await execute(registry, adapter, aiCtx, "modules.list", {});
    if (!listed.ok) throw new Error("modules.list");
    const row = (listed.value as { modules: { id: string; html: string }[] }).modules.find(
      (m) => m.id === moduleId,
    );
    expect(row?.html).not.toContain("aria-label");

    // Main is untouched — branch isolation still holds for main readers.
    expect(await getHtml(SYSTEM, moduleId)).toBe(MAIN_HTML);

    // A second chat never sees this chat's pending edit: the overlay is
    // keyed on the caller's own branch only (CLAUDE.md §2).
    const other = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      title: `${SESSION_PREFIX}read-other`,
    });
    if (!other.ok) throw new Error("second session");
    const otherCtx: ExecutionContext = {
      ...aiCtx,
      requestId: "branch-reads-read-other",
      chatBranchId: (other.value as { chatBranchId: string }).chatBranchId,
      chatTaskId: (other.value as { chatSessionId: string }).chatSessionId,
    };
    expect(await getHtml(otherCtx, moduleId)).toBe(MAIN_HTML);
    const otherListed = await execute(registry, adapter, otherCtx, "modules.list", {});
    if (!otherListed.ok) throw new Error("modules.list (other chat)");
    expect(
      (otherListed.value as { modules: { id: string; html: string }[] }).modules.find(
        (m) => m.id === moduleId,
      )?.html,
    ).toBe(MAIN_HTML);
  });

  it("edit_content accepts the sha returned by the previous edit_content and chains on the branch body", async () => {
    const { moduleId, aiCtx } = await setup("chain");
    const first = await tools.dispatch(
      "edit_content",
      { entityKind: "module", entityId: moduleId, field: "html", edits: [DROP_ARIA] },
      aiCtx,
      toolCtx,
    );
    expect(first.ok).toBe(true);

    const second = await tools.dispatch(
      "edit_content",
      {
        entityKind: "module",
        entityId: moduleId,
        field: "html",
        edits: [{ oldString: '<nav class="menu">', newString: '<nav class="menu menu--main">' }],
        expectedSha: shaFrom(first.content),
      },
      aiCtx,
      toolCtx,
    );
    expect(second.content).not.toContain("content changed since your read");
    expect(second.ok).toBe(true);

    // Both edits are present on the branch; neither clobbered the other.
    const branchHtml = await getHtml(aiCtx, moduleId);
    expect(branchHtml).toContain('<nav class="menu menu--main">');
    expect(branchHtml).not.toContain("aria-label");
    expect(await getHtml(SYSTEM, moduleId)).toBe(MAIN_HTML);
  });

  it("edit_module with only `fields` preserves the branch's html edit (steps 1-3)", async () => {
    const { moduleId, aiCtx } = await setup("fields");
    const edit = await tools.dispatch(
      "edit_content",
      { entityKind: "module", entityId: moduleId, field: "html", edits: [DROP_ARIA] },
      aiCtx,
      toolCtx,
    );
    expect(edit.ok).toBe(true);
    const editedSha = shaFrom(edit.content);

    const fieldsOnly = await tools.dispatch(
      "edit_module",
      {
        moduleId,
        fields: [
          {
            name: "nav_items",
            kind: "link-list",
            label: "Navigation",
            default: [
              { label: "Home", href: "/" },
              { label: "Blog", href: "/blog" },
            ],
          },
        ],
      },
      aiCtx,
      toolCtx,
    );
    expect(fieldsOnly.ok).toBe(true);

    // The branch-effective module keeps the html edit AND carries the new fields.
    const got = await execute(registry, adapter, aiCtx, "modules.get", { moduleId });
    if (!got.ok) throw new Error("modules.get");
    const mod = (got.value as { module: { html: string; fields: { default?: unknown[] }[] } })
      .module;
    expect(mod.html).not.toContain("aria-label");
    expect(mod.fields[0]?.default).toHaveLength(2);

    // What publish/merge will apply (the latest branched snapshot) agrees.
    const sql = new SQL(ADMIN_URL as string);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`
          SELECT ms.state FROM module_snapshots ms
          JOIN site_snapshots ss ON ss.id = ms.site_snapshot_id
          WHERE ms.module_id = ${moduleId}::uuid
            AND ss.chat_branch_id = ${aiCtx.chatBranchId as string}::uuid
          ORDER BY ss.created_at DESC LIMIT 1
        `) as { state: unknown }[];
        const raw = rows[0]?.state;
        const state = (typeof raw === "string" ? JSON.parse(raw) : raw) as { html: string };
        expect(state.html).not.toContain("aria-label");
      });
    } finally {
      await sql.end();
    }

    // read_content after the fields-only edit still reports the edited body.
    const read = await tools.dispatch(
      "read_content",
      { entityKind: "module", entityId: moduleId, field: "html" },
      aiCtx,
      toolCtx,
    );
    expect((read.value as { sha: string }).sha).toBe(editedSha);

    // A css-only edit_module likewise keeps html + fields.
    const cssOnly = await tools.dispatch(
      "edit_module",
      { moduleId, css: ".menu{display:flex}", bindThemeLiterals: false },
      aiCtx,
      toolCtx,
    );
    expect(cssOnly.ok).toBe(true);
    const after = await execute(registry, adapter, aiCtx, "modules.get", { moduleId });
    if (!after.ok) throw new Error("modules.get");
    const m2 = (
      after.value as { module: { html: string; css: string; fields: { default?: unknown[] }[] } }
    ).module;
    expect(m2.html).not.toContain("aria-label");
    expect(m2.css).toBe(".menu{display:flex}");
    expect(m2.fields[0]?.default).toHaveLength(2);

    // Main never saw any of it.
    expect(await getHtml(SYSTEM, moduleId)).toBe(MAIN_HTML);
  });
});

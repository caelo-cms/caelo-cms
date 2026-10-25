// SPDX-License-Identifier: MPL-2.0

/**
 * #1091 / #1092 — the chat's automatic bug capture filed designed guard
 * refusals as bugs: delete_modules_many "still placed on … — remove it
 * first", delete_content_instance "cannot delete: … detach … then retry",
 * and the allowedModuleTypes check (#1090 / #1093). Those are the tools
 * working: the op said no and named the next step.
 *
 * Against the real ops and Postgres, both directions:
 *   - each of those guards marks its error `refusal: true`, the tool
 *     forwards it onto its result, and the capture skips it;
 *   - failures that are not guards (a reference to a module that does not
 *     exist, an id that is not there) carry no flag and stay captured.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { shouldAutoCaptureToolFailure } from "../ai/chat-runner/tool-dispatch.js";
import { buildPageTool } from "../ai/tools/build-page.js";
import { createContentInstanceTool } from "../ai/tools/create-content-instance.js";
import { deleteContentInstanceTool } from "../ai/tools/delete-content-instance.js";
import { deleteModulesManyTool } from "../ai/tools/delete-modules-many.js";
import { ToolRegistry, type ToolResult } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const aiCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "t1091-guard-refusals",
  actorRoles: ["ai"],
};

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1091-guard-refusals-seed",
};

const sfx = Date.now().toString(36);
const TPL_SLUG = `t1091-tpl-${sfx}`;
let templateId = "";
let registry: OperationRegistry;
let adapter: DatabaseAdapter;
let tools: ToolRegistry;

let buttonId = "";
let buttonCi = "";
let cardId = "";
let cardCi = "";
let parentId = "";

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, aiCtx, name, input);
  if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function seedModule(slug: string, type: string, fields: unknown[] = []): Promise<string> {
  return (
    await op<{ moduleId: string }>("modules.create", {
      slug,
      displayName: slug,
      type,
      html: "<div></div>",
      fields,
    })
  ).moduleId;
}

async function seedCi(moduleId: string, values: Record<string, unknown> = {}): Promise<string> {
  return (await op<{ contentInstanceId: string }>("content_instances.create", { moduleId, values }))
    .contentInstanceId;
}

function tool(name: string, args: unknown): Promise<ToolResult> {
  return tools.dispatch(name, args, aiCtx, { adapter, registry });
}

beforeAll(async () => {
  registry = new OperationRegistry();
  registerAdminOps(registry);
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  tools = new ToolRegistry();
  tools.register(createContentInstanceTool);
  tools.register(deleteContentInstanceTool);
  tools.register(deleteModulesManyTool);

  buttonId = await seedModule(`t1091-button-${sfx}`, "button");
  cardId = await seedModule(`t1091-card-${sfx}`, "card");
  parentId = await seedModule(`t1091-teaser-${sfx}`, "teaser", [
    { name: "cta", kind: "module", label: "CTA", allowedModuleTypes: ["button"] },
  ]);
  buttonCi = await seedCi(buttonId);
  cardCi = await seedCi(cardId);
  // The teaser shows the button: the button module and its instance are
  // now in use.
  await seedCi(parentId, { cta: { moduleId: buttonId, contentInstanceId: buttonCi } });

  const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "T1091",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, systemCtx, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
  await adapter.close();
});

describe("#1091 — guard refusals are marked and not auto-captured", () => {
  it("allowedModuleTypes mismatch (#1090 / #1093): refusal on the op and the tool", async () => {
    const values = { cta: { moduleId: cardId, contentInstanceId: cardCi } };
    const r = await execute(registry, adapter, aiCtx, "content_instances.create", {
      moduleId: parentId,
      values,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? undefined : (r.error as { refusal?: true }).refusal).toBe(true);

    const t = await tool("create_content_instance", { moduleId: parentId, values });
    expect(t.ok).toBe(false);
    expect(t.content).toContain("allowedModuleTypes");
    expect(t.refusal).toBe(true);
    expect(shouldAutoCaptureToolFailure("create_content_instance", t)).toBe(false);
  });

  it("build_page keeps the refusal of a nested write after it rolled the call back", async () => {
    // System actor: the AI-only brand-palette gate in front of build_page
    // is not what this test is about.
    const t = await buildPageTool.handler(
      systemCtx,
      {
        page: { slug: `t1091-page-${sfx}`, title: "T1091", templateId },
        modules: [
          {
            ref: "card",
            displayName: `T1091 Card ${sfx}`,
            description: "A card.",
            kind: "content",
            type: "card",
            html: "<div>{{title}}</div>",
            fields: [{ kind: "text", name: "title", label: "Title" }],
            content: { source: "inline", values: { title: "x" } },
          },
          {
            blockName: "content",
            displayName: `T1091 Teaser ${sfx}`,
            description: "A teaser that embeds a button.",
            kind: "cta",
            type: "teaser",
            html: "<section>{{>cta}}</section>",
            fields: [{ kind: "module", name: "cta", label: "CTA", allowedModuleTypes: ["button"] }],
            content: { source: "inline", values: { cta: { $ref: "card" } } },
          },
        ],
      } as never,
      { adapter, registry },
    );
    expect(t.ok).toBe(false);
    expect(t.content).toContain("allowedModuleTypes");
    expect(t.refusal).toBe(true);
    expect(shouldAutoCaptureToolFailure("build_page", t)).toBe(false);
  });

  it("deleting an instance another instance still shows (#1092): refusal", async () => {
    const t = await tool("delete_content_instance", { id: buttonCi });
    expect(t.ok).toBe(false);
    expect(t.content).toContain("cannot delete");
    expect(t.refusal).toBe(true);
    expect(shouldAutoCaptureToolFailure("delete_content_instance", t)).toBe(false);
  });

  it("deleting a module that is still in use (#1091): refusal per id and on the tool", async () => {
    const v = await op<{ refused: { moduleId: string; refusal: boolean }[] }>(
      "modules.delete_many",
      { moduleIds: [buttonId] },
    );
    expect(v.refused).toEqual([expect.objectContaining({ moduleId: buttonId, refusal: true })]);

    const t = await tool("delete_modules_many", { moduleIds: [buttonId] });
    expect(t.ok).toBe(false);
    expect(t.content).toContain("still placed on");
    expect(t.refusal).toBe(true);
    expect(shouldAutoCaptureToolFailure("delete_modules_many", t)).toBe(false);
  });
});

describe("#1091 — real failures stay captured", () => {
  it("a reference to a module that does not exist carries no refusal", async () => {
    const t = await tool("create_content_instance", {
      moduleId: parentId,
      values: {
        cta: {
          moduleId: "00000000-0000-4000-8000-000000001091",
          contentInstanceId: buttonCi,
        },
      },
    });
    expect(t.ok).toBe(false);
    expect(t.content).toContain("does not exist");
    expect(t.refusal).toBeUndefined();
    expect(shouldAutoCaptureToolFailure("create_content_instance", t)).toBe(true);
  });

  it("delete_modules_many with only unknown ids is a failure, not a refusal", async () => {
    const t = await tool("delete_modules_many", {
      moduleIds: ["00000000-0000-4000-8000-000000002091"],
    });
    expect(t.ok).toBe(false);
    expect(t.refusal).toBeUndefined();
    expect(shouldAutoCaptureToolFailure("delete_modules_many", t)).toBe(true);
  });

  it("the capture rule: failures without the flag are filed; successes and bug_report never", () => {
    expect(shouldAutoCaptureToolFailure("build_page", { ok: false })).toBe(true);
    expect(shouldAutoCaptureToolFailure("build_page", { ok: false, refusal: true })).toBe(false);
    expect(shouldAutoCaptureToolFailure("build_page", { ok: true })).toBe(false);
    expect(shouldAutoCaptureToolFailure("bug_report", { ok: false })).toBe(false);
  });
});

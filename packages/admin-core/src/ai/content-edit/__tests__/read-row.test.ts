// SPDX-License-Identifier: MPL-2.0

/**
 * Regression (e2e-livedit 2026-10): the AI passed a layout id (the
 * `layoutId` column of list_templates) to read_content as a template and got
 * the bare "templates.get failed: template not found". Layouts are now a
 * content kind of their own, and an id read under the wrong kind is named
 * back with its real kind. Stub ops shaped like the real get ops: modules.get
 * and templates.get answer "not found" as an error, layouts.get as null.
 */

import { describe, expect, it } from "bun:test";
import {
  type DatabaseAdapter,
  defineOperation,
  type OperationDefinition,
  OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import { z } from "zod";
import type { ToolContext } from "../../tools/dispatch.js";
import { readContentTool } from "../../tools/read-content.js";
import { readContentRow } from "../read-row.js";
import { CONTENT_TARGETS } from "../registry.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "read-row-test",
};

const MODULE_ID = "11111111-1111-4111-8111-111111111111";
const TEMPLATE_ID = "22222222-2222-4222-8222-222222222222";
const LAYOUT_ID = "33333333-3333-4333-8333-333333333333";
const UNKNOWN_ID = "44444444-4444-4444-8444-444444444444";

function op(name: string, handler: (input: Record<string, string>) => unknown) {
  return defineOperation({
    name,
    actorScope: ["human", "ai", "system"],
    database: "cms_admin",
    input: z.any(),
    output: z.any(),
    handler: async (_ctx, input) => handler(input as Record<string, string>) as never,
  });
}

function harness(): ToolContext {
  const registry = new OperationRegistry();
  registry.register(
    op("modules.get", (i) =>
      i.moduleId === MODULE_ID
        ? ok({ module: { id: MODULE_ID, slug: "m", html: "<p>m</p>", css: ".m{}", js: "" } })
        : err({ kind: "HandlerError", operation: "modules.get", message: "module not found" }),
    ),
  );
  registry.register(
    op("templates.get", (i) =>
      i.templateId === TEMPLATE_ID
        ? ok({ template: { id: TEMPLATE_ID, slug: "t", html: "<main></main>", css: "" } })
        : err({ kind: "HandlerError", operation: "templates.get", message: "template not found" }),
    ),
  );
  registry.register(
    op("layouts.get", (i) =>
      ok({
        layout:
          i.layoutId === LAYOUT_ID
            ? { id: LAYOUT_ID, slug: "site-default", html: "<body>shell</body>", css: "body{}" }
            : null,
      }),
    ),
  );
  const adapter = {
    runOperation: (o: OperationDefinition, ctx: ExecutionContext, input: unknown) =>
      o.handler(ctx, input, {} as never),
  } as unknown as DatabaseAdapter;
  return { adapter, registry };
}

describe("readContentRow", () => {
  it("reads a layout's html/css as a content kind of its own", async () => {
    const r = await readContentRow(AI, harness(), CONTENT_TARGETS.layout, LAYOUT_ID);
    expect(r).toEqual({ ok: true, bodies: { html: "<body>shell</body>", css: "body{}" } });
  });

  it("names the real kind of an id read under the wrong one", async () => {
    const r = await readContentRow(AI, harness(), CONTENT_TARGETS.template, LAYOUT_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.content).toContain(`is a layout, not a template`);
    const m = await readContentRow(AI, harness(), CONTENT_TARGETS.layout, MODULE_ID);
    if (!m.ok) expect(m.content).toContain(`entityKind:"module"`);
  });

  it("says plainly when the id is no content row at all", async () => {
    const r = await readContentRow(AI, harness(), CONTENT_TARGETS.module, UNKNOWN_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.content).toContain(`no module with id ${UNKNOWN_ID}`);
      expect(r.content).toContain("list_layouts");
    }
  });
});

describe("read_content", () => {
  it("accepts entityKind 'layout'", async () => {
    const parsed = readContentTool.schema.safeParse({ entityKind: "layout", entityId: LAYOUT_ID });
    expect(parsed.success).toBe(true);
    const r = await readContentTool.handler(
      AI,
      { entityKind: "layout", entityId: LAYOUT_ID },
      harness(),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("<body>shell</body>");
  });
});

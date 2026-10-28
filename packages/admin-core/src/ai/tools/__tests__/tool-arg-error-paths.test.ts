// SPDX-License-Identifier: MPL-2.0

/**
 * Argument errors name where the problem is and what fits there, so the
 * model repairs the call in one retry. Validation runs before the handler,
 * so no database is involved.
 *   - #1151: an unrecognized key nested in an argument names its path.
 *   - #1185: a nested union (`modules.0.moduleId`) lists its allowed forms,
 *     and a null moduleId says how to mint instead.
 *   - #1190: a list field without `listType` names the types.
 *   - #1152: `status` on an existing page names set_pages_status_many.
 *   - closed #1175: the nesting hint never pairs entries with a shared list.
 */

import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@caelo-cms/shared";
import { addModuleTool } from "../add-module.js";
import { buildPageTool } from "../build-page.js";
import { type ToolContext, ToolRegistry } from "../dispatch.js";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000000a1",
  actorKind: "ai",
  requestId: "arg-error-paths",
};
const PAGE = "11111111-1111-4111-8111-111111111111";

function tools(): ToolRegistry {
  const t = new ToolRegistry();
  t.register(buildPageTool);
  t.register(addModuleTool);
  return t;
}

async function call(name: string, args: unknown): Promise<string> {
  const r = await tools().dispatch(name, args, AI, {} as ToolContext);
  expect(r.ok).toBe(false);
  return r.content;
}

describe("tool argument error paths", () => {
  it("names the path of a nested unrecognized key (#1151)", async () => {
    const content = await call("build_page", {
      page: { pageId: PAGE },
      modules: [{ moduleId: PAGE, blockName: "content", editable: true }],
    });
    expect(content).toContain("`modules.0`: unrecognized key(s) `editable`");
    expect(content).not.toContain("this tool does not accept");
  });

  it("keeps the top-level wording for a top-level key", async () => {
    const content = await call("build_page", { page: { pageId: PAGE }, modules: [], extra: 1 });
    expect(content).toContain("Unrecognized argument(s): `extra` — this tool does not accept");
  });

  it("lists the allowed forms of a nested union and how to mint (#1185)", async () => {
    const content = await call("build_page", {
      page: { pageId: PAGE },
      modules: [{ moduleId: null, blockName: "content" }],
    });
    expect(content).toContain(
      '`modules.0.moduleId`: invalid value — expected a uuid string, or an object {"$ref": …}.',
    );
    expect(content).toContain("omit `moduleId`");
  });

  it("names the list types when listType is missing (#1190)", async () => {
    const content = await call("add_module", {
      target: "page",
      targetRef: PAGE,
      blockName: "content",
      position: 0,
      displayName: "Nav",
      html: "<nav>{{#links}}<a>{{label}}</a>{{/links}}</nav>",
      fields: [{ name: "links", kind: "list", label: "Links" }],
    });
    expect(content).toContain("`fields.0.listType`");
    expect(content).toContain('"texts", "links", "menu"');
  });

  it("says status is for new pages and names set_pages_status_many (#1152)", async () => {
    const content = await call("build_page", {
      page: { pageId: PAGE, status: "published" },
      modules: [],
    });
    expect(content).toContain("set_pages_status_many");
  });

  it("never pairs an entries default with a shared navigation list (#1175)", async () => {
    const content = await call("add_module", {
      target: "page",
      targetRef: PAGE,
      blockName: "content",
      position: 0,
      displayName: "Nav",
      html: "<nav></nav>",
      children: [],
    });
    const shared = content.split("\n").find((l) => l.includes('bind:"shared"')) ?? "";
    expect(shared).toContain("upsert_lists_many");
    expect(shared).toContain('list:"caelo:list/<id>"');
    expect(shared).not.toContain("default:[");
  });
});

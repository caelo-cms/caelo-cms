// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1371 — the write-time half of `structure/repeated-render`: a
 * template that loops one list field twice, and a shared list two modules
 * show where one of them is chrome.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import { moduleWriteGuardSuffix } from "../tools/_module-js-guard.js";
import { pageWeightHints, type WeightGuardModule } from "../tools/_page-weight-guard.js";
import type { ToolContext } from "../tools/dispatch.js";

const MENU = "caelo:list/00000000-0000-4000-9000-000000000001";
const menuField = (over: Record<string, unknown> = {}) => ({
  name: "menu",
  kind: "list",
  listType: "menu",
  bind: "shared",
  list: MENU,
  ...over,
});

function mod(n: number, over: Partial<WeightGuardModule> = {}): WeightGuardModule {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    slug: `m${n}`,
    displayName: `Module ${n}`,
    html: '<nav>{{#menu}}<a href="{{link}}">{{label}}</a>{{/menu}}</nav>',
    kind: "content",
    fields: [menuField()],
    ...over,
  };
}

describe("pageWeightHints", () => {
  it("names a template that iterates one list field twice", () => {
    const header = mod(1, {
      kind: "chrome",
      html: '<header><nav>{{#menu}}<a>{{label}}</a>{{/menu}}</nav><div class="drawer">{{ #menu }}<a>{{label}}</a>{{/menu}}</div></header>',
    });
    const hints = pageWeightHints([header], [header.id], new Set());
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("iterates the list field `menu` 2 times");
    expect(hints[0]).toContain('data-caelo-ui="mobile-nav"');
  });

  it("names a shared list a chrome module already shows, once per pair", () => {
    const header = mod(1, { kind: "chrome" });
    const footer = mod(2, {
      fields: [menuField({ name: "links", list: undefined, default: MENU })],
    });
    const hints = pageWeightHints([header, footer], [footer.id, header.id], new Set(["m2"]));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain(`both show ${MENU}`);
    expect(hints[0]).toContain("field `links`");
    expect(hints[0]).toContain("its own short shared list");
  });

  it("is silent for one loop, different lists, or two content modules", () => {
    const header = mod(1, { kind: "chrome" });
    const other = mod(2, {
      fields: [menuField({ list: "caelo:list/00000000-0000-4000-9000-000000000002" })],
    });
    expect(pageWeightHints([header, other], [header.id, other.id], new Set())).toEqual([]);
    // Two content modules with one list (a tag cloud on two page types) are not chrome.
    expect(
      pageWeightHints([mod(3), mod(4)], ["00000000-0000-4000-8000-000000000003"], new Set()),
    ).toEqual([]);
    // A local list field is no shared binding.
    const local = mod(5, {
      kind: "chrome",
      fields: [menuField({ bind: "local", list: undefined, default: [] })],
    });
    expect(pageWeightHints([local, mod(6)], [local.id], new Set())).toEqual([]);
  });
});

describe("moduleWriteGuardSuffix", () => {
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  const AI: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-000000000a1a",
    actorKind: "ai",
    requestId: "epic-1371-unit",
  };

  it("reads the layouts' chrome slugs once and appends the page-weight hints", async () => {
    let layoutReads = 0;
    const header = { ...mod(1), js: "" };
    const footer = { ...mod(2), js: "" };
    const adapter = {
      runOperation: async (op: { name: string }) => {
        if (op.name === "modules.list") return ok({ modules: [header, footer] });
        if (op.name === "layouts.list") {
          layoutReads++;
          return ok({ layouts: [{ html: "<div></div>", blocks: [{ moduleSlugs: ["m1"] }] }] });
        }
        return ok({});
      },
    } as unknown as DatabaseAdapter;
    const s = await moduleWriteGuardSuffix(AI, { adapter, registry } as ToolContext, [footer.id]);
    expect(s).toContain(" page-weight-guard: ");
    expect(s).toContain(
      `"Module 2" (field \`menu\`) and "Module 1" (field \`menu\`) both show ${MENU}`,
    );
    expect(s).not.toContain("module-js-guard");
    expect(layoutReads).toBe(1);
  });
});

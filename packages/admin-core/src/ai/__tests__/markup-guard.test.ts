// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #820 — write-time markup reuse hints. The second copy of a
 * component pattern in field values gets a hint naming the copies; a
 * one-off stays silent; markup that IS an existing module points at it.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import {
  type CatalogModule,
  fieldReuseHints,
  type IndexedInstance,
  moduleReuseHints,
  repeatedItemHints,
  valuePatterns,
  withFieldMarkupGuard,
} from "../tools/_markup-guard.js";
import { carriersOf, listValueHrefs, sharedListHints } from "../tools/_shared-list-guard.js";
import type { ToolContext, ToolDefinitionWithHandler } from "../tools/dispatch.js";

const chain = (n: number) =>
  `<div class="chain">${Array.from(
    { length: n },
    (_, i) => `<div class="step"><span class="n">${i}</span><p>s${i}</p></div>`,
  ).join('<span class="arrow"></span>')}</div>`;

const CARD: CatalogModule = {
  id: "00000000-0000-4000-8000-000000000001",
  displayName: "Diff card",
  html: '<div class="diff-card"><div class="diff-head"><span class="dot"></span></div><pre class="diff-body">{{code}}</pre></div>',
};

const inst = (
  id: string,
  values: Record<string, unknown>,
  placementCount = 1,
): IndexedInstance => ({
  id,
  moduleId: "00000000-0000-4000-8000-0000000000aa",
  moduleDisplayName: "Text",
  placementCount,
  values,
});

describe("valuePatterns", () => {
  it("finds patterns in strings and string list items, ignores prose", () => {
    const found = valuePatterns({
      body: `<p>intro</p>${chain(3)}`,
      bullets: ["plain", chain(2)],
      title: "No markup",
      prose: "<ul><li><a href='/'>x</a></li></ul>",
    });
    expect(found.map((f) => [f.field, f.label])).toEqual([
      ["body", "div.chain"],
      ["bullets", "div.chain"],
    ]);
  });
});

describe("fieldReuseHints", () => {
  it("a one-off pattern on one placement is silent", () => {
    const v = { body: chain(3) };
    expect(fieldReuseHints([v], [inst("a", v)], [CARD])).toEqual([]);
  });

  it("the second copy anywhere names the count and the host module", () => {
    const v = { body: chain(3) };
    const hints = fieldReuseHints([v], [inst("a", v), inst("b", { body: chain(5) })], [CARD]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("`div.chain`, which is now free HTML in 2 placements");
    expect(hints[0]).toContain('(in "Text")');
  });

  it("a synced instance on several pages counts its placements", () => {
    const v = { body: chain(3) };
    expect(fieldReuseHints([v], [inst("a", v, 3)], [])[0]).toContain("in 3 placements");
  });

  it("an existing module's markup pasted into a field points at that module", () => {
    const v = { body: CARD.html.replace("{{code}}", "+a") };
    const hints = fieldReuseHints([v], [inst("a", v)], [CARD]);
    expect(hints[0]).toContain(`the markup of module "Diff card" (${CARD.id})`);
  });
});

describe("moduleReuseHints", () => {
  it("a near-copy of a module (one extra element) is named as such", () => {
    const chainModule: CatalogModule = {
      id: "00000000-0000-4000-8000-000000000002",
      displayName: "Chain",
      html: `<section class="flow"><h2>{{t}}</h2>${chain(2)}</section>`,
    };
    const html = chainModule.html.replace("</h2>", '</h2><p class="lead">{{lead}}</p>');
    const hints = moduleReuseHints(html, [chainModule]);
    expect(hints[0]).toContain('nearly identical to the existing module "Chain"');
  });

  it("unrelated markup yields nothing", () => {
    expect(moduleReuseHints(chain(2), [CARD])).toEqual([]);
  });
});

describe("withFieldMarkupGuard", () => {
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  const AI: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-000000000a1a",
    actorKind: "ai",
    requestId: "issue-820-unit",
  };
  const written = { body: chain(4) };
  const toolCtx = {
    registry,
    adapter: {
      runOperation: async (op: { name: string }) => {
        if (op.name === "modules.list") return ok({ modules: [CARD] });
        if (op.name === "content_instances.list") {
          return ok({
            instances: [inst("a", written), inst("b", { body: chain(2) }), inst("c", { t: "x" })],
          });
        }
        return ok({});
      },
    } as unknown as DatabaseAdapter,
  } as ToolContext;
  const tool: ToolDefinitionWithHandler<{ values: Record<string, unknown>; fail?: boolean }> = {
    name: "fake_write",
    description: "",
    schema: undefined as never,
    handler: async (_ctx, input) =>
      input.fail ? { ok: false, content: "nope" } : { ok: true, content: "written." },
  };
  const guarded = withFieldMarkupGuard(tool, (i) => [i.values]);

  it("appends the hint to a successful write", async () => {
    const r = await guarded.handler(AI, { values: written }, toolCtx);
    expect(r.content).toStartWith("written. 🎯 markup-guard: field `body`");
  });

  it("leaves failed writes and markup-free writes untouched", async () => {
    expect((await guarded.handler(AI, { values: written, fail: true }, toolCtx)).content).toBe(
      "nope",
    );
    expect((await guarded.handler(AI, { values: { title: "x" } }, toolCtx)).content).toBe(
      "written.",
    );
  });
});

describe("repeatedItemHints (#1068)", () => {
  const card = (n: number) =>
    `<article class="tc"><h3 class="tc__name">Tool ${n}</h3><dl class="tc__facts"><dt>Price</dt><dd>${n}</dd></dl></article>`;
  const cards = (n: number) => Array.from({ length: n }, (_, i) => card(i)).join("");

  it("three copies side by side in one value point at a module-list, on one placement too", () => {
    const written = { body_html: `<div class="grid">${cards(3)}</div>` };
    expect(repeatedItemHints(written)).toEqual([
      expect.stringContaining("field `body_html` writes the pattern `article.tc` out 3 times"),
    ]);
    const hints = fieldReuseHints([written], [inst("i1", written)], []);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("module-list");
  });

  it("two copies stay silent", () => {
    const written = { body_html: cards(2) };
    expect(repeatedItemHints(written)).toEqual([]);
    expect(fieldReuseHints([written], [inst("i1", written)], [])).toEqual([]);
  });
});

describe("list field wording (epic #1107)", () => {
  it("repeated items and the second copy recommend a list field before a module-list", () => {
    const card = (n: number) =>
      `<article class="tc"><h3 class="tc__name">T${n}</h3><dl class="tc__facts"><dt>P</dt><dd>${n}</dd></dl></article>`;
    const items = repeatedItemHints({ body_html: [0, 1, 2].map(card).join("") });
    expect(items[0]).toContain("give the host module a `list` field with one entry per item");
    const v = { body: chain(3) };
    const second = fieldReuseHints([v], [inst("a", v), inst("b", { body: chain(4) })], []);
    expect(second[0]).toContain("a `list` field for repeated entries");
  });
});

describe("sharedListHints (epic #1107)", () => {
  const HEADER = "00000000-0000-4000-8000-0000000000b1";
  const FOOTER = "00000000-0000-4000-8000-0000000000b2";
  const menu = (paths: string[]) =>
    paths.map((p, i) => ({
      id: `00000000-0000-4000-9000-00000000000${i}`,
      node: "entry",
      values: { label: p, link: { href: p } },
    }));
  const MENU = ["/", "/docs", "/pricing", "/blog"];
  const modules = (footerDefault: unknown) => [
    {
      id: HEADER,
      displayName: "Site header",
      fields: [{ name: "nav", kind: "list", listType: "menu", default: menu(MENU) }],
    },
    {
      id: FOOTER,
      displayName: "Site footer",
      fields: [{ name: "links", kind: "list", listType: "links", default: footerDefault }],
    },
  ];

  it("reads hrefs of entries and their children; a shared binding is no local list", () => {
    expect(
      listValueHrefs([
        { id: "a", node: "entry", values: { link: { href: "/b" } }, children: menu(["/a"]) },
      ]),
    ).toEqual(["/a", "/b"]);
    expect(listValueHrefs("caelo:list/00000000-0000-4000-8000-000000000001")).toBeNull();
    expect(listValueHrefs(["plain", "strings"])).toBeNull();
  });

  it("names every module that keeps the same links and points at one shared list", () => {
    const carriers = carriersOf(modules(menu([...MENU].reverse())), []);
    const hints = sharedListHints([{ field: "links", value: menu(MENU) }], carriers);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("keeps the same 4 links as 1 other module(s)");
    expect(hints[0]).toContain('"Site header" (field `nav`)');
    expect(hints[0]).toContain('"Site footer" (field `links`)');
    expect(hints[0]).toContain("ONE shared list (promote_local_list");
  });

  it("counts a placement's value like a default, and stays silent for one module or other links", () => {
    const instances = [
      { moduleId: FOOTER, moduleDisplayName: "Site footer", values: { links: menu(MENU) } },
    ];
    expect(
      sharedListHints(
        [{ field: "links", value: menu(MENU) }],
        carriersOf(modules(undefined), instances),
      ),
    ).toHaveLength(1);
    // Only the header carries the menu.
    expect(
      sharedListHints([{ field: "nav", value: menu(MENU) }], carriersOf(modules(undefined), [])),
    ).toEqual([]);
    // The footer links elsewhere.
    expect(
      sharedListHints(
        [{ field: "nav", value: menu(MENU) }],
        carriersOf(modules(menu(["/imprint", "/privacy", "/terms"])), []),
      ),
    ).toEqual([]);
  });

  it("the field guard appends the hint when a placement write copies the header's menu", async () => {
    const registry = new OperationRegistry();
    registerAdminOps(registry);
    const toolCtx = {
      registry,
      adapter: {
        runOperation: async (op: { name: string }) => {
          if (op.name === "modules.list") {
            return ok({ modules: modules(undefined).map((m) => ({ ...m, html: "<nav></nav>" })) });
          }
          if (op.name === "content_instances.list") {
            return ok({
              instances: [
                {
                  ...inst("f", { links: menu(MENU) }),
                  moduleId: FOOTER,
                  moduleDisplayName: "Site footer",
                },
              ],
            });
          }
          return ok({});
        },
      } as unknown as DatabaseAdapter,
    } as ToolContext;
    const tool: ToolDefinitionWithHandler<{ values: Record<string, unknown> }> = {
      name: "fake_write",
      description: "",
      schema: undefined as never,
      handler: async () => ({ ok: true, content: "written." }),
    };
    const r = await withFieldMarkupGuard(tool, (i) => [i.values]).handler(
      { actorId: "00000000-0000-0000-0000-000000000a1a", actorKind: "ai", requestId: "t1107d" },
      { values: { links: menu(MENU) } },
      toolCtx,
    );
    expect(r.content).toStartWith("written. 🎯 markup-guard: field `links` keeps the same 4 links");
  });
});

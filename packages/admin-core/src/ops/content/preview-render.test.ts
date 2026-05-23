// SPDX-License-Identifier: MPL-2.0

/**
 * Tier-1 unit tests for `renderModuleWithContent` (preview-render.ts).
 *
 * The recursive renderer is the §2.1 hot path during every preview
 * render and carries two safety invariants the integration tests can
 * only provoke obliquely:
 *
 *   1. MAX_RECURSION_DEPTH=8 — beyond that, emit an HTML-comment
 *      failure marker and a `missingSlots` entry; never silently
 *      truncate.
 *   2. Cycle detection — `(moduleId, contentInstanceId)` revisits on
 *      the same path produce a comment + missingSlots entry.
 *
 * Both are easier to pin in isolation with synthetic in-memory
 * resolvers than to construct in the full preview pipeline. Pure
 * function, no DB, no compose stack — sub-second.
 */

import { describe, expect, it } from "bun:test";
import {
  type ContentInstanceResource,
  collectNestedRefs,
  type ModuleResource,
  type NestedRefValue,
  type RenderResolver,
  renderModuleWithContent,
} from "./preview-render.js";

function buildResolver(modules: ModuleResource[], cis: ContentInstanceResource[]): RenderResolver {
  const modByIdx = new Map(modules.map((m) => [m.moduleId, m]));
  const ciByIdx = new Map(cis.map((c) => [c.id, c]));
  return {
    getModule(id) {
      return modByIdx.get(id) ?? null;
    },
    getContentInstance(id) {
      return ciByIdx.get(id) ?? null;
    },
  };
}

const PARENT_MOD_ID = "00000000-0000-0000-0000-00000000aaa1";
const CHILD_MOD_ID = "00000000-0000-0000-0000-00000000aaa2";
const GRAND_MOD_ID = "00000000-0000-0000-0000-00000000aaa3";

const PARENT_CI_ID = "00000000-0000-0000-0000-00000000bbb1";
const CHILD_CI_ID = "00000000-0000-0000-0000-00000000bbb2";
const GRAND_CI_ID = "00000000-0000-0000-0000-00000000bbb3";

describe("renderModuleWithContent — primitive substitution", () => {
  it("replaces {{name}} with values[name] and tracks the touched module", () => {
    const resolver = buildResolver(
      [
        {
          moduleId: PARENT_MOD_ID,
          slug: "hero",
          html: "<h1>{{title}}</h1><p>{{body}}</p>",
          css: "",
          js: "",
          fields: [
            { name: "title", kind: "text" },
            { name: "body", kind: "text" },
          ],
        },
      ],
      [
        {
          id: PARENT_CI_ID,
          moduleId: PARENT_MOD_ID,
          values: { title: "Hello", body: "World." },
          deletedAt: null,
        },
      ],
    );
    const r = renderModuleWithContent(PARENT_MOD_ID, PARENT_CI_ID, resolver);
    expect(r.html).toBe("<h1>Hello</h1><p>World.</p>");
    expect(r.missingSlots).toEqual([]);
    expect(r.touchedModuleIds.has(PARENT_MOD_ID)).toBe(true);
  });

  it("falls back to field.default when the value is absent", () => {
    const resolver = buildResolver(
      [
        {
          moduleId: PARENT_MOD_ID,
          slug: "hero",
          html: "<h1>{{title}}</h1>",
          css: "",
          js: "",
          fields: [{ name: "title", kind: "text", default: "Fallback" }],
        },
      ],
      [{ id: PARENT_CI_ID, moduleId: PARENT_MOD_ID, values: {}, deletedAt: null }],
    );
    const r = renderModuleWithContent(PARENT_MOD_ID, PARENT_CI_ID, resolver);
    expect(r.html).toBe("<h1>Fallback</h1>");
  });
});

describe("renderModuleWithContent — nested module slots", () => {
  it("composes a 3-level tree via {{>fieldName}}", () => {
    const resolver = buildResolver(
      [
        {
          moduleId: PARENT_MOD_ID,
          slug: "parent",
          html: "<section>{{>child}}</section>",
          css: "",
          js: "",
          fields: [{ name: "child", kind: "module" }],
        },
        {
          moduleId: CHILD_MOD_ID,
          slug: "child",
          html: "<div>{{>grand}}</div>",
          css: "",
          js: "",
          fields: [{ name: "grand", kind: "module" }],
        },
        {
          moduleId: GRAND_MOD_ID,
          slug: "grand",
          html: "<span>{{label}}</span>",
          css: "",
          js: "",
          fields: [{ name: "label", kind: "text" }],
        },
      ],
      [
        {
          id: PARENT_CI_ID,
          moduleId: PARENT_MOD_ID,
          values: { child: { moduleId: CHILD_MOD_ID, contentInstanceId: CHILD_CI_ID } },
          deletedAt: null,
        },
        {
          id: CHILD_CI_ID,
          moduleId: CHILD_MOD_ID,
          values: { grand: { moduleId: GRAND_MOD_ID, contentInstanceId: GRAND_CI_ID } },
          deletedAt: null,
        },
        {
          id: GRAND_CI_ID,
          moduleId: GRAND_MOD_ID,
          values: { label: "deep" },
          deletedAt: null,
        },
      ],
    );
    const r = renderModuleWithContent(PARENT_MOD_ID, PARENT_CI_ID, resolver);
    expect(r.html).toBe("<section><div><span>deep</span></div></section>");
    expect(r.missingSlots).toEqual([]);
    // All three modules touched — caller uses this set for CSS/JS dedup.
    expect(r.touchedModuleIds.has(PARENT_MOD_ID)).toBe(true);
    expect(r.touchedModuleIds.has(CHILD_MOD_ID)).toBe(true);
    expect(r.touchedModuleIds.has(GRAND_MOD_ID)).toBe(true);
  });

  it("renders module-list slots {{#field}}…{{/field}} for each array element", () => {
    const ITEM_CI_A = "00000000-0000-0000-0000-00000000ccca";
    const ITEM_CI_B = "00000000-0000-0000-0000-00000000cccb";
    const resolver = buildResolver(
      [
        {
          moduleId: PARENT_MOD_ID,
          slug: "list-parent",
          html: "<ul>{{#items}}{{/items}}</ul>",
          css: "",
          js: "",
          fields: [{ name: "items", kind: "module-list" }],
        },
        {
          moduleId: CHILD_MOD_ID,
          slug: "item",
          html: "<li>{{label}}</li>",
          css: "",
          js: "",
          fields: [{ name: "label", kind: "text" }],
        },
      ],
      [
        {
          id: PARENT_CI_ID,
          moduleId: PARENT_MOD_ID,
          values: {
            items: [
              { moduleId: CHILD_MOD_ID, contentInstanceId: ITEM_CI_A },
              { moduleId: CHILD_MOD_ID, contentInstanceId: ITEM_CI_B },
            ],
          },
          deletedAt: null,
        },
        { id: ITEM_CI_A, moduleId: CHILD_MOD_ID, values: { label: "A" }, deletedAt: null },
        { id: ITEM_CI_B, moduleId: CHILD_MOD_ID, values: { label: "B" }, deletedAt: null },
      ],
    );
    const r = renderModuleWithContent(PARENT_MOD_ID, PARENT_CI_ID, resolver);
    expect(r.html).toBe("<ul><li>A</li><li>B</li></ul>");
    expect(r.missingSlots).toEqual([]);
  });
});

describe("renderModuleWithContent — list-of-primitive slots", () => {
  it("text-list iterates {{.}} per string element", () => {
    const resolver = buildResolver(
      [
        {
          moduleId: PARENT_MOD_ID,
          slug: "tag-cloud",
          html: "<div>{{#tags}}<span>{{.}}</span>{{/tags}}</div>",
          css: "",
          js: "",
          fields: [{ name: "tags", kind: "text-list" }],
        },
      ],
      [
        {
          id: PARENT_CI_ID,
          moduleId: PARENT_MOD_ID,
          values: { tags: ["alpha", "beta", "gamma"] },
          deletedAt: null,
        },
      ],
    );
    const r = renderModuleWithContent(PARENT_MOD_ID, PARENT_CI_ID, resolver);
    expect(r.html).toBe("<div><span>alpha</span><span>beta</span><span>gamma</span></div>");
    expect(r.missingSlots).toEqual([]);
  });

  it("text-list also accepts the {{item}} alias", () => {
    const resolver = buildResolver(
      [
        {
          moduleId: PARENT_MOD_ID,
          slug: "bullets",
          html: "<ul>{{#bullets}}<li>{{item}}</li>{{/bullets}}</ul>",
          css: "",
          js: "",
          fields: [{ name: "bullets", kind: "text-list" }],
        },
      ],
      [{ id: PARENT_CI_ID, moduleId: PARENT_MOD_ID, values: { bullets: ["one", "two"] }, deletedAt: null }],
    );
    const r = renderModuleWithContent(PARENT_MOD_ID, PARENT_CI_ID, resolver);
    expect(r.html).toBe("<ul><li>one</li><li>two</li></ul>");
  });

  it("text-list falls back to field.default when values entry is absent", () => {
    const resolver = buildResolver(
      [
        {
          moduleId: PARENT_MOD_ID,
          slug: "tag-cloud",
          html: "<div>{{#tags}}<span>{{.}}</span>{{/tags}}</div>",
          css: "",
          js: "",
          fields: [
            {
              name: "tags",
              kind: "text-list",
              default: ["alpha", "beta"],
            },
          ],
        },
      ],
      [{ id: PARENT_CI_ID, moduleId: PARENT_MOD_ID, values: {}, deletedAt: null }],
    );
    const r = renderModuleWithContent(PARENT_MOD_ID, PARENT_CI_ID, resolver);
    expect(r.html).toBe("<div><span>alpha</span><span>beta</span></div>");
  });

  it("link-list iterates {{label}} + {{href}} per element", () => {
    const resolver = buildResolver(
      [
        {
          moduleId: PARENT_MOD_ID,
          slug: "primary-nav",
          html: '<nav>{{#menu}}<a href="{{href}}">{{label}}</a>{{/menu}}</nav>',
          css: "",
          js: "",
          fields: [{ name: "menu", kind: "link-list" }],
        },
      ],
      [
        {
          id: PARENT_CI_ID,
          moduleId: PARENT_MOD_ID,
          values: {
            menu: [
              { label: "Home", href: "/" },
              { label: "About", href: "/about" },
              { label: "Contact", href: "/contact" },
            ],
          },
          deletedAt: null,
        },
      ],
    );
    const r = renderModuleWithContent(PARENT_MOD_ID, PARENT_CI_ID, resolver);
    expect(r.html).toBe(
      '<nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>',
    );
    expect(r.missingSlots).toEqual([]);
  });

  it("link-list malformed element gets a per-element marker, others render", () => {
    const resolver = buildResolver(
      [
        {
          moduleId: PARENT_MOD_ID,
          slug: "primary-nav",
          html: '<nav>{{#menu}}<a href="{{href}}">{{label}}</a>{{/menu}}</nav>',
          css: "",
          js: "",
          fields: [{ name: "menu", kind: "link-list" }],
        },
      ],
      [
        {
          id: PARENT_CI_ID,
          moduleId: PARENT_MOD_ID,
          values: {
            menu: [
              { label: "Home", href: "/" },
              { label: "missing-href" }, // malformed
              { label: "About", href: "/about" },
            ],
          },
          deletedAt: null,
        },
      ],
    );
    const r = renderModuleWithContent(PARENT_MOD_ID, PARENT_CI_ID, resolver);
    expect(r.html).toContain('<a href="/">Home</a>');
    expect(r.html).toContain('<a href="/about">About</a>');
    expect(r.html).toContain("link-list-malformed");
    expect(r.missingSlots.some((s) => s.startsWith("link-list-malformed"))).toBe(true);
  });
});

describe("renderModuleWithContent — safety invariants", () => {
  it("emits depth-limit comment when recursion exceeds MAX_RECURSION_DEPTH=8", () => {
    // Build a chain of 12 modules each referencing the next, blowing
    // past the 8-level cap. Modules and CIs share the index suffix.
    const modules: ModuleResource[] = [];
    const cis: ContentInstanceResource[] = [];
    for (let i = 0; i < 12; i += 1) {
      const nextIdx = i + 1;
      modules.push({
        moduleId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        slug: `m${i}`,
        html: nextIdx < 12 ? "<x>{{>next}}</x>" : "<x>leaf</x>",
        css: "",
        js: "",
        fields: nextIdx < 12 ? [{ name: "next", kind: "module" }] : [],
      });
      cis.push({
        id: `00000000-0000-0000-0000-${String(i).padStart(12, "f")}`,
        moduleId: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        values:
          nextIdx < 12
            ? {
                next: {
                  moduleId: `00000000-0000-0000-0000-${String(nextIdx).padStart(12, "0")}`,
                  contentInstanceId: `00000000-0000-0000-0000-${String(nextIdx).padStart(12, "f")}`,
                },
              }
            : {},
        deletedAt: null,
      });
    }
    const resolver = buildResolver(modules, cis);
    const root = modules[0];
    const rootCi = cis[0];
    if (!root || !rootCi) throw new Error("fixture broken");
    const r = renderModuleWithContent(root.moduleId, rootCi.id, resolver);
    expect(r.html).toContain("caelo:missing");
    expect(r.html).toContain("depth-limit-8");
    expect(r.missingSlots.some((s) => s.startsWith("depth-limit"))).toBe(true);
  });

  it("emits cycle comment when a (moduleId, contentInstanceId) pair revisits its own path", () => {
    // A → B → A cycle: parent references child references parent. The
    // recursion path Set should fire on the second visit to PARENT_CI_ID.
    const resolver = buildResolver(
      [
        {
          moduleId: PARENT_MOD_ID,
          slug: "parent",
          html: "<a>{{>child}}</a>",
          css: "",
          js: "",
          fields: [{ name: "child", kind: "module" }],
        },
        {
          moduleId: CHILD_MOD_ID,
          slug: "child",
          html: "<b>{{>back}}</b>",
          css: "",
          js: "",
          fields: [{ name: "back", kind: "module" }],
        },
      ],
      [
        {
          id: PARENT_CI_ID,
          moduleId: PARENT_MOD_ID,
          values: { child: { moduleId: CHILD_MOD_ID, contentInstanceId: CHILD_CI_ID } },
          deletedAt: null,
        },
        {
          id: CHILD_CI_ID,
          moduleId: CHILD_MOD_ID,
          values: { back: { moduleId: PARENT_MOD_ID, contentInstanceId: PARENT_CI_ID } },
          deletedAt: null,
        },
      ],
    );
    const r = renderModuleWithContent(PARENT_MOD_ID, PARENT_CI_ID, resolver);
    expect(r.html).toContain("caelo:missing");
    expect(r.html).toContain("cycle");
    expect(r.missingSlots.some((s) => s.startsWith("cycle:"))).toBe(true);
  });

  it("emits missing-module comment when a referenced module is gone", () => {
    const resolver = buildResolver(
      [
        {
          moduleId: PARENT_MOD_ID,
          slug: "parent",
          html: "<a>{{>child}}</a>",
          css: "",
          js: "",
          fields: [{ name: "child", kind: "module" }],
        },
      ],
      [
        {
          id: PARENT_CI_ID,
          moduleId: PARENT_MOD_ID,
          values: { child: { moduleId: CHILD_MOD_ID, contentInstanceId: CHILD_CI_ID } },
          deletedAt: null,
        },
      ],
    );
    const r = renderModuleWithContent(PARENT_MOD_ID, PARENT_CI_ID, resolver);
    expect(r.html).toContain("module-missing");
    expect(r.missingSlots.some((s) => s.startsWith("module-missing"))).toBe(true);
  });

  it("emits content-instance-missing comment when the CI is soft-deleted", () => {
    const resolver = buildResolver(
      [
        {
          moduleId: PARENT_MOD_ID,
          slug: "parent",
          html: "<a>{{>child}}</a>",
          css: "",
          js: "",
          fields: [{ name: "child", kind: "module" }],
        },
        {
          moduleId: CHILD_MOD_ID,
          slug: "child",
          html: "<b>x</b>",
          css: "",
          js: "",
          fields: [],
        },
      ],
      [
        {
          id: PARENT_CI_ID,
          moduleId: PARENT_MOD_ID,
          values: { child: { moduleId: CHILD_MOD_ID, contentInstanceId: CHILD_CI_ID } },
          deletedAt: null,
        },
        {
          id: CHILD_CI_ID,
          moduleId: CHILD_MOD_ID,
          values: {},
          deletedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    );
    const r = renderModuleWithContent(PARENT_MOD_ID, PARENT_CI_ID, resolver);
    expect(r.html).toContain("content-instance-missing");
    expect(r.missingSlots.some((s) => s.startsWith("content-instance-missing"))).toBe(true);
  });
});

describe("collectNestedRefs", () => {
  it("returns single + list refs from a values bag, ignoring primitives", () => {
    const refA: NestedRefValue = { moduleId: "m-a", contentInstanceId: "c-a" };
    const refB: NestedRefValue = { moduleId: "m-b", contentInstanceId: "c-b" };
    const refC: NestedRefValue = { moduleId: "m-c", contentInstanceId: "c-c" };
    const refs = collectNestedRefs({
      title: "Hello",
      cta: refA,
      items: [refB, refC, "not-a-ref"],
      enabled: true,
    });
    expect(refs).toHaveLength(3);
    expect(refs).toEqual(expect.arrayContaining([refA, refB, refC]));
  });
});

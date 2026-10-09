// SPDX-License-Identifier: MPL-2.0

/**
 * The composer renders nested modules (`module` / `module-list` fields)
 * through the shared recursive renderer when the caller supplies
 * `nestedModules` — the static generator's path. Before, the composer
 * had no renderer for them and every nested module shipped as a
 * `needs recursive renderer` comment: pricing cards, card grids and FAQ
 * items silently missing from published pages.
 */

import { describe, expect, it } from "bun:test";
import type {
  NestedContentInstanceResource,
  NestedModuleResource,
  NestedRenderResolver,
} from "./nested-module-render.js";
import {
  type ComposeDeferral,
  ComposeError,
  type ComposeModule,
  composePageWithLayout,
} from "./preview-compose.js";

const layoutHtml = `<!doctype html><html><head></head><body><main><caelo-slot name="content">_</caelo-slot></main></body></html>`;
const templateHtml = `<body><caelo-slot name="content">_</caelo-slot></body>`;

const CARD_MOD = "00000000-0000-0000-0000-0000000c0001";
const CARD_A = "00000000-0000-0000-0000-0000000ca001";
const CARD_B = "00000000-0000-0000-0000-0000000ca002";
const GONE = "00000000-0000-0000-0000-00000000dead";

const card: NestedModuleResource = {
  moduleId: CARD_MOD,
  slug: "card",
  html: "<article>{{title}}</article>",
  css: ".card{color:red}",
  js: "",
  fields: [{ name: "title", kind: "text" }],
};

function resolver(
  modules: NestedModuleResource[],
  instances: NestedContentInstanceResource[],
): NestedRenderResolver {
  return {
    getModule: (id) => modules.find((m) => m.moduleId === id) ?? null,
    getContentInstance: (id) => instances.find((c) => c.id === id) ?? null,
  };
}

const instances: NestedContentInstanceResource[] = [
  { id: CARD_A, moduleId: CARD_MOD, values: { title: "Starter" }, deletedAt: null },
  { id: CARD_B, moduleId: CARD_MOD, values: { title: "Pro" }, deletedAt: null },
];

function grid(cards: unknown[]): ComposeModule {
  return {
    moduleId: "00000000-0000-0000-0000-0000000e0001",
    slug: "card-grid",
    displayName: "Card grid",
    html: '<div class="grid">{{#cards}}{{/cards}}</div>',
    css: ".grid{display:grid}",
    js: "",
    fields: [{ name: "cards", kind: "module-list" }],
    contentValues: { cards },
  };
}

function compose(m: ComposeModule, nested?: NestedRenderResolver, deferred = {}) {
  return composePageWithLayout({
    templateHtml,
    templateCss: "",
    blocks: [{ blockName: "content", modules: [m] }],
    layoutHtml,
    layoutCss: "",
    layoutBlocks: [],
    layoutSlug: "test",
    deferredModules: deferred,
    ...(nested ? { nestedModules: nested } : {}),
  });
}

describe("composePageWithLayout — nested modules", () => {
  const refs = [
    { moduleId: CARD_MOD, contentInstanceId: CARD_A },
    { moduleId: CARD_MOD, contentInstanceId: CARD_B },
  ];

  it("renders every module-list element with the nested resolver", () => {
    const out = compose(grid(refs), resolver([card], instances));
    expect(out.html).toContain("<article>Starter</article><article>Pro</article>");
    expect(out.html).not.toContain("needs recursive renderer");
    expect(out.moduleFailures).toEqual([]);
  });

  it("adds the nested module's CSS to the page bundle exactly once", () => {
    const out = compose(grid(refs), resolver([card], instances));
    expect(out.html.split(".card{color:red}").length - 1).toBe(1);
  });

  it("names the page module and field trail when a nested ref is broken", () => {
    const out = compose(
      grid([refs[0], { moduleId: CARD_MOD, contentInstanceId: GONE }, "not-a-ref"]),
      resolver([card], instances),
    );
    expect(out.html).toContain("<article>Starter</article>");
    expect(out.moduleFailures).toEqual([
      {
        blockName: "content",
        moduleId: "00000000-0000-0000-0000-0000000e0001",
        moduleSlug: "card-grid",
        field: "cards[1]",
        reason: `content-instance-missing:${GONE}`,
      },
      {
        blockName: "content",
        moduleId: "00000000-0000-0000-0000-0000000e0001",
        moduleSlug: "card-grid",
        field: "",
        reason: "module-list-malformed:cards[2]",
      },
    ]);
  });

  it("without a resolver reports the escape hatch as a failure instead of hiding it", () => {
    const out = compose(grid(refs));
    expect(out.html).toContain("needs recursive renderer");
    expect(out.moduleFailures.map((f) => f.reason)).toEqual([
      "nested-renderer-unavailable:cards[0]",
      "nested-renderer-unavailable:cards[1]",
    ]);
  });

  it("refuses to render a plugin-withheld module nested inside another module", () => {
    const deferral: ComposeDeferral = {
      pluginSlug: "consent",
      reason: "needs-consent",
      placeholderModuleSlug: "consent-placeholder",
      placeholderHtml: "<p>consent</p>",
      placeholderCss: "",
    };
    expect(() =>
      compose(grid(refs), resolver([card], instances), { [CARD_MOD]: deferral }),
    ).toThrow(ComposeError);
  });

  it("keeps a withheld parent's nested CSS/JS inside its gate, never in the page bundles", () => {
    const tracker: NestedModuleResource = {
      ...card,
      css: ".card{background:url(https://vendor.example/bg.png)}",
      js: "fetch('https://vendor.example/beacon')",
    };
    const parent = grid(refs);
    const deferral: ComposeDeferral = {
      pluginSlug: "consent",
      reason: "needs-consent",
      placeholderModuleSlug: "consent-placeholder",
      placeholderHtml: "<p>consent</p>",
      placeholderCss: "",
    };
    const out = compose(parent, resolver([tracker], instances), {
      [parent.moduleId]: deferral,
    });
    const gateStart = out.html.indexOf("<template data-caelo-deferred-content>");
    const gateEnd = out.html.indexOf("</template>", gateStart);
    expect(gateStart).toBeGreaterThan(-1);
    const gate = out.html.slice(gateStart, gateEnd);
    const outsideGate = out.html.slice(0, gateStart) + out.html.slice(gateEnd);

    // The nested JS is parked inert under its own module id, once.
    expect(gate).toContain(
      `<script type="text/plain" data-caelo-deferred-script="${CARD_MOD}">${tracker.js}</script>`,
    );
    expect(gate.split(tracker.js).length - 1).toBe(1);
    expect(gate).toContain(`<style data-source="module">${tracker.css}</style>`);
    // ...and nowhere outside the gate: no page-wide module bundle carries it.
    expect(outsideGate).not.toContain("vendor.example");
    expect(out.html).not.toContain('<script defer data-source="modules">');
  });
});

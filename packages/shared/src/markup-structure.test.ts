// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  freeRegions,
  isPattern,
  MAX_NODES,
  moduleRoots,
  NEAR_MATCH_THRESHOLD,
  outermostPatterns,
  parseMarkup,
  shapeSimilarity,
  shapeTree,
  stripMustache,
  templateShape,
} from "./markup-structure.js";

const chain = (steps: string[]) =>
  `<div class="chain">${steps
    .map((s, i) => `<div class="step"><span class="n">${i + 1}</span><p>${s}</p></div>`)
    .join('<span class="arrow"></span>')}</div>`;

function shapeOf(html: string) {
  const root = parseMarkup(html)[0];
  if (!root) throw new Error("no element");
  const shape = shapeTree(root).get(root);
  if (!shape) throw new Error("no shape");
  return shape;
}

describe("signatures", () => {
  it("ignore text and repetition: a 3-step and a 5-step chain are the same pattern", () => {
    const a = shapeOf(chain(["Crawl", "Diff", "Alert"]));
    const b = shapeOf(chain(["One", "Two", "Three", "Four", "Five"]));
    expect(a.signature).toBe(b.signature);
    expect(isPattern(a)).toBe(true);
  });

  it("class order and duplicate class tokens do not matter", () => {
    expect(shapeOf('<div class="b a a"><p></p></div>').signature).toBe(
      shapeOf('<div class="a b"><p></p></div>').signature,
    );
  });

  it("a different class makes a different signature", () => {
    expect(shapeOf(chain(["x"])).signature).not.toBe(
      shapeOf(chain(["x"]).replace('class="chain"', 'class="flow"')).signature,
    );
  });

  it("near matches score above the threshold, unrelated markup below", () => {
    const a = shapeOf(chain(["x", "y"]));
    const b = shapeOf(chain(["x", "y"]).replace("</p>", "</p><small>note</small>"));
    expect(a.signature).not.toBe(b.signature);
    expect(shapeSimilarity(a, b)).toBeGreaterThanOrEqual(NEAR_MATCH_THRESHOLD);
    const c = shapeOf('<table class="pm"><tr><th>a</th><td>b</td></tr></table>');
    expect(shapeSimilarity(a, c)).toBeLessThan(0.2);
  });
});

describe("isPattern", () => {
  it("class-less prose never qualifies, however deep", () => {
    expect(isPattern(shapeOf("<ul><li><a>x</a><strong>y</strong></li></ul>"))).toBe(false);
    expect(isPattern(shapeOf("<table><thead><tr><th>a</th></tr></thead></table>"))).toBe(false);
  });

  it("small classed markup is not a component", () => {
    expect(isPattern(shapeOf('<p class="lead"><a>x</a></p>'))).toBe(false);
  });
});

describe("outermostPatterns", () => {
  it("reports the outer pattern, not the patterns inside it", () => {
    const html = `<section class="wrap"><h2>t</h2>${chain(["a", "b"])}</section>`;
    const found = outermostPatterns(parseMarkup(html));
    expect(found.map((f) => f.node.tag + f.node.classes.join("."))).toEqual(["sectionwrap"]);
  });

  it("finds several patterns side by side in prose", () => {
    const html = `<p>intro</p>${chain(["a"])}<p>mid</p>${chain(["b"]).replace("chain", "pair")}`;
    expect(outermostPatterns(parseMarkup(html)).map((f) => f.node.classes[0])).toEqual([
      "chain",
      "pair",
    ]);
  });
});

describe("templates and free regions", () => {
  const template =
    '<section class="prose"><h2>{{title}}</h2><div class="body">{{body}}</div>' +
    '<ul class="tags">{{#tags}}<li class="tag">{{.}}</li>{{/tags}}</ul></section>';

  it("stripMustache keeps the markup a template renders", () => {
    expect(stripMustache("<p>{{a}}{{{b}}}</p>{{#s}}<i></i>{{/s}}{{>n}}")).toBe("<p></p><i></i>");
  });

  it("everything a template renders, list items included, is not free", () => {
    const rendered = parseMarkup(
      '<section class="prose" data-caelo-module-id="m1"><h2>Hi</h2><div class="body"><p>text</p></div>' +
        '<ul class="tags"><li class="tag">a</li><li class="tag">b</li></ul></section>',
    );
    const root = moduleRoots(rendered)[0];
    if (!root) throw new Error("no module root");
    const free = freeRegions(root, parseMarkup(stripMustache(template)));
    expect(free?.map((n) => n.tag)).toEqual(["p"]);
  });

  it("markup pasted into a richtext value is a free region", () => {
    const rendered = parseMarkup(
      `<section class="prose" data-caelo-module-id="m1"><h2>Hi</h2><div class="body">${chain(["a", "b"])}</div></section>`,
    );
    const root = moduleRoots(rendered)[0];
    if (!root) throw new Error("no module root");
    const free = freeRegions(root, parseMarkup(stripMustache(template))) ?? [];
    expect(outermostPatterns(free).map((f) => f.node.classes[0])).toEqual(["chain"]);
  });

  it("a nested module is opaque to its parent and found on its own", () => {
    const rendered = parseMarkup(
      `<section class="prose" data-caelo-module-id="m1"><div class="body">${chain(["a"]).replace(
        '<div class="chain"',
        '<div class="chain" data-caelo-module-id="m2"',
      )}</div></section>`,
    );
    expect(moduleRoots(rendered).map((r) => r.moduleId)).toEqual(["m1", "m2"]);
    const root = moduleRoots(rendered)[0];
    if (!root) throw new Error("no module root");
    expect(freeRegions(root, parseMarkup(stripMustache(template)))).toEqual([]);
  });

  it("returns null when the rendered root is not the template's root", () => {
    const rendered = parseMarkup('<nav data-caelo-module-id="m3"><a>x</a></nav>');
    const root = moduleRoots(rendered)[0];
    if (!root) throw new Error("no module root");
    expect(freeRegions(root, parseMarkup(stripMustache(template)))).toBeNull();
  });

  it("templateShape fingerprints the template's root element", () => {
    const t = templateShape(
      '<div class="chain">{{#steps}}<div class="step"><span class="n">{{n}}</span><p>{{t}}</p></div><span class="arrow"></span>{{/steps}}</div>',
    );
    expect(t?.signature).toBe(shapeOf(chain(["a", "b", "c"])).signature);
  });
});

describe("bounds", () => {
  it("stops collecting elements at MAX_NODES", () => {
    const html = "<div>".repeat(10) + "<i></i>".repeat(MAX_NODES + 100) + "</div>".repeat(10);
    const roots = parseMarkup(html);
    let count = 0;
    const walk = (n: (typeof roots)[number]) => {
      count++;
      for (const c of n.children) walk(c);
    };
    for (const r of roots) walk(r);
    expect(count).toBe(MAX_NODES);
  });

  it("does not descend into svg icons", () => {
    const root = parseMarkup('<span class="i"><svg><g><path/><path/></g></svg></span>')[0];
    expect(root?.children[0]?.children).toEqual([]);
  });
});

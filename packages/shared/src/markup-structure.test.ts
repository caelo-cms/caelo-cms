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
  repeatedSiblingPatterns,
  shapeSimilarity,
  shapeTree,
  stripMustache,
  templateShape,
} from "./markup-structure.js";
import { tagModuleId } from "./module-id-tag.js";

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

  it("stripMustache matches the two-pass regex on edge cases and stays linear on long brace runs", () => {
    const regex = (t: string): string =>
      t.replace(/\{\{\{[^}]*\}\}\}/g, "").replace(/\{\{[^}]*\}\}/g, "");
    for (const t of [
      "{{x{{{y}}}",
      "{{a}}}",
      "{{{a}}",
      "{{{{a}}}}",
      "a{b}c{{",
      "{{}}{{{}}}",
      "}}{{a}b}}",
      "<p>{{#s}}{{{h}}}{{/s}}</p>",
    ]) {
      expect(stripMustache(t)).toBe(regex(t));
    }
    const started = performance.now();
    stripMustache("{{{{{{".repeat(50_000));
    stripMustache(`${"{{".repeat(50_000)}}`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("stripMustache markSections keeps sections between elements as markers (#1256)", () => {
    const t =
      '<ul class="x {{#on}}on{{/on}}">{{#links}}<li><a href="{{link}}">{{label}}</a></li>{{/links}}{{^links}}<p>none</p>{{/links}}</ul>';
    expect(stripMustache(t, { markSections: true })).toBe(
      '<ul class="x "><caelo-section class="s:links"><li><a href=""></a></li></caelo-section><caelo-section class="i:links"><p>none</p></caelo-section></ul>',
    );
    // Default output is unchanged.
    expect(stripMustache(t)).toBe('<ul class="x "><li><a href=""></a></li><p>none</p></ul>');
    stripMustache(`{{#${" ".repeat(50_000)}`, { markSections: true });
  });

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

  it("a section inside a tag is optional: dropped by default, kept on request (#1104)", () => {
    const t =
      '<div class="wrapc split {{#reverse}}rev{{/reverse}}" data-x="{{^a}}1{{/a}}"><p>{{t}}</p></div>';
    expect(stripMustache(t)).toBe('<div class="wrapc split " data-x=""><p></p></div>');
    expect(stripMustache(t, { keepOptionalAttributeText: true })).toBe(
      '<div class="wrapc split rev" data-x="1"><p></p></div>',
    );
    // A section between elements still renders its body once (a list).
    expect(stripMustache('<ul>{{#items}}<li class="i">{{.}}</li>{{/items}}</ul>')).toBe(
      '<ul><li class="i"></li></ul>',
    );
    // A `>` inside a quoted value or a partial does not end the tag.
    expect(stripMustache('<a title="x>y" class="{{#on}}on{{/on}}">{{>p}}</a>')).toBe(
      '<a title="x>y" class=""></a>',
    );
    const started = performance.now();
    stripMustache(`<a ${"{{#x}}".repeat(50_000)}>`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("an optional class does not make renders without it free markup (#1104)", () => {
    const tpl =
      '<section class="sec"><div class="wrapc split {{#reverse}}rev{{/reverse}}"><h2>{{t}}</h2><div class="body">{{{body}}}</div></div></section>';
    const template = parseMarkup(stripMustache(tpl));
    for (const cls of ["wrapc split", "wrapc split rev"]) {
      const rendered = parseMarkup(
        `<section class="sec" data-caelo-module-id="m1"><div class="${cls}"><h2>Hi</h2><div class="body"><p>x</p></div></div></section>`,
      );
      const root = moduleRoots(rendered)[0];
      if (!root) throw new Error("no module root");
      expect(freeRegions(root, template)?.map((n) => n.tag)).toEqual(["p"]);
    }
  });

  it("a root whose classes all sit in sections is still checked (#1104)", () => {
    const tpl =
      '<div class="{{#moment}}moment{{/moment}}{{^moment}}sec{{/moment}}"><h2>{{t}}</h2><div class="body">{{{body}}}</div></div>';
    const rendered = parseMarkup(
      `<div class="sec" data-caelo-module-id="m1"><h2>Hi</h2><div class="body">${chain(["a", "b"])}</div></div>`,
    );
    const root = moduleRoots(rendered)[0];
    if (!root) throw new Error("no module root");
    const free = freeRegions(root, parseMarkup(stripMustache(tpl)));
    expect(free).not.toBeNull();
    expect(outermostPatterns(free ?? []).map((f) => f.node.classes[0])).toEqual(["chain"]);
  });

  it("templateShape fingerprints the template's root element", () => {
    const t = templateShape(
      '<div class="chain">{{#steps}}<div class="step"><span class="n">{{n}}</span><p>{{t}}</p></div><span class="arrow"></span>{{/steps}}</div>',
    );
    expect(t?.signature).toBe(shapeOf(chain(["a", "b", "c"])).signature);
  });
});

describe("#1027 — template children are matched by best fit, not first fit", () => {
  // The three templates from the searchVIU audit: a classless (or less
  // specific) left column before a classed right column. First-fit paired
  // the left column's template node with the right column and reported
  // the right column's own template markup as free HTML.
  const DEMO_FORM =
    '<div class="wrapc ctaform"><div><h2>{{title}}</h2><p>{{intro}}</p></div>' +
    '<div class="box steps" data-steps data-topic="{{preselected_topic}}">' +
    '<ol class="sbar"><li class="on">Thema</li><li>Kontakt</li><li>Termin</li></ol>' +
    '<div class="step"><label>Thema</label><select name="topic"><option>SEO</option></select></div>' +
    '<div class="step"><label>E-Mail</label><input type="email" name="email"></div>' +
    '<div class="step"><button type="submit">Demo anfragen</button></div></div></div>';
  const SPLIT_CHAT =
    '<section class="split"><div class="rv"><h2>{{title}}</h2><p>{{lead}}</p></div>' +
    '<div class="chat rv"><div class="q"><p>Wie steht meine Seite?</p></div>' +
    '<div class="a"><p>Drei Seiten haben neue 404-Fehler.</p><ul><li>/a</li></ul></div></div></section>';
  const HERO_WINDOW =
    '<section class="hero"><div><h1>{{title}}</h1><p>{{lead}}</p><a class="btn" href="{{cta_href}}">{{cta}}</a></div>' +
    '<div class="win"><div class="bar"><span></span><span></span></div>' +
    '<div class="bd"><img src="{{image}}" alt=""><p class="cap">Monitoring</p></div></div></section>';

  /** The rendered module: placeholders filled, root tagged as the composer does. */
  const render = (template: string, fill = "x") =>
    tagModuleId(template.replace(/\{\{\{?\w+\}?\}\}/g, fill), "m1");
  const free = (template: string, rendered: string) => {
    const root = moduleRoots(parseMarkup(rendered))[0];
    if (!root) throw new Error("no module root");
    return freeRegions(root, parseMarkup(stripMustache(template)));
  };

  for (const [name, template] of [
    ["Demo-Formular in drei Schritten (div before div.box.steps)", DEMO_FORM],
    ["Split mit KI-Chat (div.rv before div.chat.rv)", SPLIT_CHAT],
    ["Hero Produktseite mit Fenster (div before div.win)", HERO_WINDOW],
  ] as const) {
    it(`${name}: its own rendered output has no free regions`, () => {
      expect(free(template, render(template))).toEqual([]);
    });
  }

  it("a classless div before a div.card sibling: no free regions", () => {
    const template =
      '<div class="pair"><div><p>{{a}}</p></div><div class="card"><h3>{{t}}</h3><ul class="pts"><li>{{p}}</li></ul></div></div>';
    expect(free(template, render(template))).toEqual([]);
  });

  it("two classless siblings with different insides: the one that accounts wins", () => {
    const template =
      '<div class="two"><div><h2>{{t}}</h2><p>{{p}}</p></div><div><ul class="x"><li>{{i}}</li></ul></div></div>';
    expect(free(template, render(template))).toEqual([]);
  });

  it("a section repeating a classed child still matches every iteration", () => {
    const template =
      '<div class="grid"><div><h2>{{title}}</h2></div>{{#cards}}<div class="card"><p>{{.}}</p></div>{{/cards}}</div>';
    const rendered = tagModuleId(
      '<div class="grid"><div><h2>T</h2></div><div class="card"><p>a</p></div><div class="card"><p>b</p></div></div>',
      "m1",
    );
    expect(free(template, rendered)).toEqual([]);
  });

  it("stays fast when many rendered children each fit several template children", () => {
    // Every rendered <div> fits all eight classless template <div>s, so the
    // best-fit choice weighs each candidate; the per-pair memo keeps that
    // linear in the rendered size.
    const template = `<div class="wide">${"<div><div><p>{{t}}</p></div></div>".repeat(8)}</div>`;
    const rendered = tagModuleId(
      `<div class="wide">${"<div><div><p>x</p><span>y</span></div></div>".repeat(5000)}</div>`,
      "m1",
    );
    const started = performance.now();
    expect(free(template, rendered)?.length).toBe(5000);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("markup pasted into a field value of such a template is still free (#820)", () => {
    const pasted = chain(["a", "b"]);
    const rendered = render(HERO_WINDOW).replace("<p>x</p>", `<p>x</p>${pasted}`);
    const regions = free(HERO_WINDOW, rendered) ?? [];
    expect(outermostPatterns(regions).map((f) => f.node.classes[0])).toEqual(["chain"]);
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

describe("repeatedSiblingPatterns (#1068)", () => {
  const card = '<article class="tc"><h3 class="n">x</h3><dl><dt>a</dt><dd>b</dd></dl></article>';

  it("finds 3+ sibling copies at any depth, once, and ignores pairs and prose", () => {
    const found = repeatedSiblingPatterns(
      parseMarkup(`<div class="grid">${card.repeat(4)}</div>${card.repeat(2)}`),
    );
    expect(found.map((f) => [f.node.tag, f.count])).toEqual([["article", 4]]);
    expect(repeatedSiblingPatterns(parseMarkup(card.repeat(2)))).toEqual([]);
    expect(repeatedSiblingPatterns(parseMarkup("<ul><li><p>a</p></li></ul>".repeat(5)))).toEqual(
      [],
    );
  });

  it("skips nested module roots: their own module owns them", () => {
    const tagged = card.replace("<article", '<article data-caelo-module-id="m"');
    expect(repeatedSiblingPatterns(parseMarkup(tagged.repeat(3)))).toEqual([]);
  });
});

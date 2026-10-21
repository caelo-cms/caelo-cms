// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { formatCssScopeFindings, moduleRootTokens, scanModuleCssScope } from "./css-scope-scan.js";

describe("scanModuleCssScope (issue #158)", () => {
  it("flags element-only selectors as global, at top level and inside @media", () => {
    const f = scanModuleCssScope({
      css: "h1 { color: red } .hero p, body { margin: 0 } @media (max-width: 600px) { a:hover { color: blue } }",
    });
    expect(f.global).toEqual(["h1", "body", "a:hover"]);
    // Without the html there is no root to anchor against.
    expect(f.unanchored).toEqual([]);
  });

  it("does not count a class inside a pseudo argument as scoping", () => {
    expect(scanModuleCssScope({ css: "h1:not(.x) { color: red }" }).global).toEqual(["h1:not(.x)"]);
  });

  it("checks selectors against the module root class when the html is known", () => {
    const f = scanModuleCssScope({
      html: '<section class="hero is-dark"><div class="card"></div></section>',
      css: ".hero h1{} .hero__title{} .hero-cta{} html.dark .hero{} .card{} .is-darkish{}",
    });
    expect(f.global).toEqual([]);
    expect(f.unanchored).toEqual([".card", ".is-darkish"]);
    expect(f.rootClasses).toEqual(["hero", "is-dark"]);
  });

  it("accepts the root id as an anchor", () => {
    const f = scanModuleCssScope({
      html: '<div id="pricing"></div>',
      css: "#pricing .row{} .row{}",
    });
    expect(f.unanchored).toEqual([".row"]);
    expect(f.rootHasNoClass).toBe(false);
  });

  it("skips blocks that hold no selectors, comments and strings", () => {
    const f = scanModuleCssScope({
      html: '<div class="m"></div>',
      css: '/* h1 {} */ @keyframes spin { from { opacity: 0 } to { opacity: 1 } } @font-face { font-family: X } @import url("x.css"); .m::after { content: "}{ h1 {" } .m { & h2 { color: red } }',
    });
    expect(f.global).toEqual([]);
    expect(f.unanchored).toEqual([]);
  });

  it("reports a root element with nothing to scope under", () => {
    const f = scanModuleCssScope({ html: "<section><h2>x</h2></section>", css: ".title{}" });
    expect(f.rootHasNoClass).toBe(true);
    expect(formatCssScopeFindings(f)).toContain("root element has no class");
  });

  it("formats nothing for scoped CSS", () => {
    expect(
      formatCssScopeFindings(
        scanModuleCssScope({ html: '<div class="faq"></div>', css: ".faq summary{}" }),
      ),
    ).toBeNull();
  });

  it("names the root class in the fix and truncates long lists", () => {
    const text = formatCssScopeFindings(
      scanModuleCssScope({
        html: '<nav class="site-nav"></nav>',
        css: "a{} b{} i{} p{} ul{} li{} em{}",
      }),
    );
    expect(text).toContain("`.site-nav h2`");
    expect(text).toContain("(+2 more)");
  });
});

describe("moduleRootTokens", () => {
  it("reads the first element past comments and ignores templated values", () => {
    expect(
      moduleRootTokens('<!-- hero --> <section class="hero {{variant}}" id="{{anchor}}">'),
    ).toEqual({ classes: ["hero"], id: null });
    expect(moduleRootTokens("just text")).toBeNull();
    expect(moduleRootTokens('<!-- a --><!----> \n<div class="card">')).toEqual({
      classes: ["card"],
      id: null,
    });
    expect(moduleRootTokens('<!-- never closed <div class="card">')).toBeNull();
  });

  it("stays linear on comment-heavy input (CodeQL js/redos)", () => {
    const started = performance.now();
    expect(moduleRootTokens(`<!--${"--><!--".repeat(50_000)}`)).toBeNull();
    expect(moduleRootTokens(`${"<!---->".repeat(50_000)}<p class="x">`)?.classes).toEqual(["x"]);
    expect(moduleRootTokens("<A\t".repeat(50_000))).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reads bare and attribute-carrying start tags, and rejects a malformed one", () => {
    expect(moduleRootTokens("<section>")).toEqual({ classes: [], id: null });
    expect(moduleRootTokens('<div\n  class="a b"\n  id="main">')).toEqual({
      classes: ["a", "b"],
      id: "main",
    });
    expect(moduleRootTokens('<div/class="a">')).toBeNull();
    expect(moduleRootTokens('<div class="a"')).toBeNull();
  });
});

describe("scanModuleCssScope comment stripping", () => {
  it("drops closed comments and treats an unterminated one as running to the end", () => {
    expect(scanModuleCssScope({ css: "/* h1 { x: 1 } */ p { color: red }" }).global).toEqual(["p"]);
    expect(scanModuleCssScope({ css: "p { color: red } /* h1 { x: 1 }" }).global).toEqual(["p"]);
  });

  it("stays linear on many unterminated comment openers (CodeQL js/polynomial-redos)", () => {
    const started = performance.now();
    scanModuleCssScope({ css: `/*${"a/*".repeat(100_000)}` });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

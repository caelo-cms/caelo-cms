// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { balanceTemplateCloses } from "./template-balance.js";

describe("balanceTemplateCloses", () => {
  it("leaves balanced nested templates untouched", () => {
    const html = "<div><template id=row><li>x</li></template></div>";
    expect(balanceTemplateCloses(html)).toBe(html);
  });

  it("neutralizes an unmatched </template> close", () => {
    expect(balanceTemplateCloses("<div></template><script>alert(1)</script></div>")).toBe(
      "<div>&lt;/template><script>alert(1)</script></div>",
    );
    expect(balanceTemplateCloses("<template></template></TEMPLATE >")).toBe(
      "<template></template>&lt;/TEMPLATE >",
    );
  });

  it("closes templates the fragment leaves open", () => {
    expect(balanceTemplateCloses("<template><p>x")).toBe("<template><p>x</template>");
  });

  it("does not count a <template spelled inside an attribute value", () => {
    expect(balanceTemplateCloses('<a title="<template>">x</a></template>')).toBe(
      '<a title="<template>">x</a>&lt;/template>',
    );
    expect(balanceTemplateCloses("<a title='>'<template>'>x</a></template>")).toBe(
      "<a title='>'<template>'>x</a>&lt;/template>",
    );
  });

  it("rewrites </template inside comments and raw-text elements too (fail-closed)", () => {
    // Where the walk calls something text, the browser may not agree, so
    // a `</template` there is rewritten to a form that still reads the same.
    const html =
      "<!-- </template> --><script>var s='</template>'</script><style>/*</template>*/</style><textarea></template></textarea>";
    expect(balanceTemplateCloses(html)).toBe(
      "<!-- &lt;/template> --><script>var s='<\\/template>'</script><style>/*<\\/template>*/</style><textarea>&lt;/template></textarea>",
    );
  });

  it("does not trust <style>/<script>/<title> as raw text inside SVG or MathML", () => {
    // In foreign content these are ordinary elements, so a </template in
    // them is a real end tag in the browser.
    for (const html of [
      "<svg><style></template><img src=x></style></svg>",
      "<svg><script></template><img src=x></script></svg>",
      "<math><style></template><img src=x></style></math>",
      "<svg><title></template><img src=x></title></svg>",
    ]) {
      expect(keptCloses(balanceTemplateCloses(html))).toBe(0);
    }
  });

  it("never counts a <template> inside SVG, which </svg> pops implicitly", () => {
    const out = balanceTemplateCloses("<svg><template></svg></template><img src=x>");
    expect(keptCloses(out)).toBe(0);
    expect(out).toBe("<svg><template></svg>&lt;/template><img src=x>");
  });

  it("ends abrupt comments (<!--> and <!--->) where the browser does", () => {
    expect(balanceTemplateCloses("<!--> </template><img src=x> -->")).toBe(
      "<!--> &lt;/template><img src=x> -->",
    );
    expect(balanceTemplateCloses("<!---> </template><img src=x> -->")).toBe(
      "<!---> &lt;/template><img src=x> -->",
    );
  });

  it("reads tag names with HTML whitespace only (U+00A0 is part of the name)", () => {
    // `<template\u00a0>` is not a template element in the browser, so the
    // close after it must not be kept as its match.
    const out = balanceTemplateCloses("<template\u00a0></template><img src=x>");
    expect(keptCloses(out)).toBe(0);
  });

  it("keeps offsets right when lowercasing would change the string length", () => {
    // "İ".toLowerCase() is two code units; the walk must not shift.
    const html = "<script>var s='İİ';</script><p>x</p></template>";
    expect(balanceTemplateCloses(html)).toBe("<script>var s='İİ';</script><p>x</p>&lt;/template>");
  });

  it("defuses <!-- in script text so the browser ends the script where the walk does", () => {
    expect(balanceTemplateCloses("<script>a<!--b</script>")).toBe("<script>a<\\!--b</script>");
  });

  it("keeps a lone < that starts no tag", () => {
    expect(balanceTemplateCloses("a < b </ c")).toBe("a < b </ c");
  });
});

/** How many `</template` end tags survive in `html`. */
function keptCloses(html: string): number {
  return (html.match(/<\/template/gi) ?? []).length;
}

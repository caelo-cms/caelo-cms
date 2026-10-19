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

  it("treats </template inside comments and raw-text elements as text", () => {
    const html =
      "<!-- </template> --><script>var s='</template>'</script><style>/*</template>*/</style><textarea></template></textarea>";
    expect(balanceTemplateCloses(html)).toBe(html);
  });

  it("keeps a lone < that starts no tag", () => {
    expect(balanceTemplateCloses("a < b </ c")).toBe("a < b </ c");
  });
});

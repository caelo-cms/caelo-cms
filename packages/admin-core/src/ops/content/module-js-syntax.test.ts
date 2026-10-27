// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { moduleJsSyntaxError } from "./module-js-syntax.js";

describe("moduleJsSyntaxError", () => {
  it("refuses the footer js of e2e-livedit run 40532297620 and names the escaped line breaks", () => {
    // Exactly what was stored: a literal backslash-n where each line break
    // belongs. The page's shared module <script> threw
    // `SyntaxError: Invalid or unexpected token` on it.
    const stored =
      "(function () {\\n  document.querySelectorAll('.site-footer__year').forEach(function (el) {\\n    el.textContent = new Date().getFullYear();\\n  });\\n})();";
    const message = moduleJsSyntaxError(stored);
    expect(message).not.toBeNull();
    expect(message).toContain("line 1, column 16");
    expect(message).toContain("real line breaks");
    expect(message).toContain("shared <script>");
  });

  it("refuses what a classic script cannot run, with the position", () => {
    expect(moduleJsSyntaxError("(function () {\n  const x = ;\n})();")).toContain(
      "line 2, column 13",
    );
    expect(moduleJsSyntaxError("import x from 'y';")).not.toBeNull();
    expect(moduleJsSyntaxError("await fetch('/x');")).not.toBeNull();
    expect(moduleJsSyntaxError("return 1;")).not.toBeNull();
  });

  it("accepts valid js, including strings and regexes holding a backslash-n", () => {
    expect(moduleJsSyntaxError("")).toBeNull();
    expect(moduleJsSyntaxError("   \n")).toBeNull();
    expect(
      moduleJsSyntaxError(
        "(function () {\n  const t = `a`.split('\\n');\n  /x\\n/.test(t[0]);\n})();",
      ),
    ).toBeNull();
    expect(moduleJsSyntaxError("var t=a.join('\\n');console.log(t)")).toBeNull();
  });
});

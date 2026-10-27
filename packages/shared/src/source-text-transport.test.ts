// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { addModuleToolInput, createTemplateToolInput } from "./ai-tools.js";
import { decodeEscapedLineBreaks } from "./escaped-line-breaks.js";
import {
  decodeHtmlEscapedSource,
  decodeJsonEncodedSource,
  decodeSourceTextTransport,
} from "./source-text-transport.js";

const markup = '<main class="simple-page-main"><caelo-slot name="content"></caelo-slot></main>';

describe("decodeHtmlEscapedSource", () => {
  it("decodes markup escaped as a whole (e2e-livedit run 40344374447)", () => {
    const sent =
      '&lt;main class="simple-page-main"&gt;&lt;caelo-slot name="content"&gt;&lt;/caelo-slot&gt;&lt;/main&gt;';
    expect(decodeHtmlEscapedSource(sent)).toBe(markup);
    expect(
      decodeHtmlEscapedSource("&lt;p class=&quot;x&quot;&gt;Tom &amp;amp; Jerry&lt;/p&gt;"),
    ).toBe('<p class="x">Tom &amp; Jerry</p>');
  });

  it("leaves real markup and text that only mentions an entity untouched", () => {
    const withEntity = "<p>Use &lt;div&gt; for blocks</p>";
    expect(decodeHtmlEscapedSource(withEntity)).toBe(withEntity);
    expect(decodeHtmlEscapedSource("a &lt; b")).toBe("a &lt; b");
    expect(decodeHtmlEscapedSource(".a > .b { color: red }")).toBe(".a > .b { color: red }");
  });
});

describe("decodeJsonEncodedSource", () => {
  it("decodes a whole-value JSON string literal with escapes", () => {
    expect(decodeJsonEncodedSource(JSON.stringify(markup))).toBe(markup);
    expect(decodeJsonEncodedSource('".a {\\n  color: red;\\n}"')).toBe(".a {\n  color: red;\n}");
  });

  it("leaves a literal without escapes and non-literals untouched", () => {
    expect(decodeJsonEncodedSource('"use strict"')).toBe('"use strict"');
    expect(decodeJsonEncodedSource(markup)).toBe(markup);
    expect(decodeJsonEncodedSource('"broken \\" literal')).toBe('"broken \\" literal');
  });
});

describe("decodeSourceTextTransport", () => {
  it("unwraps CDATA, then a JSON literal, then HTML escaping", () => {
    expect(decodeSourceTextTransport(`<![CDATA[${markup}]]>`, "html")).toBe(markup);
    expect(
      decodeSourceTextTransport(
        JSON.stringify(markup.replaceAll("<", "&lt;").replaceAll(">", "&gt;")),
        "html",
      ),
    ).toBe(markup);
    expect(decodeSourceTextTransport(42, "html")).toBe(42);
  });

  it("is what create_template's html argument goes through", () => {
    const r = createTemplateToolInput.parse({
      slug: "page-template",
      displayName: "Simple Page",
      html: markup.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    });
    expect(r.html).toBe(markup);
  });
});

// e2e-livedit run 40532297620 (release gate v0.11.1): add_module's html, css
// and js arrived with every line break as the two characters `\` `n`. The
// stored footer showed literal `\n` text and the shared module <script>
// threw `SyntaxError: Invalid or unexpected token` on every preview. These
// are the exact values the AI sent.
describe("decodeEscapedLineBreaks", () => {
  const sentJs =
    "(function () {\\n  document.querySelectorAll('.site-footer__year').forEach(function (el) {\\n    el.textContent = new Date().getFullYear();\\n  });\\n})();";
  const sentCss =
    ".site-footer {\\n  padding: 2rem 1.5rem;\\n  text-align: center;\\n}\\n.site-footer__link:hover {\\n  text-decoration: underline;\\n}";
  const sentHtml =
    '<footer class="site-footer">\\n  <nav class="site-footer__nav" aria-label="Footer">\\n    <ul class="site-footer__list">\\n      {{#nav}}\\n      <li class="site-footer__item"><a class="site-footer__link" href="{{link.href}}">{{label}}</a></li>\\n      {{/nav}}\\n    </ul>\\n  </nav>\\n</footer>';

  it("turns escaped line breaks back into real ones (the run's exact values)", () => {
    expect(decodeEscapedLineBreaks(sentJs, "js")).toBe(
      "(function () {\n  document.querySelectorAll('.site-footer__year').forEach(function (el) {\n    el.textContent = new Date().getFullYear();\n  });\n})();",
    );
    expect(decodeEscapedLineBreaks(sentCss, "css")).toBe(
      ".site-footer {\n  padding: 2rem 1.5rem;\n  text-align: center;\n}\n.site-footer__link:hover {\n  text-decoration: underline;\n}",
    );
    const html = decodeEscapedLineBreaks(sentHtml, "html") as string;
    expect(html).not.toContain("\\n");
    expect(html.split("\n")).toHaveLength(9);
    expect(html).toContain('<footer class="site-footer">\n  <nav');
  });

  it("decodes escaped CRLF and escaped tab indentation", () => {
    expect(decodeEscapedLineBreaks(".a {\\r\\n\\tcolor: red;\\r\\n\\t\\tx: y;\\r\\n}", "css")).toBe(
      ".a {\n\tcolor: red;\n\t\tx: y;\n}",
    );
  });

  it("leaves source with real line breaks, single-line code and escaped backslashes alone", () => {
    const multiLine = "const s = 'a\\n  b';\nconsole.log(s.split('\\n  '));";
    expect(decodeEscapedLineBreaks(multiLine, "js")).toBe(multiLine);
    const minified = "var t=a.join('\\n');console.log(t.split('\\n'))";
    expect(decodeEscapedLineBreaks(minified, "js")).toBe(minified);
    const oneHit = "el.textContent = lines.join('\\n  ');";
    expect(decodeEscapedLineBreaks(oneHit, "js")).toBe(oneHit);
    const escapedBackslash = "a('\\\\n  x'); b('\\\\n  y');";
    expect(decodeEscapedLineBreaks(escapedBackslash, "js")).toBe(escapedBackslash);
    expect(decodeEscapedLineBreaks(7, "js")).toBe(7);
  });

  // PR #1189 review: an escape inside a literal is meaningful, so a value
  // holding one is ambiguous and left exactly as sent — decoding it would
  // turn valid source into broken source.
  it("leaves values alone when an escaped line break sits inside a literal", () => {
    const jsString = 'document.querySelector("pre").textContent = "Title\\n  Detail\\n  More";';
    expect(decodeEscapedLineBreaks(jsString, "js")).toBe(jsString);
    const jsTemplate = "(function () {\\n  el.title = `a\\n  b`;\\n})();";
    expect(decodeEscapedLineBreaks(jsTemplate, "js")).toBe(jsTemplate);
    const jsRegex = "(function () {\\n  var ok = /a\\n  b/.test(x);\\n})();";
    expect(decodeEscapedLineBreaks(jsRegex, "js")).toBe(jsRegex);
    const cssContent = '.a::after {\\n  content: "x\\n  y";\\n}';
    expect(decodeEscapedLineBreaks(cssContent, "css")).toBe(cssContent);
    const htmlAttr = '<div>\\n  <span title="a\\n  b">x</span>\\n</div>';
    expect(decodeEscapedLineBreaks(htmlAttr, "html")).toBe(htmlAttr);
    const htmlPre = '<div>\\n  <pre>printf("a\\n");</pre>\\n</div>';
    expect(decodeEscapedLineBreaks(htmlPre, "html")).toBe(htmlPre);
  });

  it("decodes structural escapes around literals and comments that hold none", () => {
    expect(
      decodeEscapedLineBreaks(
        "// it's the footer\\n(function () {\\n  var s = 'a\\\\n';\\n  /x/.test(s);\\n})();",
        "js",
      ),
    ).toBe("// it's the footer\n(function () {\n  var s = 'a\\\\n';\n  /x/.test(s);\n})();");
    expect(
      decodeEscapedLineBreaks('<p>It\'s ours</p>\\n<p>\\n  <a href="/">Home</a>\\n</p>', "html"),
    ).toBe('<p>It\'s ours</p>\n<p>\n  <a href="/">Home</a>\n</p>');
  });

  it("is what add_module's html / css / js arguments go through", () => {
    const r = addModuleToolInput.parse({
      target: "layout",
      targetRef: "site-default",
      blockName: "footer",
      position: "bottom",
      displayName: "Site Footer",
      html: sentHtml,
      css: sentCss,
      js: sentJs,
    });
    for (const v of [r.html, r.css, r.js]) {
      expect(v).toBeString();
      expect(v).not.toContain("\\n");
      expect(v).toContain("\n");
    }
  });
});

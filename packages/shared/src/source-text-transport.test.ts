// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { createTemplateToolInput } from "./ai-tools.js";
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
    expect(decodeSourceTextTransport(`<![CDATA[${markup}]]>`)).toBe(markup);
    expect(
      decodeSourceTextTransport(
        JSON.stringify(markup.replaceAll("<", "&lt;").replaceAll(">", "&gt;")),
      ),
    ).toBe(markup);
    expect(decodeSourceTextTransport(42)).toBe(42);
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

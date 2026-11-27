// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the §4.5 value checks (plugin-values.ts), adversarial: markup,
 * event handlers and script URLs in every field kind a plugin can answer.
 */

import { describe, expect, it } from "bun:test";
import { escapeUnquotedPluginText, type FieldDef } from "@caelo-cms/shared";
import { Parser } from "htmlparser2";
import {
  checkPluginMedia,
  checkPluginValue,
  escapePluginText,
  richtextProblem,
  urlProblem,
} from "./plugin-values.js";

const field = (type: string, extra: object = {}): FieldDef =>
  ({ name: "f", label: "F", type, ...extra }) as FieldDef;

describe("text, select and icon stay data, escaped where they land", () => {
  it("keeps the raw text: the engine escapes it by its placeholder's context", () => {
    for (const type of ["text", "select", "icon"]) {
      // "JavaScript: Grundlagen" is a title, not a link: only a URL attribute refuses it.
      for (const value of ['<img src=x onerror="alert(1)">', "JavaScript: Grundlagen"]) {
        expect(checkPluginValue(field(type, { options: ["a"] }), value)).toEqual({
          ok: true,
          value,
        });
      }
    }
    expect(escapePluginText(`Tom & 'Jerry' "x" <y>`)).toBe(
      "Tom &amp; &#39;Jerry&#39; &quot;x&quot; &lt;y&gt;",
    );
  });

  it("escapes an unquoted attribute value into one value with no attribute after it", () => {
    // `<div title={{label}}>`: whitespace would end the value, `=` start another.
    const html = `<div title=${escapeUnquotedPluginText("x onmouseover=alert(1) y=`z`")}>`;
    const attributes: Record<string, string> = {};
    new Parser({
      onattribute: (name, value) => {
        attributes[name] = value;
      },
    }).end(html);
    expect(attributes).toEqual({ title: "x onmouseover=alert(1) y=`z`" });
    expect(escapeUnquotedPluginText("")).toBe('""');
  });
});

describe("links keep to the allowed schemes", () => {
  it("passes https, http, mailto, tel, relative URLs and page references", () => {
    for (const ok of [
      "https://example.com/a?b=1&c=2",
      "http://example.com",
      "mailto:a@example.com",
      "tel:+491234",
      "/de/hilfe",
      "#top",
      "caelo:page/00000000-0000-4000-8000-000000000001",
    ]) {
      expect(urlProblem(ok)).toBeNull();
    }
  });

  it("refuses script URLs however they are spelled, protocol-relative and attribute breakouts", () => {
    expect(urlProblem("javascript:alert(1)")).toBe("url-scheme");
    expect(urlProblem("JaVaScRiPt:alert(1)")).toBe("url-scheme");
    expect(urlProblem("data:text/html,<script>")).toBe("url-characters");
    expect(urlProblem("data:text/html;base64,PHNjcmlwdD4=")).toBe("url-scheme");
    expect(urlProblem(" javascript:alert(1)")).toBe("url-characters");
    expect(urlProblem("java\tscript:alert(1)")).toBe("url-characters");
    expect(urlProblem("//evil.example/x")).toBe("url-protocol-relative");
    expect(urlProblem('https://x.example/"onmouseover=alert(1)')).toBe("url-characters");
    expect(checkPluginValue(field("link"), { href: "javascript:alert(1)" })).toEqual({
      ok: false,
      rule: "url-scheme",
    });
  });

  it("refuses a script URL spelled with character references, as the browser decodes them in the attribute", () => {
    for (const spelled of [
      "javascript&#58;alert(1)",
      "javascript&#58alert(1)",
      "javascript&#x3A;alert(1)",
      "javascript&#0000058;alert(1)",
      "javascript&colon;alert(1)",
      "&#106;avascript:alert(1)",
    ]) {
      expect(urlProblem(spelled)).toBe("url-scheme");
      expect(checkPluginValue(field("link"), spelled)).toEqual({ ok: false, rule: "url-scheme" });
    }
    expect(urlProblem("java&#9;script:alert(1)")).toBe("url-characters");
    expect(urlProblem("java&Tab;script:alert(1)")).toBe("url-characters");
    expect(urlProblem("&#47;/evil.example/x")).toBe("url-protocol-relative");
    // A query keeps its ampersands; `&copy=` is no reference inside an attribute.
    expect(urlProblem("/a?x=1&amp;y=2")).toBeNull();
    expect(urlProblem("/a?x=1&copy=2")).toBeNull();
  });
});

describe("richtext is prose, refused (never cleaned) otherwise", () => {
  it("passes the prose allowlist", () => {
    expect(
      richtextProblem(
        '<h2>Title</h2><p>A <strong>b</strong> <em>c</em> <a href="https://x.example" class="l">d</a><br><code>e</code></p><ul><li>f</li></ul><blockquote><span>g</span></blockquote>',
      ),
    ).toBeNull();
  });

  it("names the first element, attribute or URL it refuses", () => {
    expect(richtextProblem("<p>x</p><script>alert(1)</script>")).toBe("element-script");
    expect(richtextProblem('<img src="x" onerror="alert(1)">')).toBe("element-img");
    expect(richtextProblem('<p onclick="alert(1)">x</p>')).toBe("attribute-onclick");
    expect(richtextProblem('<span style="background:url(x)">x</span>')).toBe("attribute-style");
    expect(richtextProblem('<a href="jav&#97;script:alert(1)">x</a>')).toBe("url-scheme");
    expect(richtextProblem('<blockquote cite="//evil.example">x</blockquote>')).toBe(
      "url-protocol-relative",
    );
    expect(richtextProblem("<h1>x</h1>")).toBe("element-h1");
    expect(richtextProblem('<iframe src="https://x.example"></iframe>')).toBe("element-iframe");
    expect(richtextProblem("<svg><script>alert(1)</script></svg>")).toBe("element-svg");
    expect(checkPluginValue(field("richtext"), "<p>ok</p><style>*{}</style>")).toEqual({
      ok: false,
      rule: "element-style",
    });
  });
});

describe("media is a library image", () => {
  const facts = new Map([
    ["00000000-0000-4000-8000-000000000001", { visibility: "library" as const, mime: "image/png" }],
    [
      "00000000-0000-4000-8000-000000000002",
      { visibility: "reference" as const, mime: "image/png" },
    ],
    [
      "00000000-0000-4000-8000-000000000003",
      { visibility: "library" as const, mime: "application/pdf" },
    ],
  ]);
  it("refuses a missing asset, a reference image and a file that is no image", () => {
    expect(checkPluginMedia("caelo:media/00000000-0000-4000-8000-000000000001", facts)).toBeNull();
    expect(checkPluginMedia("caelo:media/00000000-0000-4000-8000-000000000002", facts)).toBe(
      "media-reference",
    );
    expect(checkPluginMedia("caelo:media/00000000-0000-4000-8000-000000000003", facts)).toBe(
      "media-not-image",
    );
    expect(checkPluginMedia("caelo:media/00000000-0000-4000-8000-000000000009", facts)).toBe(
      "media-missing",
    );
  });
});

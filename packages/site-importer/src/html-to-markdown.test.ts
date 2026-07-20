// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { htmlToMarkdown } from "./html-to-markdown.js";

describe("htmlToMarkdown", () => {
  it("converts headings + paragraphs", () => {
    const md = htmlToMarkdown("<h1>Title</h1><p>Hello world.</p><h2>Sub</h2><p>More.</p>");
    expect(md).toBe("# Title\n\nHello world.\n\n## Sub\n\nMore.");
  });

  it("converts links to [text](href)", () => {
    const md = htmlToMarkdown('<p>See <a href="/docs">the docs</a> now.</p>');
    expect(md).toContain("[the docs](/docs)");
  });

  it("keeps inline formatting inside a link", () => {
    const md = htmlToMarkdown('<a href="/x"><strong>Bold</strong> link</a>');
    expect(md).toContain("[**Bold** link](/x)");
  });

  it("converts unordered + ordered lists with nesting", () => {
    const md = htmlToMarkdown("<ul><li>a</li><li>b</li></ul>");
    expect(md).toContain("- a");
    expect(md).toContain("- b");
    const ol = htmlToMarkdown("<ol><li>first</li><li>second</li></ol>");
    expect(ol).toContain("1. first");
    expect(ol).toContain("2. second");
  });

  it("converts images to ![alt](src)", () => {
    const md = htmlToMarkdown('<img src="/logo.png" alt="Acme logo">');
    expect(md).toBe("![Acme logo](/logo.png)");
  });

  it("emphasis: strong→** and em→*", () => {
    expect(htmlToMarkdown("<p><strong>bold</strong> <em>italic</em></p>")).toContain(
      "**bold** *italic*",
    );
  });

  it("DROPS script/style/svg subtrees entirely", () => {
    const md = htmlToMarkdown(
      "<p>Visible</p><script>var secret=1;</script><style>.a{color:red}</style><svg><text>icon</text></svg>",
    );
    expect(md).toBe("Visible");
    expect(md).not.toContain("secret");
    expect(md).not.toContain("color:red");
    expect(md).not.toContain("icon");
  });

  it("collapses whitespace runs and blank lines", () => {
    const md = htmlToMarkdown("<p>a   \n   b</p>\n\n\n<p>c</p>");
    expect(md).toBe("a b\n\nc");
  });

  it("preserves <pre> content verbatim in a fence", () => {
    const md = htmlToMarkdown("<pre>line1\n  line2</pre>");
    expect(md).toContain("```\nline1\n  line2\n```");
  });

  it("does not throw on malformed / unclosed HTML", () => {
    expect(() => htmlToMarkdown("<div><p>oops<ul><li>x</div>")).not.toThrow();
  });

  it("decodes entities", () => {
    expect(htmlToMarkdown("<p>Caf&eacute; &amp; bar</p>")).toBe("Café & bar");
  });
});

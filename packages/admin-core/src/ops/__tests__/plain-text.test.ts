// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { capPlainText, htmlToPlainText } from "../content/plain-text.js";

describe("htmlToPlainText", () => {
  it("keeps headings, paragraphs, list items and link labels, one line per block", () => {
    const html =
      "<section><h1>Fast &amp; fair</h1><p>Pay  for\n what <a href='/pricing'>you use</a>.</p>" +
      "<ul><li>One</li><li><strong>Two</strong></li></ul></section>";
    expect(htmlToPlainText(html)).toBe("Fast & fair\nPay for what you use.\nOne\nTwo");
  });

  it("skips scripts, styles, templates, svg and comments", () => {
    const html =
      "<style>.a{}</style><script>var x = '<p>no</p>';</script><!-- note -->" +
      "<template><p>hidden</p></template><svg><path d='M0'/><text>logo</text></svg><p>Shown</p>";
    expect(htmlToPlainText(html)).toBe("Shown");
  });

  it("returns an empty string for markup without text", () => {
    expect(htmlToPlainText("<div><img src='/a.png' alt='x'></div>")).toBe("");
  });
});

describe("capPlainText", () => {
  it("leaves text that fits untouched", () => {
    expect(capPlainText("short text", 50)).toEqual({ text: "short text", truncated: false });
  });

  it("cuts at a word boundary and marks the cut", () => {
    const r = capPlainText("alpha beta gamma delta", 14);
    expect(r).toEqual({ text: "alpha beta…", truncated: true });
    expect(r.text.length).toBeLessThanOrEqual(14);
  });

  it("never splits a URL or an id", () => {
    const id = "c9c7ddcb-cc85-4747-84f0-90967da6f769";
    const r = capPlainText(`see https://example.com/a/very/long/path ${id} end`, 60);
    expect(r.truncated).toBe(true);
    expect(r.text).not.toContain("c9c7ddcb-cc85");
    expect(r.text).toBe("see https://example.com/a/very/long/path…");
  });

  it("keeps an unbroken run free of a half id", () => {
    const id = "c9c7ddcb-cc85-4747-84f0-90967da6f769";
    const r = capPlainText(`${"x".repeat(10)}${id}`, 30);
    expect(r).toEqual({ text: `${"x".repeat(10)}…`, truncated: true });
  });
});

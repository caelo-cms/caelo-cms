// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { defaultPlaceholder, editorNotice } from "./placeholder.js";

describe("defaultPlaceholder", () => {
  it("offers a one-category grant for a known category", () => {
    const { html } = defaultPlaceholder("marketing", "Marketing");
    expect(html).toContain('data-consent-grant="marketing"');
    expect(html).toContain("Marketing");
  });

  it("escapes the operator's category label", () => {
    expect(defaultPlaceholder("marketing", '<img src=x onerror="a()">').html).not.toContain("<img");
  });
});

describe("editorNotice", () => {
  it("names every host the module loads from and offers the chat", () => {
    const { html } = editorNotice(["cdn.example.com", "fonts.example.net"]);
    expect(html).toContain("<code>cdn.example.com</code>, <code>fonts.example.net</code>");
    expect(html).toContain("Hidden from visitors");
    expect(html).toContain("data-caelo-ask-ai");
    // Nothing a visitor could press: the notice never reaches one, and
    // a grant for an unclassified vendor would be a dead end anyway.
    expect(html).not.toContain("data-consent-grant");
  });

  it("escapes host names", () => {
    expect(editorNotice(['x"><script>a()</script>']).html).not.toContain("<script>");
  });
});

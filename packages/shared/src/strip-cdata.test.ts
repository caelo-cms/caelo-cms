// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { stripCdataGuards, unwrapCdataEnvelope } from "./strip-cdata.js";

describe("stripCdataGuards", () => {
  it("leaves clean HTML untouched (fast path)", () => {
    const html = '<nav><a href="/docs">Docs</a></nav>';
    expect(stripCdataGuards(html)).toBe(html);
  });

  it("removes a bare `<![CDATA[` / `]]>` pair, preserving inner content", () => {
    const html = "<style><![CDATA[.a{color:red}]]></style>";
    expect(stripCdataGuards(html)).toBe("<style>.a{color:red}</style>");
  });

  it("removes the stray `]]>` that leaks into chrome slots (the bug signature)", () => {
    const html = "<header>Site name]]></header>";
    expect(stripCdataGuards(html)).toBe("<header>Site name</header>");
  });

  it("unwraps the block-comment guard form", () => {
    const html = "<script>/*<![CDATA[*/ doStuff(); /*]]>*/</script>";
    expect(stripCdataGuards(html)).toBe("<script> doStuff(); </script>");
  });

  it("unwraps the line-comment guard form", () => {
    const html = "<script>\n//<![CDATA[\n  doStuff();\n//]]>\n</script>";
    expect(stripCdataGuards(html)).toBe("<script>\n\n  doStuff();\n\n</script>");
  });

  it("handles multiple guards in one document", () => {
    const html = "<style><![CDATA[.a{}]]></style><script>//<![CDATA[\nx()\n//]]>\n</script>";
    expect(stripCdataGuards(html)).toBe("<style>.a{}</style><script>\nx()\n\n</script>");
  });

  it("does not touch a legitimate `CDATA` substring in text", () => {
    const html = "<p>The CDATA section in XML is explained here.</p>";
    expect(stripCdataGuards(html)).toBe(html);
  });
});

describe("unwrapCdataEnvelope", () => {
  // Shape of the add_module css the real-AI suite filed (run 39936064709).
  const css =
    ".consent-banner {\n  position: fixed;\n}\n@media (max-width: 640px) {\n  .x { width: 100%; }\n}";

  it("decodes a whole-value envelope to its exact body", () => {
    expect(unwrapCdataEnvelope(`<![CDATA[${css}]]>`)).toBe(css);
    expect(unwrapCdataEnvelope(`\n  <![CDATA[${css}]]>\n`)).toBe(css);
  });

  it("leaves values without an enclosing envelope untouched", () => {
    expect(unwrapCdataEnvelope(css)).toBe(css);
    const guarded = `/*<![CDATA[*/ ${css} /*]]>*/`;
    expect(unwrapCdataEnvelope(guarded)).toBe(guarded);
    const midValue = `.a{} <![CDATA[ .b{} ]]>`;
    expect(unwrapCdataEnvelope(midValue)).toBe(midValue);
  });

  it("does not decode two CDATA sections as one envelope", () => {
    const two = "<![CDATA[.a{}]]> <![CDATA[.b{}]]>";
    expect(unwrapCdataEnvelope(two)).toBe(two);
  });

  it("passes non-strings through for the schema to judge", () => {
    expect(unwrapCdataEnvelope(undefined)).toBeUndefined();
    expect(unwrapCdataEnvelope(42)).toBe(42);
  });
});

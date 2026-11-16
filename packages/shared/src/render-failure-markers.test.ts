// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  isCaeloFaultMarker,
  renderFailureKind,
  renderFailureMarker,
} from "./render-failure-markers.js";

describe("render failure markers (#1604)", () => {
  it("reads the content markers as content", () => {
    for (const m of [
      "field-path-unknown:signin_link.label",
      "field-value-empty:cta.href",
      "field-value-malformed:cta",
      "module-missing:abc",
      "list-malformed:nav[0]",
      "link-target-missing:page/00000000-0000-4000-8000-000000000001",
      "link-ref-malformed:caelo:pge/x",
      "<!-- caelo:missing reason=module-missing:abc -->",
    ]) {
      expect(isCaeloFaultMarker(m)).toBe(false);
    }
  });

  it("reads a render without its context as Caelo's fault", () => {
    for (const m of [
      "link-resolver-unavailable:page/00000000-0000-4000-8000-000000000001",
      "nested-renderer-unavailable:cards[0]",
      "list-context-unavailable:page",
      "<!-- caelo:missing reason=list-context-unavailable:nav -->",
      "<!-- caelo:module hero needs recursive renderer (compose path) -->",
    ]) {
      expect(isCaeloFaultMarker(m)).toBe(true);
    }
  });

  it("names the marker inside a backstop comment", () => {
    expect(renderFailureMarker("<!-- caelo:missing reason=module-missing:abc -->")).toBe(
      "module-missing:abc",
    );
    expect(renderFailureMarker("field-path-unknown:x.label")).toBe("field-path-unknown:x.label");
  });

  it("files a failure under its marker's prefix", () => {
    expect(renderFailureKind("field-path-unknown:cards.card_link.label")).toBe(
      "field-path-unknown",
    );
    expect(renderFailureKind("<!-- caelo:missing reason=depth-limit:hero -->")).toBe("depth-limit");
    expect(renderFailureKind("<!-- caelo:module x needs recursive renderer -->")).toBe(
      "unrenderable",
    );
  });
});

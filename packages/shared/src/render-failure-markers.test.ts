// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  isCaeloFaultMarker,
  MEDIA_MISSING,
  MEDIA_VARIANT_MISSING,
  mediaFailureMarker,
  parseMediaFailureMarker,
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

describe("media failure markers (#1600)", () => {
  it("round-trips a missing variant and a missing image, and reads both as content", () => {
    const variant = mediaFailureMarker({
      ref: "url-history",
      variant: "webp-800",
      variants: ["orig", "webp-400"],
    });
    expect(variant).toBe("media-variant-missing:url-history/webp-800:orig,webp-400");
    expect(parseMediaFailureMarker(variant)).toEqual({
      ref: "url-history",
      variant: "webp-800",
      variants: ["orig", "webp-400"],
    });
    const gone = mediaFailureMarker({ ref: "old-logo", variant: "orig", variants: null });
    expect(gone).toBe("media-missing:old-logo/orig");
    expect(parseMediaFailureMarker(gone)).toEqual({
      ref: "old-logo",
      variant: "orig",
      variants: null,
    });
    for (const m of [variant, gone]) {
      expect(isCaeloFaultMarker(m)).toBe(false);
    }
    expect(renderFailureKind(variant)).toBe(MEDIA_VARIANT_MISSING);
    expect(renderFailureKind(gone)).toBe(MEDIA_MISSING);
  });

  it("parses no other marker", () => {
    for (const m of [
      "module-missing:abc",
      "media-missing:old-logo/orig:orig",
      "media-variant-missing:Hero/webp-800:orig",
      "media-variant-missing:hero",
    ]) {
      expect(parseMediaFailureMarker(m)).toBeNull();
    }
  });
});

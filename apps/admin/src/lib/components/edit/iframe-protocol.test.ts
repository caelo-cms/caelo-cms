// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type FieldEditMessage,
  type ImageReplaceMessage,
  newPreviewChannel,
  postToPreview,
  previewMessage,
  previewNavigationTarget,
  previewUrl,
  samePreviewDocument,
} from "./iframe-protocol.js";

const EDITOR = "https://admin.example.com";
const CHANNEL = "6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7";
// Stand-ins for window objects: the check is identity, not shape.
const preview = {} as Window;
const otherFrame = {} as Window;
const fieldEdit: FieldEditMessage = {
  kind: "caelo:field-edit",
  pageId: "p",
  blockName: "content",
  position: 0,
  edits: [{ field: "hero_title", text: "Hello" }],
};
const imageReplace: ImageReplaceMessage = {
  kind: "caelo:image-replace",
  pageId: "p",
  blockName: "content",
  position: 0,
  src: { field: "hero_image", text: "" },
};
/** What the sandboxed preview posts: opaque origin, our channel. */
const fromPreview = (data: object, over: { origin?: string; source?: Window | null } = {}) => ({
  source: over.source === undefined ? preview : over.source,
  origin: over.origin ?? "null",
  data: { ...data, channel: CHANNEL },
});

describe("previewMessage (#946 — opaque-origin preview)", () => {
  it("accepts a Caelo message from the sandboxed preview on this editor's channel", () => {
    // The channel is checked and dropped: the chip / save path never sees it.
    expect(previewMessage(fromPreview(fieldEdit), preview, CHANNEL)).toEqual(fieldEdit);
    expect(previewMessage(fromPreview(imageReplace), preview, CHANNEL)).toEqual(imageReplace);
    expect(
      previewMessage(
        fromPreview({ kind: "caelo:navigate", href: "/edit/preview-by-path/a" }),
        preview,
        CHANNEL,
      ),
    ).toEqual({ kind: "caelo:navigate", href: "/edit/preview-by-path/a" });
  });

  it("rejects a message without, or on another, channel", () => {
    // An external page the preview navigated to IS the iframe's window and
    // is opaque too — it just does not know the channel. It must not be able
    // to trigger a save with the operator's CSRF token.
    expect(
      previewMessage({ source: preview, origin: "null", data: fieldEdit }, preview, CHANNEL),
    ).toBeNull();
    expect(
      previewMessage(
        { source: preview, origin: "null", data: { ...fieldEdit, channel: newPreviewChannel() } },
        preview,
        CHANNEL,
      ),
    ).toBeNull();
  });

  it("rejects any origin but the opaque one — the admin's own included", () => {
    // A same-origin sender would mean the preview is NOT sandboxed; a
    // foreign origin is not the preview at all.
    for (const origin of [EDITOR, "https://evil.example"]) {
      expect(previewMessage(fromPreview(fieldEdit, { origin }), preview, CHANNEL)).toBeNull();
    }
  });

  it("rejects other windows, a missing preview and malformed data", () => {
    expect(
      previewMessage(fromPreview(fieldEdit, { source: otherFrame }), preview, CHANNEL),
    ).toBeNull();
    expect(previewMessage(fromPreview(fieldEdit, { source: null }), null, CHANNEL)).toBeNull();
    expect(previewMessage(fromPreview({ kind: "other" }), preview, CHANNEL)).toBeNull();
    // Shape is validated, not just the kind.
    expect(previewMessage(fromPreview({ ...fieldEdit, edits: [] }), preview, CHANNEL)).toBeNull();
    expect(
      previewMessage(fromPreview({ ...fieldEdit, position: -1 }), preview, CHANNEL),
    ).toBeNull();
    expect(
      previewMessage(
        fromPreview({ kind: "caelo:element-referenced", moduleId: "m", selector: "h1", label: "" }),
        preview,
        CHANNEL,
      ),
    ).toBeNull();
  });

  it("strips keys the schema does not name", () => {
    const msg = previewMessage(
      fromPreview({
        kind: "caelo:element-referenced",
        moduleId: "m",
        selector: "h1",
        label: "H",
        extra: 1,
      }),
      preview,
      CHANNEL,
    );
    expect(msg).toEqual({
      kind: "caelo:element-referenced",
      moduleId: "m",
      selector: "h1",
      label: "H",
    });
  });
});

describe("previewNavigationTarget (#946)", () => {
  it("loads another preview page with the editor's own channel", () => {
    expect(
      previewNavigationTarget("/edit/preview-by-path/pricing/?branch=b1", CHANNEL, EDITOR),
    ).toBe(`/edit/preview-by-path/pricing/?branch=b1&channel=${CHANNEL}`);
    expect(previewNavigationTarget("/edit/preview-by-path?branch=b1#top", CHANNEL, EDITOR)).toBe(
      `/edit/preview-by-path?branch=b1&channel=${CHANNEL}#top`,
    );
    // A channel in the request is replaced, never trusted.
    expect(
      previewNavigationTarget(
        "/edit/preview/p1?channel=00000000-0000-4000-8000-000000000000",
        CHANNEL,
        EDITOR,
      ),
    ).toBe(`/edit/preview/p1?channel=${CHANNEL}`);
  });

  it("refuses anything that is not a preview page of this admin", () => {
    for (const href of [
      "/settings/users",
      "/edit",
      "/edit/preview-by-pathX/a",
      "/edit/preview-by-path/../../settings",
      "/edit/preview-by-path/%2e%2e/%2e%2e/settings",
      "//evil.example/edit/preview-by-path/a",
      "https://evil.example/edit/preview-by-path/a",
      "/\\evil.example/edit/preview-by-path/a",
      "javascript:alert(1)",
      "edit/preview-by-path/a",
    ]) {
      expect(previewNavigationTarget(href, CHANNEL, EDITOR)).toBeNull();
    }
  });
});

describe("previewUrl / postToPreview / channel", () => {
  it("builds the preview URL the editor frames, channel last", () => {
    expect(previewUrl("/", { channel: CHANNEL, branch: "b1" })).toBe(
      `/edit/preview-by-path?branch=b1&channel=${CHANNEL}`,
    );
    expect(previewUrl("/de/preise", { channel: CHANNEL })).toBe(
      `/edit/preview-by-path/de/preise?channel=${CHANNEL}`,
    );
    // Round-trips through the navigation check unchanged, so a navigated
    // preview and the editor's own src agree (no second load).
    const src = previewUrl("/about", { channel: CHANNEL, branch: "b1" });
    expect(previewNavigationTarget(src, CHANNEL, EDITOR)).toBe(src);
  });

  it("addresses the opaque preview with '*' and never hands out the channel", () => {
    // "*" delivers to whatever document the frame holds — an external page
    // the preview navigated to included. With the channel it could forge
    // preview messages, so it is never in what the editor sends.
    const sent: { msg: unknown; target: string }[] = [];
    const win = { postMessage: (msg: unknown, target: string) => sent.push({ msg, target }) };
    postToPreview(win as unknown as Window, { kind: "caelo:reload" });
    postToPreview(win as unknown as Window, { kind: "caelo:page-paths", pages: [] });
    postToPreview(null, { kind: "caelo:reload" });
    expect(sent).toEqual([
      { msg: { kind: "caelo:reload" }, target: "*" },
      { msg: { kind: "caelo:page-paths", pages: [] }, target: "*" },
    ]);
  });

  it("treats a followed #anchor / scroll URL as the page the editor would load (PR #957)", () => {
    const src = previewUrl("/pricing", { channel: CHANNEL, branch: "b1" });
    const followed = `/edit/preview-by-path/pricing/?branch=b1&channel=${CHANNEL}&scroll=400#plans`;
    expect(samePreviewDocument(followed, src, EDITOR)).toBe(true);
    // Another page, branch or exclusion set is a different document.
    expect(
      samePreviewDocument(
        followed,
        previewUrl("/about", { channel: CHANNEL, branch: "b1" }),
        EDITOR,
      ),
    ).toBe(false);
    expect(
      samePreviewDocument(
        followed,
        previewUrl("/pricing", { channel: CHANNEL, branch: "b2" }),
        EDITOR,
      ),
    ).toBe(false);
    expect(
      samePreviewDocument(
        followed,
        previewUrl("/pricing", { channel: CHANNEL, branch: "b1", exclude: ["m"] }),
        EDITOR,
      ),
    ).toBe(false);
    expect(samePreviewDocument(null, src, EDITOR)).toBe(false);
  });

  it("mints channels the preview runtime accepts", () => {
    const c = newPreviewChannel();
    // Same pattern as the runtime's own check in inject-script.ts.
    expect(/^[0-9a-f-]{36}$/.test(c)).toBe(true);
    expect(newPreviewChannel()).not.toBe(c);
  });
});

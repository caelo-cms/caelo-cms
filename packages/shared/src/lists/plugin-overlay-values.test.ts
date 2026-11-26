// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a `list-resolve` overlay value a plugin set is held to the rule
 * for its field (docs/dev/external-plugin-brokers.md §4.5), for every
 * plugin: text escaped, richtext prose, links to the allowed schemes, media
 * to library images. A refused value fails with `plugin-value-refused`
 * (the spot stays raw and Publish live refuses), never a cleaned value and
 * never the stored, untranslated one. Values without an owner are core's
 * own and stay as they are.
 */

import { describe, expect, it } from "bun:test";
import type { LinkPageVariant } from "../link-refs.js";
import { fixtureData, fixtureLinkIndex, ITEM, LIST, PAGE } from "./list-fixtures.test.js";
import type { ListTypeDef } from "./list-type.js";
import type { PluginMediaFacts } from "./plugin-values.js";
import type { ListRenderData, ListVariantOverlay } from "./render-data.js";
import { createListRenderContext, type ListFieldSpec } from "./resolve.js";
import type { ScopeEntry, ScopeValue } from "./scope.js";

const variants = new Map<string, LinkPageVariant>([[PAGE.home, { variant: "de", group: null }]]);
const HEADER: ListFieldSpec = {
  name: "menu",
  listType: "menu",
  bind: "shared",
  list: `caelo:list/${LIST.header}`,
};
const LABEL = `list/${LIST.header}/item/${ITEM.home}/label`;
const LINK = `list/${LIST.header}/item/${ITEM.home}/link`;
const CI = "00000000-0000-4000-8000-000000000999";
const ITEM_ID = "00000000-0000-4000-9000-000000000001";
const IMAGE = "00000000-0000-4000-8000-0000000000a1";
const REFERENCE = "00000000-0000-4000-8000-0000000000a2";
const GALLERY: ListTypeDef = {
  slug: "gallery",
  name: "Gallery",
  purpose: "Images with a caption.",
  root: { allow: ["pic"] },
  nodes: {
    pic: {
      label: "Picture",
      fields: [
        { name: "image", label: "Image", type: "media" },
        { name: "caption", label: "Caption", type: "richtext" },
      ],
    },
  },
};

function overlay(
  values: [string, unknown][],
  owned = true,
  media: [string, PluginMediaFacts][] = [],
): ReadonlyMap<string, ListVariantOverlay> {
  return new Map([
    [
      "de",
      {
        values: new Map(values),
        hidden: new Set<string>(),
        ...(owned ? { owners: new Map(values.map(([a]) => [a, "probe"])) } : {}),
        media: new Map(media),
      },
    ],
  ]);
}

function withGallery(data: ListRenderData): ListRenderData {
  (data.listTypes as Map<string, { id: string; def: ListTypeDef }>).set("gallery", {
    id: "00000000-0000-4000-8000-000000000777",
    def: GALLERY,
  });
  return data;
}

function headerEntry(data: ListRenderData): ScopeEntry {
  const ctx = createListRenderContext(data).forPage(PAGE.home, {
    linkResolver: fixtureLinkIndex(data.pageVariants).forPage(PAGE.home),
  });
  const r = ctx.resolveField(HEADER, undefined, { contentInstanceId: null });
  if (!r.ok) throw new Error(r.marker);
  return r.entries[0] as ScopeEntry;
}

function galleryEntry(data: ListRenderData, values: Record<string, unknown>): ScopeEntry {
  const ctx = createListRenderContext(data).forPage(PAGE.home, {
    linkResolver: fixtureLinkIndex(data.pageVariants).forPage(PAGE.home),
  });
  const r = ctx.resolveField(
    { name: "pics", listType: "gallery" },
    [{ id: ITEM_ID, node: "pic", values }],
    { contentInstanceId: CI },
  );
  if (!r.ok) throw new Error(r.marker);
  return r.entries[0] as ScopeEntry;
}

const failed = (v: ScopeValue | undefined) => (v?.kind === "failed" ? v.marker : null);

describe("list-resolve values (#1729, §4.5)", () => {
  it("escapes a text value a plugin set; core's own values stay as stored", () => {
    const markup = "<img src=x onerror=alert(1)>";
    const owned = headerEntry(
      fixtureData({ pageVariants: variants, overlays: overlay([[LABEL, markup]]) }),
    );
    expect(owned.get("label")).toEqual({
      kind: "text",
      text: "&lt;img src=x onerror=alert(1)&gt;",
    });
    const core = headerEntry(
      fixtureData({ pageVariants: variants, overlays: overlay([[LABEL, markup]], false) }),
    );
    expect(core.get("label")).toEqual({ kind: "text", text: markup });
  });

  it.each([
    ["javascript:alert(1)", "url-scheme"],
    ["//evil.example/x", "url-protocol-relative"],
    ['https://example.com/" onmouseover="x', "url-characters"],
  ])("refuses the link %p (%s), naming the plugin and the address", (href, rule) => {
    const entry = headerEntry(
      fixtureData({ pageVariants: variants, overlays: overlay([[LINK, { href }]]) }),
    );
    expect(failed(entry.get("link"))).toBe(
      `plugin-value-refused:probe.list-resolve.${LINK}:${rule}`,
    );
  });

  it("holds a local list's richtext and media to prose and library images", () => {
    const at = (f: string) => `instance/${CI}/pics/item/${ITEM_ID}/${f}`;
    const media: [string, PluginMediaFacts][] = [
      [IMAGE, { visibility: "library", mime: "image/png" }],
      [REFERENCE, { visibility: "reference", mime: "image/png" }],
    ];
    const ok = galleryEntry(
      withGallery(
        fixtureData({
          pageVariants: variants,
          overlays: overlay(
            [
              [at("caption"), "<p>Ein <strong>Bild</strong></p>"],
              [at("image"), `caelo:media/${IMAGE}`],
            ],
            true,
            media,
          ),
        }),
      ),
      { caption: "<p>A picture</p>", image: `caelo:media/${IMAGE}` },
    );
    expect(failed(ok.get("caption"))).toBeNull();
    expect(failed(ok.get("image"))).toBeNull();

    const bad = galleryEntry(
      withGallery(
        fixtureData({
          pageVariants: variants,
          overlays: overlay(
            [
              [at("caption"), "<p>x</p><script>alert(1)</script>"],
              [at("image"), `caelo:media/${REFERENCE}`],
            ],
            true,
            media,
          ),
        }),
      ),
      { caption: "<p>A picture</p>", image: `caelo:media/${IMAGE}` },
    );
    expect(failed(bad.get("caption"))).toBe(
      `plugin-value-refused:probe.list-resolve.${at("caption")}:element-script`,
    );
    expect(failed(bad.get("image"))).toBe(
      `plugin-value-refused:probe.list-resolve.${at("image")}:media-reference`,
    );
  });
});

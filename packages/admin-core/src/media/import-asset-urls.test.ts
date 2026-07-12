// SPDX-License-Identifier: MPL-2.0

/**
 * issue #249 (WS3) — unit coverage for the pure asset-URL discovery +
 * rewrite functions the media-migration op is built on. Fixture HTML
 * mirrors what the crawler actually stages: absolute, relative,
 * protocol-relative, srcset with descriptors, inline styles, and CSS
 * url(...) fonts.
 */

import { describe, expect, it } from "bun:test";
import {
  discoverAssetRefs,
  magicBytesMatchMime,
  normalizeAssetMime,
  rewriteAssetRefs,
} from "./import-asset-urls.js";

const BASE = "https://old-site.example/blog/post-1/";

describe("discoverAssetRefs (html)", () => {
  it("finds img src + alt and resolves relative/protocol-relative URLs", () => {
    const html =
      '<img src="../img/hero.png" alt="Team photo"> ' +
      '<img src="//cdn.example.com/logo.svg" alt="">';
    const d = discoverAssetRefs(html, "html", BASE);
    expect(d.refs.map((r) => r.url)).toEqual([
      "https://old-site.example/blog/img/hero.png",
      "https://cdn.example.com/logo.svg",
    ]);
    expect(d.refs[0]?.alt).toBe("Team photo");
    expect(d.unparseable).toEqual([]);
  });

  it("splits srcset into per-candidate refs, keeping descriptors out of the token", () => {
    const html = '<img srcset="a.png 1x, b.png 2x , https://x.example/c.png 640w" src="a.png">';
    const d = discoverAssetRefs(html, "html", BASE);
    expect(d.refs.map((r) => r.url)).toEqual([
      "https://old-site.example/blog/post-1/a.png",
      "https://old-site.example/blog/post-1/b.png",
      "https://x.example/c.png",
      "https://old-site.example/blog/post-1/a.png",
    ]);
    // Spans hold exactly the URL tokens.
    for (const r of d.refs) {
      expect(html.slice(r.start, r.end)).toBe(r.raw);
    }
  });

  it("covers source/video/audio src + poster and inline style url(...)", () => {
    const html =
      '<video poster="/media/poster.jpg" src="/media/clip.mp4"></video>' +
      '<audio src="/media/talk.mp3"></audio>' +
      "<source src='/media/alt.webm'>" +
      '<div style="background-image: url(/img/bg.jpg)"></div>';
    const d = discoverAssetRefs(html, "html", BASE);
    expect(d.refs.map((r) => r.url)).toEqual([
      "https://old-site.example/media/poster.jpg",
      "https://old-site.example/media/clip.mp4",
      "https://old-site.example/media/talk.mp3",
      "https://old-site.example/media/alt.webm",
      "https://old-site.example/img/bg.jpg",
    ]);
  });

  it("ignores data:/blob:/placeholder tokens and counts /_caelo/ refs as alreadyLocal", () => {
    const html =
      '<img src="data:image/png;base64,AAAA">' +
      '<img src="{{hero_image}}">' +
      '<img src="/_caelo/media/0b0b0b0b-0000-0000-0000-000000000000/orig">' +
      '<div style="background: url(blob:https://x/y)"></div>';
    const d = discoverAssetRefs(html, "html", BASE);
    expect(d.refs).toEqual([]);
    expect(d.alreadyLocal).toBe(1);
  });

  it("reports unresolvable tokens loudly instead of dropping them", () => {
    const d = discoverAssetRefs('<img src="http://">', "html", BASE);
    expect(d.refs).toEqual([]);
    expect(d.unparseable).toEqual(["http://"]);
  });
});

describe("discoverAssetRefs (css)", () => {
  it("finds quoted and bare url(...) tokens — fonts included", () => {
    const css =
      '@font-face { src: url("/fonts/brand.woff2") format("woff2"), url(/fonts/brand.woff); }' +
      ".hero { background-image: url('https://cdn.example.com/bg.webp'); }";
    const d = discoverAssetRefs(css, "css", BASE);
    expect(d.refs.map((r) => r.url)).toEqual([
      "https://old-site.example/fonts/brand.woff2",
      "https://old-site.example/fonts/brand.woff",
      "https://cdn.example.com/bg.webp",
    ]);
  });

  it("does not scan html attributes in css mode", () => {
    const d = discoverAssetRefs('<img src="/x.png">', "css", BASE);
    expect(d.refs).toEqual([]);
  });
});

describe("rewriteAssetRefs", () => {
  const MEDIA_A = "/_caelo/media/11111111-1111-1111-1111-111111111111/orig";
  const MEDIA_B = "/_caelo/media/22222222-2222-2222-2222-222222222222/orig";

  it("replaces mapped refs in place, preserving srcset descriptors and unmapped refs", () => {
    const html =
      '<img srcset="a.png 1x, big-a.png 2x" src="a.png" alt="x">' +
      '<div style="background: url(/img/bg.jpg)"></div>';
    const d = discoverAssetRefs(html, "html", BASE);
    const map = new Map([
      ["https://old-site.example/blog/post-1/a.png", MEDIA_A],
      ["https://old-site.example/img/bg.jpg", MEDIA_B],
    ]);
    const out = rewriteAssetRefs(html, d.refs, map);
    // `a.png` rewritten in BOTH srcset and src; the distinct
    // `big-a.png` (unmapped, and a superstring of a.png) is untouched.
    expect(out).toBe(
      `<img srcset="${MEDIA_A} 1x, big-a.png 2x" src="${MEDIA_A}" alt="x">` +
        `<div style="background: url(${MEDIA_B})"></div>`,
    );
  });

  it("is idempotent — a second discovery over rewritten text finds only local refs", () => {
    const html = '<img src="photo.jpg">';
    const d = discoverAssetRefs(html, "html", BASE);
    const map = new Map([["https://old-site.example/blog/post-1/photo.jpg", MEDIA_A]]);
    const out = rewriteAssetRefs(html, d.refs, map);
    const again = discoverAssetRefs(out, "html", BASE);
    expect(again.refs).toEqual([]);
    expect(again.alreadyLocal).toBe(1);
  });

  it("leaves text unchanged when nothing is mapped", () => {
    const html = '<img src="photo.jpg">';
    const d = discoverAssetRefs(html, "html", BASE);
    expect(rewriteAssetRefs(html, d.refs, new Map())).toBe(html);
  });
});

describe("normalizeAssetMime", () => {
  it("maps aliases and strips parameters", () => {
    expect(normalizeAssetMime("image/jpg; charset=binary")).toBe("image/jpeg");
    expect(normalizeAssetMime("application/font-woff")).toBe("font/woff");
    expect(normalizeAssetMime("application/x-font-ttf")).toBe("font/ttf");
    expect(normalizeAssetMime("IMAGE/PNG")).toBe("image/png");
  });

  it("rejects everything outside the migration allowlist — video and html included", () => {
    expect(normalizeAssetMime("video/mp4")).toBeNull();
    expect(normalizeAssetMime("text/html; charset=utf-8")).toBeNull();
    expect(normalizeAssetMime("application/octet-stream")).toBeNull();
    expect(normalizeAssetMime("")).toBeNull();
  });
});

describe("magicBytesMatchMime", () => {
  const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

  it("accepts matching magic bytes", () => {
    expect(magicBytesMatchMime("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(
      true,
    );
    expect(magicBytesMatchMime("font/woff2", ascii("wOF2...."))).toBe(true);
    expect(magicBytesMatchMime("application/pdf", ascii("%PDF-1.7"))).toBe(true);
    expect(magicBytesMatchMime("image/svg+xml", ascii('<?xml version="1.0"?><svg>'))).toBe(true);
  });

  it("rejects an HTML body served under an image content-type", () => {
    expect(magicBytesMatchMime("image/png", ascii("<!doctype html><html>"))).toBe(false);
    expect(magicBytesMatchMime("font/woff2", ascii("<!doctype html>"))).toBe(false);
  });
});

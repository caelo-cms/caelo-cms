// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { cssLoadProblem, placeholderMarkupProblem } from "./client-assets.js";
import { validateManifest } from "./validate.js";

const PLACEHOLDER =
  '<div class="ph" data-consent-placeholder><p>Loads with your consent to &ldquo;{{label}}&rdquo;.</p><button type="button" data-consent-grant="{{key}}">Allow</button></div>';

describe("#1729 — deferral placeholder markup", () => {
  it("allows plain markup with text slots", () => {
    expect(placeholderMarkupProblem(PLACEHOLDER)).toBeNull();
    expect(placeholderMarkupProblem('<p><a href="/privacy/">Privacy</a></p>')).toBeNull();
    expect(
      placeholderMarkupProblem(
        "<p title='{{label}}' data-k=\"{{key}}\">{{label}} &amp; {{key}}</p>",
      ),
    ).toBeNull();
  });

  it.each([
    ["<script>steal()</script>", "element <script>"],
    ['<img src="https://tracker.example/p.gif">', "element <img>"],
    ['<iframe src="https://www.youtube.com/embed/x"></iframe>', "element <iframe>"],
    ['<link rel="stylesheet" href="https://cdn.example/x.css">', "element <link>"],
    ["<style>@import url(https://x.example/a.css)</style>", "element <style>"],
    ['<div onclick="steal()">x</div>', "attribute onclick on <div>"],
    ['<div style="background:url(https://t.example/p)">x</div>', "attribute style on <div>"],
    ['<button formaction="https://evil.example">x</button>', "attribute formaction on <button>"],
    ['<a href="javascript:steal()">x</a>', "href-scheme-javascript"],
    ['<a href="jav&#97;script:steal()">x</a>', "href-scheme-javascript"],
    ['<a href="//evil.example/">x</a>', "href-protocol-relative"],
    [
      '<a href="{{url}}">x</a>',
      "a {{slot}} inside href: a verdict's text never chooses where a link goes",
    ],
    ["<p>{{{raw}}}</p>", "template-syntax: only {{name}} slots are allowed"],
    [
      "<div title={{label}}>x</div>",
      "a {{slot}} outside text and quoted attribute values: a verdict's text could add attributes or elements there — put each slot in text or in a quoted attribute value",
    ],
    [
      '<div title="x" data-k={{key}}>x</div>',
      "a {{slot}} outside text and quoted attribute values: a verdict's text could add attributes or elements there — put each slot in text or in a quoted attribute value",
    ],
    [
      "<p>Before <{{tag}}> after</p>",
      "a {{slot}} outside text and quoted attribute values: a verdict's text could add attributes or elements there — put each slot in text or in a quoted attribute value",
    ],
    ["<p>{{#items}}x{{/items}}</p>", "template-syntax: only {{name}} slots are allowed"],
  ])("refuses %s", (html, problem) => {
    expect(placeholderMarkupProblem(html)).toBe(problem);
  });
});

describe("#1729 — CSS that loads nothing from another site", () => {
  it("allows local and data: URLs", () => {
    expect(cssLoadProblem(".a{background:url(/img/a.png)}")).toBeNull();
    expect(cssLoadProblem(".a{background:url('data:image/svg+xml,<svg/>')}")).toBeNull();
    expect(cssLoadProblem('.a{font-family:"Segoe UI",sans-serif}')).toBeNull();
  });

  it.each([
    ["@import url(https://fonts.example/a.css);", "@import"],
    ['@import "https://fonts.example/a.css";', "@import"],
    ["@\\69mport 'x.css';", "@import"],
    [".a{background:url(https://tracker.example/p.gif)}", "url(https://tracker.example/p.gif)"],
    [".a{background:url(//tracker.example/p.gif)}", "url(//tracker.example/p.gif)"],
    [".a{background:\\75 rl(https://t.example/p)}", "url(https://t.example/p)"],
    ['.a{background:image-set("https://t.example/p.png" 1x)}', "url(https://t.example/p.png)"],
    ["@font-face{src:url(http://t.example/f.woff2)}", "url(http://t.example/f.woff2)"],
    [".a{width:expression(alert(1))}", "expression()"],
  ])("refuses %s", (css, problem) => {
    expect(cssLoadProblem(css)).toBe(problem);
  });

  it("reads past closed comments and keeps an unclosed one, in linear time (CodeQL js/polynomial-redos)", () => {
    expect(cssLoadProblem(".a{color:red}/* @import 'x.css'; */")).toBeNull();
    expect(cssLoadProblem("/*/ @import 'x.css'; */.a{}")).toBeNull();
    expect(cssLoadProblem(".a{}/* @import 'x.css';")).toBe("@import");
    // Every `/*` opens a comment that never closes: a lazy comment regex
    // rescanned to the end from each one.
    const css = `/*${"a/*".repeat(200_000)}`;
    const started = performance.now();
    expect(cssLoadProblem(css)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reads the stylesheet token by token, as a browser does", () => {
    // A comment inside a string opens none: the url() between them loads.
    expect(
      cssLoadProblem('.a{content:"/*"}.b{background:url(//t.example/p)}.c{content:"*/"}'),
    ).toBe("url(//t.example/p)");
    // An escaped backslash is one character; the `e` after it is no hex escape.
    expect(cssLoadProblem(String.raw`.a{background:url('/\\evil.example/a')}`)).toBe(
      String.raw`url(/\evil.example/a)`,
    );
    // A comment ends a token: `u/**/rl(` is no url() to a browser, and loads nothing.
    expect(cssLoadProblem(".a{background:u/**/rl(https://t.example/p)}")).toBeNull();
    // A quoted target may hold a `)`; a bad url is refused as written.
    expect(cssLoadProblem(".a{background:url('https://t.example/a(1)')}")).toBe(
      "url(https://t.example/a(1))",
    );
    expect(cssLoadProblem(".a{background:url(https://t.example/a b)}")).toBe(
      "url(https://t.example/a)",
    );
    // An escape past U+10FFFF reads as U+FFFD, it does not throw.
    expect(cssLoadProblem(String.raw`.a{content:"\110000"}`)).toBeNull();
    expect(cssLoadProblem(".a{background:url( /img/a.png )}")).toBeNull();
    expect(cssLoadProblem(".a{background:url(img/a.png)}")).toBeNull();
  });

  it("resolves a URL as the browser does: a backslash or a stripped tab can name a host", () => {
    for (const target of [
      String.raw`/\\tracking.example/pixel`,
      String.raw`\\\\tracking.example/pixel`,
      String.raw`https:\\\\tracking.example/pixel`,
      "/\\9 /tracking.example/pixel",
    ]) {
      for (const css of [
        `.a{background:url('${target}')}`,
        `.a{background:image-set('/a.png' 1x, '${target}' 2x)}`,
      ]) {
        expect(cssLoadProblem(css)).toStartWith("url(");
      }
    }
    // The finding's own case, escapes as a stylesheet writes them.
    expect(cssLoadProblem(String.raw`.a{background-image:url('/\\tracking.example/pixel')}`)).toBe(
      String.raw`url(/\tracking.example/pixel)`,
    );
  });

  it("allows an origin the grant names", () => {
    const allowed = (o: string) => o === "https://fonts.example";
    expect(
      cssLoadProblem("@font-face{src:url(https://fonts.example/f.woff2)}", allowed),
    ).toBeNull();
    expect(cssLoadProblem("@font-face{src:url(https://other.example/f.woff2)}", allowed)).toBe(
      "url(https://other.example/f.woff2)",
    );
  });
});

describe("#1729 — validateManifest holds every plugin to the placeholder rules", () => {
  const base = {
    slug: "gate-probe",
    version: "1.0.0",
    tier: 1 as const,
    schema: {},
    operations: ["deferrals"],
    requestedCapabilities: ["client_assets"],
    hasDeferrals: true,
  };

  it("accepts reviewed placeholders", () => {
    const r = validateManifest({
      ...base,
      deferralPlaceholders: { allow: { html: PLACEHOLDER, css: ".ph{opacity:.8}" } },
    });
    expect(r.failures).toEqual([]);
  });

  it("refuses a placeholder that would load something, naming where", () => {
    const r = validateManifest({
      ...base,
      deferralPlaceholders: {
        allow: { html: '<img src="https://tracker.example/p.gif">', css: "" },
      },
    });
    expect(r.failures.map((f) => f.kind)).toEqual(["client-assets"]);
    expect(r.failures[0]?.hint).toContain("deferralPlaceholders.allow.html: element <img>");
  });

  it("refuses deferrals without the client_assets grant", () => {
    const r = validateManifest({ ...base, requestedCapabilities: [] });
    expect(r.failures.map((f) => f.kind)).toEqual(["manifest-cap-missing"]);
    expect(r.failures[0]?.hint).toContain("client_assets");
  });

  it("refuses placeholders nothing names", () => {
    const r = validateManifest({
      ...base,
      hasDeferrals: false,
      operations: [],
      deferralPlaceholders: { allow: { html: "<p>x</p>", css: "" } },
    });
    expect(r.failures.map((f) => f.kind)).toContain("client-assets");
  });
});

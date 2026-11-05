// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { composeSiteHeaders, DEFAULT_SITE_SECURITY_POLICY } from "@caelo-cms/shared";
import { PageScripts, pageScriptPath } from "./page-scripts-pass.js";
import { CspScanner, inlineScriptHash } from "./security-headers-pass.js";

const scan = (html: string) => {
  const scanner = new CspScanner("https://www.example.com");
  scanner.scanPage(html, "/index.html");
  return scanner.facts();
};

describe("CspScanner", () => {
  it("names what a page loads, by kind", () => {
    const facts = scan(`
      <link rel="stylesheet" href="https://css.vendor.com/a.css">
      <link rel="preload" as="font" href="https://fonts.vendor.com/a.woff2">
      <script src="https://js.vendor.com/a.js"></script>
      <img src="https://media.example-cdn.com/a.jpg" srcset="https://img2.vendor.com/a.jpg 1x, /b.jpg 2x">
      <video src="https://video.vendor.com/a.mp4" poster="https://poster.vendor.com/a.jpg">
        <source src="https://source.vendor.com/a.webm">
      </video>
      <picture><source srcset="https://pic.vendor.com/a.webp"></picture>
      <iframe src="https://www.youtube-nocookie.com/embed/x"></iframe>
      <form action="https://forms.vendor.com/post"></form>
      <embed src="https://pdf.vendor.com/a.pdf">
      <img src="/local.jpg"><img src="data:image/png;base64,AAAA">`);
    expect(facts.origins.style).toEqual(["https://css.vendor.com"]);
    expect(facts.origins.font).toEqual(["https://fonts.vendor.com"]);
    expect(facts.origins.script).toEqual(["https://js.vendor.com"]);
    expect(facts.origins.img).toEqual([
      "https://img2.vendor.com",
      "https://media.example-cdn.com",
      "https://pic.vendor.com",
      "https://poster.vendor.com",
    ]);
    expect(facts.origins.media).toEqual(["https://source.vendor.com", "https://video.vendor.com"]);
    expect(facts.origins.frame).toEqual(["https://www.youtube-nocookie.com"]);
    expect(facts.origins.form).toEqual(["https://forms.vendor.com"]);
    expect(facts.objectOrigins).toEqual(["https://pdf.vendor.com"]);
  });

  it("reads CSS: fonts, imports, backgrounds, style attributes", () => {
    const facts = scan(`
      <style>
        @import url("https://css.vendor.com/x.css");
        @font-face { font-family: X; src: url(https://fonts.vendor.com/x.woff2); }
        .hero { background: url('https://img.vendor.com/hero.jpg'); }
      </style>
      <div style="background-image:url(//img2.vendor.com/a.png)"></div>`);
    expect(facts.origins.style).toEqual(["https://css.vendor.com"]);
    expect(facts.origins.font).toEqual(["https://fonts.vendor.com"]);
    expect(facts.origins.img).toEqual(["https://img.vendor.com", "https://img2.vendor.com"]);
  });

  it("hashes executable inline scripts over their exact text, and no data block", () => {
    const body = "console.log('a < b && \"c\"');\n";
    const facts = scan(
      `<script>${body}</script><script type="application/ld+json">{"a":1}</script>`,
    );
    const expected = createHash("sha256").update(body, "utf8").digest("base64");
    expect(facts.inlineScriptHashes).toEqual([`'sha256-${expected}'`]);
  });

  it("a withheld module's script is hashed as the consent runtime runs it", () => {
    const body = "run('ü')";
    const encoded = Buffer.from(body, "utf8").toString("base64");
    const facts = scan(
      `<template data-caelo-deferred-content><iframe src="https://maps.vendor.com/x"></iframe></template>
       <script type="text/plain" data-caelo-deferred-script="m1" data-caelo-encoding="base64">${encoded}</script>
       <script type="text/plain" data-caelo-deferred-script="m2">plain()</script>`,
    );
    expect(facts.inlineScriptHashes).toEqual(
      [inlineScriptHash(body), inlineScriptHash("plain()")].sort(),
    );
    expect(facts.origins.frame).toEqual(["https://maps.vendor.com"]);
  });

  it("reports what no hash can allow, counted per page", () => {
    const scanner = new CspScanner("https://www.example.com");
    scanner.scanPage('<button onclick="go()">x</button><a href="javascript:go()">y</a>', "/a");
    scanner.scanPage('<button onclick="go()">x</button>', "/b");
    scanner.scanPage('<base href="https://evil.example.org/">', "/c");
    scanner.scanPage(
      '<base href="https://www.example.com/"><script src="data:text/javascript,1"></script>',
      "/d",
    );
    const blockers = scanner.facts().blockers;
    expect(blockers.find((b) => b.kind === "inline-handler")).toEqual({
      kind: "inline-handler",
      detail: "onclick",
      pages: ["/a", "/b"],
      pageCount: 2,
    });
    expect(blockers.map((b) => b.kind).sort()).toEqual([
      "data-script",
      "foreign-base",
      "inline-handler",
      "javascript-url",
    ]);
  });

  it("leaves custom elements' on-attributes and `once` alone", () => {
    expect(scan('<my-widget onready="x"></my-widget><div once="1"></div>').blockers).toEqual([]);
  });

  it("takes in plugins, and a previous build's facts on an incremental build", () => {
    const first = new CspScanner("https://www.example.com");
    first.scanPage('<iframe src="https://old.vendor.com/x"></iframe>', "/old");
    const second = new CspScanner("https://www.example.com");
    second.addPrevious(first.facts());
    second.addPlugin("consent-manager", {
      origins: { script: ["https://*.googletagmanager.com"] },
      inlineScripts: ["gtag()"],
    });
    const facts = second.facts();
    expect(facts.origins.frame).toEqual(["https://old.vendor.com"]);
    expect(facts.origins.script).toEqual(["https://*.googletagmanager.com"]);
    expect(facts.inlineScriptHashes).toEqual([inlineScriptHash("gtag()")]);
    expect(facts.plugins).toEqual([
      { slug: "consent-manager", origins: ["https://*.googletagmanager.com"], inlineScripts: 1 },
    ]);
  });

  it("the policy of a 50,000-page-style site stays in budget: no per-page hash", async () => {
    const written = new Map<string, string>();
    const scripts = new PageScripts(async (path, body) => {
      written.set(path, body);
    });
    const scanner = new CspScanner("https://www.example.com");
    // Distinct module sets, as a site with many templates has them.
    const pages = Array.from({ length: 500 }, (_, i) => ({
      html: `<body><script defer data-source="modules">run(${i})</script></body>`,
    }));
    await scripts.externalize(pages);
    for (const p of pages) scanner.scanPage(p.html, "/p");
    const set = composeSiteHeaders(DEFAULT_SITE_SECURITY_POLICY, scanner.facts());
    expect(set.facts.inlineScriptHashes).toEqual([]);
    expect(set.cspCut).toBe(false);
    expect(written.size).toBe(500);
  });
});

describe("PageScripts", () => {
  it("moves the page script into a content-hashed file, each body once", async () => {
    const written = new Map<string, string>();
    const scripts = new PageScripts(async (path, body) => {
      written.set(path, body);
    });
    const body = "a();";
    const pages = [
      { html: `<p></p><script defer data-source="modules">${body}</script></body>` },
      { html: `<script defer data-source="modules">${body}</script>` },
    ];
    await scripts.externalize(pages);
    await scripts.externalize([{ html: `<script defer data-source="modules">${body}</script>` }]);
    const path = pageScriptPath(body);
    expect(path).toMatch(/^_assets\/page-script\.[0-9a-f]{16}\.js$/);
    expect(pages[0]?.html).toBe(
      `<p></p><script defer data-source="modules" src="/${path}"></script></body>`,
    );
    expect([...written]).toEqual([[path, body]]);
    expect(scripts.fileCount).toBe(1);
  });

  it("replaces the data: form too, which a CSP would refuse", async () => {
    const written = new Map<string, string>();
    const scripts = new PageScripts(async (path, body) => {
      written.set(path, body);
    });
    const body = 'x("</script>")';
    const encoded = Buffer.from(body, "utf8").toString("base64");
    const pages = [
      {
        html: `<script defer data-source="modules" src="data:text/javascript;base64,${encoded}"></script>`,
      },
    ];
    await scripts.externalize(pages);
    expect(pages[0]?.html).toBe(
      `<script defer data-source="modules" src="/${pageScriptPath(body)}"></script>`,
    );
    expect(written.get(pageScriptPath(body))).toBe(body);
  });

  it("leaves a plugin's script and a parked module script alone", async () => {
    const scripts = new PageScripts(async () => {});
    const html =
      '<script defer src="/_caelo/plugin/a/b.js"></script><script type="text/plain" data-caelo-deferred-script="m">x</script>';
    const pages = [{ html }];
    await scripts.externalize(pages);
    expect(pages[0]?.html).toBe(html);
  });
});

// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { canonicalSitePath } from "@caelo-cms/plugin-sdk";
import { extractPageHtmlFacts, MAX_PAGE_TEXT_CHARS, sitePathOf } from "./page-output-facts.js";
import { factBatches, PAGE_OUTPUT_BATCH_BYTES } from "./page-output-host.js";

const ORIGINS = new Set(["https://example.com", "https://www.example.com"]);

const HTML = `<!doctype html><html lang="de"><head><title> Preise | Firma </title>
<meta name="description" content="Was es kostet."><meta name="robots" content="index,follow">
<script>var hidden = "nicht im Text";</script></head><body>
<header data-caelo-module-id="m-head"><a href="/de/preise/">Preise</a> <a href="https://other.org/x">Partner</a></header>
<main><section id="intro" data-caelo-module-id="m-hero"><h1>Unsere Preise</h1><p>Monatlich <b>kündbar</b>.</p>
<div data-caelo-module-id="m-nested"><p>Verschachtelt</p></div></section>
<h2 id="faq">Fragen</h2><p>Antwort eins.</p>
<form data-caelo-module-id="m-form"><label>E-Mail</label><input type="submit" value="Senden"></form>
<div data-caelo-deferred="consent-manager"><p>Video</p></div>
<pre>code text</pre></main></body></html>`;

describe("extractPageHtmlFacts", () => {
  const facts = extractPageHtmlFacts({
    pageId: "p1",
    path: "/de/preise/",
    url: "https://example.com/de/preise/",
    html: HTML,
    composed: [
      { moduleId: "m-head", zone: "layout", contentInstanceId: null },
      { moduleId: "m-hero", zone: "page", contentInstanceId: "ci-1" },
      { moduleId: "m-form", zone: "page", contentInstanceId: "ci-2" },
    ],
    siteOrigins: ORIGINS,
  });

  it("reads the head", () => {
    expect([facts.lang, facts.title, facts.metaDescription, facts.robots]).toEqual([
      "de",
      "Preise | Firma",
      "Was es kostet.",
      "index,follow",
    ]);
  });

  it("attributes every run to module, zone, heading, anchor and form, and skips scripts", () => {
    const by = (t: string) => facts.texts.find((x) => x.text === t);
    expect(by("Unsere Preise")).toMatchObject({
      moduleId: "m-hero",
      heading: 1,
      anchor: "intro",
      inForm: false,
    });
    expect(by("kündbar")).toMatchObject({ heading: null, anchor: "intro" });
    expect(by("Verschachtelt")).toMatchObject({ moduleId: "m-nested", anchor: "intro" });
    expect(by("Antwort eins.")).toMatchObject({ moduleId: null, anchor: "faq" });
    expect(by("E-Mail")).toMatchObject({ inForm: true, moduleId: "m-form" });
    expect(by("Senden")).toMatchObject({ inForm: true, source: "value" });
    expect(by("code text")?.source).toBe("literal");
    expect(facts.texts.some((t) => t.text.includes("nicht im Text"))).toBe(false);
  });

  it("gives a nested module its parent's zone and lists it once", () => {
    expect(facts.modules.find((m) => m.moduleId === "m-nested")).toEqual({
      moduleId: "m-nested",
      zone: "page",
      contentInstanceId: null,
    });
    expect(facts.modules.filter((m) => m.moduleId === "m-hero")).toHaveLength(1);
  });

  it("resolves site links to paths and leaves external ones without", () => {
    expect(facts.links).toEqual([
      {
        href: "/de/preise/",
        path: "/de/preise",
        text: "Preise",
        moduleId: "m-head",
        contentInstanceId: null,
        zone: "layout",
        pluginSlug: null,
      },
      {
        href: "https://other.org/x",
        path: null,
        text: "Partner",
        moduleId: "m-head",
        contentInstanceId: null,
        zone: "layout",
        pluginSlug: null,
      },
    ]);
  });

  it("tells two placements of one design apart by their content instance", () => {
    const two = extractPageHtmlFacts({
      pageId: "p2",
      path: "/zwei/",
      url: "https://example.com/zwei/",
      html: `<html lang="de"><body>
        <div data-caelo-module-id="m-text" data-caelo-content-instance="11111111-1111-4111-8111-111111111111"><p>Erster Block</p></div>
        <div data-caelo-module-id="m-text" data-caelo-content-instance="22222222-2222-4222-8222-222222222222"><p>Zweiter Block</p></div>
      </body></html>`,
      composed: [
        {
          moduleId: "m-text",
          zone: "page",
          contentInstanceId: "11111111-1111-4111-8111-111111111111",
        },
        {
          moduleId: "m-text",
          zone: "page",
          contentInstanceId: "22222222-2222-4222-8222-222222222222",
        },
      ],
      siteOrigins: ORIGINS,
    });
    expect(two.modules.map((m) => m.contentInstanceId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(two.texts.map((t) => [t.text, t.contentInstanceId?.slice(0, 1)])).toEqual([
      ["Erster Block", "1"],
      ["Zweiter Block", "2"],
    ]);
  });

  it("flags withheld content and hashes the facts, not the markup", () => {
    expect(facts.hasDeferredContent).toBe(true);
    const again = extractPageHtmlFacts({
      pageId: "p1",
      path: "/de/preise/",
      url: "https://example.com/de/preise/",
      html: HTML.replace("<b>", '<b class="x">'),
      composed: [
        { moduleId: "m-head", zone: "layout", contentInstanceId: null },
        { moduleId: "m-hero", zone: "page", contentInstanceId: "ci-1" },
        { moduleId: "m-form", zone: "page", contentInstanceId: "ci-2" },
      ],
      siteOrigins: ORIGINS,
    });
    expect(again.outputHash).toBe(facts.outputHash);
  });
});

describe("bounded facts", () => {
  it("leaves text past the bound out and says so", () => {
    const para = `<p>${"Wort ".repeat(10_000)}</p>`;
    const facts = extractPageHtmlFacts({
      pageId: "p",
      path: "/p/",
      url: "https://example.com/p/",
      html: `<html lang="de"><head><title>T</title></head><body>${para.repeat(10)}</body></html>`,
      composed: [],
      siteOrigins: ORIGINS,
    });
    expect(facts.truncated).toBe(true);
    expect(facts.texts.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(
      MAX_PAGE_TEXT_CHARS,
    );
  });

  it("splits observer calls by bytes as well as by pages", () => {
    const page = (i: number, chars: number) =>
      ({ pageId: String(i), texts: [{ text: "x".repeat(chars) }] }) as never;
    const small = factBatches(Array.from({ length: 450 }, (_, i) => page(i, 10)));
    expect(small.map((b) => b.length)).toEqual([200, 200, 50]);
    const large = factBatches(Array.from({ length: 10 }, (_, i) => page(i, 300_000)));
    expect(large.every((b) => JSON.stringify(b).length <= PAGE_OUTPUT_BATCH_BYTES + 300_100)).toBe(
      true,
    );
    expect(large.length).toBe(5);
  });
});

describe("site paths", () => {
  it("spells a path one way", () => {
    expect(canonicalSitePath("/de/preise/index.html")).toBe("/de/preise");
    expect(canonicalSitePath("/")).toBe("/");
    expect(canonicalSitePath("/caf%C3%A9/")).toBe("/café");
    expect(sitePathOf("mailto:x@y.z", "https://example.com/", ORIGINS)).toBeNull();
    expect(sitePathOf("#top", "https://example.com/", ORIGINS)).toBeNull();
    expect(sitePathOf("https://www.example.com/a/?q=1#b", "https://example.com/", ORIGINS)).toBe(
      "/a",
    );
  });
});

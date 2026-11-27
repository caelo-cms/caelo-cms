// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  buildPageGraph,
  type CoreGraphInput,
  type GraphContribution,
  jsonLdIntegrityProblems,
  LIVE_PLACEHOLDER_KEY,
  MEDIA_PLACEHOLDER_KEY,
  renderJsonLdScript,
} from "./json-ld.js";

const core: CoreGraphInput = {
  siteBaseUrl: "https://blog.example",
  canonical: "https://blog.example/articles/graph/",
  siteName: "Example Blog",
  siteLanguage: "en",
  pageLanguage: "en",
  pageTitle: "One graph per page",
  description: "Why a JSON-LD graph has fixed ids.",
  imageUrl: "https://blog.example/_assets/graph.abc.jpg",
  organization: {
    name: "Example GmbH",
    url: "https://blog.example/",
    logo: "https://blog.example/_assets/logo.abc.png",
    sameAs: ["https://www.linkedin.com/company/example"],
  },
  breadcrumbs: [
    { name: "Start", url: "https://blog.example/" },
    { name: "Articles", url: "https://blog.example/articles/" },
    { name: "Graph", url: "https://blog.example/articles/graph/" },
  ],
  liveDates: { published: "2026-11-01T09:00:00.000Z", modified: "2026-11-20T12:00:00.000Z" },
};

const noMedia = () => null;

describe("buildPageGraph (#1753)", () => {
  it("writes core's nodes with fixed ids, byte for byte", () => {
    const { graph, refusals } = buildPageGraph(core, [], noMedia);
    expect(refusals).toEqual([]);
    // The exact bytes the build and the preview write for a page of a blog.
    expect(renderJsonLdScript(graph)).toBe(
      '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[' +
        '{"@type":"Organization","@id":"https://blog.example/#organization","name":"Example GmbH","url":"https://blog.example/","logo":{"@type":"ImageObject","url":"https://blog.example/_assets/logo.abc.png"},"sameAs":["https://www.linkedin.com/company/example"]},' +
        '{"@type":"WebSite","@id":"https://blog.example/#website","url":"https://blog.example/","name":"Example Blog","inLanguage":"en","publisher":{"@id":"https://blog.example/#organization"}},' +
        '{"@type":"WebPage","@id":"https://blog.example/articles/graph/","url":"https://blog.example/articles/graph/","name":"One graph per page","description":"Why a JSON-LD graph has fixed ids.","image":"https://blog.example/_assets/graph.abc.jpg","inLanguage":"en","isPartOf":{"@id":"https://blog.example/#website"},"breadcrumb":{"@id":"https://blog.example/articles/graph/#breadcrumb"},"publisher":{"@id":"https://blog.example/#organization"},"datePublished":"2026-11-01T09:00:00.000Z","dateModified":"2026-11-20T12:00:00.000Z"},' +
        '{"@type":"BreadcrumbList","@id":"https://blog.example/articles/graph/#breadcrumb","itemListElement":[{"@type":"ListItem","position":1,"name":"Start","item":"https://blog.example/"},{"@type":"ListItem","position":2,"name":"Articles","item":"https://blog.example/articles/"},{"@type":"ListItem","position":3,"name":"Graph","item":"https://blog.example/articles/graph/"}]}' +
        "]}</script>",
    );
  });

  it("leaves out the Organization, the trail and the dates a page does not have", () => {
    const { graph } = buildPageGraph(
      {
        ...core,
        organization: {},
        breadcrumbs: [],
        liveDates: null,
        siteName: null,
        imageUrl: null,
      },
      [],
      noMedia,
    );
    expect(graph["@graph"].map((n) => n["@type"])).toEqual(["WebSite", "WebPage"]);
    expect(graph["@graph"][1]).toEqual({
      "@type": "WebPage",
      "@id": "https://blog.example/articles/graph/",
      url: "https://blog.example/articles/graph/",
      name: "One graph per page",
      description: "Why a JSON-LD graph has fixed ids.",
      inLanguage: "en",
      isPartOf: { "@id": "https://blog.example/#website" },
    });
  });

  it("never lets a value close the script", () => {
    const { graph } = buildPageGraph(
      { ...core, pageTitle: "</script><script>x()</script>" },
      [],
      noMedia,
    );
    const script = renderJsonLdScript(graph);
    expect(script.match(/<\/script>/g)).toHaveLength(1);
    expect(script).toContain("\\u003c/script>");
  });

  it("adds a plugin's WebPage type, properties and nodes, placeholders filled", () => {
    const part: GraphContribution = {
      plugin: "seo",
      webPageType: "ProfilePage",
      webPage: { mainEntity: { "@id": "https://blog.example/articles/graph/#person" } },
      nodes: [
        {
          "@type": "Person",
          "@id": "https://blog.example/articles/graph/#person",
          name: "Anna",
          image: { [MEDIA_PLACEHOLDER_KEY]: "m1" },
          dateModified: { [LIVE_PLACEHOLDER_KEY]: "modified" },
          worksFor: { "@id": "https://blog.example/#organization" },
        },
      ],
    };
    const { graph, refusals } = buildPageGraph(core, [part], (id) =>
      id === "m1" ? "https://blog.example/_assets/anna.abc.jpg" : null,
    );
    expect(refusals).toEqual([]);
    const page = graph["@graph"].find((n) => n["@id"] === core.canonical);
    expect(page?.["@type"]).toBe("ProfilePage");
    expect(page?.mainEntity).toEqual({ "@id": "https://blog.example/articles/graph/#person" });
    expect(graph["@graph"].at(-1)).toEqual({
      "@type": "Person",
      "@id": "https://blog.example/articles/graph/#person",
      name: "Anna",
      image: "https://blog.example/_assets/anna.abc.jpg",
      dateModified: "2026-11-20T12:00:00.000Z",
      worksFor: { "@id": "https://blog.example/#organization" },
    });
  });

  it("leaves out a live date the page does not have, without a refusal", () => {
    const { graph, refusals } = buildPageGraph(
      { ...core, liveDates: null },
      [
        {
          plugin: "seo",
          webPage: {},
          nodes: [
            {
              "@type": "Article",
              "@id": "https://blog.example/articles/graph/#article",
              datePublished: { [LIVE_PLACEHOLDER_KEY]: "published" },
            },
          ],
        },
      ],
      noMedia,
    );
    expect(refusals).toEqual([]);
    expect(graph["@graph"].at(-1)).toEqual({
      "@type": "Article",
      "@id": "https://blog.example/articles/graph/#article",
    });
  });

  it("keeps one owner per id and per WebPage property, and refuses dangling references", () => {
    const node = (extra: Record<string, unknown> = {}) => ({
      "@type": "Thing",
      "@id": "https://blog.example/articles/graph/#thing",
      ...extra,
    });
    const { graph, refusals } = buildPageGraph(
      { ...core, organization: {} },
      [
        {
          plugin: "a",
          webPageType: "CollectionPage",
          webPage: { about: { "@id": "https://blog.example/articles/graph/#thing" } },
          nodes: [node({ publisher: { "@id": "https://blog.example/#organization" } })],
        },
        {
          plugin: "b",
          webPageType: "ProfilePage",
          webPage: { about: "something else" },
          nodes: [
            node(),
            { "@type": "Thing", "@id": "https://blog.example/#website" },
            {
              "@type": "Thing",
              "@id": "https://blog.example/x/#y",
              image: { [MEDIA_PLACEHOLDER_KEY]: "gone" },
            },
          ],
        },
      ],
      noMedia,
    );
    expect(refusals).toEqual([
      { plugin: "b", field: "webpage", rule: "webpage-type-conflict" },
      { plugin: "b", field: "about", rule: "webpage-property-conflict" },
      { plugin: "b", field: "id", rule: "id-taken" },
      { plugin: "b", field: "id", rule: "id-reserved" },
      { plugin: "b", field: "image", rule: "media-unpublishable" },
      // No Organization on this site: the reference would dangle.
      { plugin: "a", field: "publisher", rule: "ref-dangling" },
    ]);
    const page = graph["@graph"].find((n) => n["@id"] === core.canonical);
    expect(page?.["@type"]).toBe("CollectionPage");
    expect(page?.about).toEqual({ "@id": "https://blog.example/articles/graph/#thing" });
    expect(graph["@graph"].slice(-2)).toEqual([
      { "@type": "Thing", "@id": "https://blog.example/articles/graph/#thing" },
      { "@type": "Thing", "@id": "https://blog.example/x/#y" },
    ]);
  });

  it("uses relative ids in a preview without a base URL", () => {
    const { graph } = buildPageGraph(
      { ...core, siteBaseUrl: null, canonical: null, breadcrumbs: [] },
      [],
      noMedia,
    );
    expect(graph["@graph"].map((n) => n["@id"])).toEqual([
      "/#organization",
      "/#website",
      "#webpage",
    ]);
  });
});

describe("jsonLdIntegrityProblems (#1753)", () => {
  const ok = buildPageGraph(core, [], noMedia).graph;

  it("finds nothing wrong with core's graph", () => {
    expect(jsonLdIntegrityProblems([{ kind: "parsed", data: ok }])).toEqual([]);
  });

  it("reads a dangling reference, a duplicate node, invalid JSON and extra blocks", () => {
    const extra = {
      "@context": "https://schema.org",
      "@type": "Article",
      "@id": "https://blog.example/articles/graph/#article",
      author: { "@id": "https://blog.example/team/ben/#person" },
    };
    const twice = { "@type": "WebSite", "@id": "https://blog.example/#website", name: "Again" };
    expect(
      jsonLdIntegrityProblems([
        { kind: "parsed", data: ok },
        { kind: "parsed", data: extra },
        { kind: "parsed", data: twice },
        { kind: "invalid", error: "Unexpected token" },
      ]),
    ).toEqual([
      { rule: "invalid-json", detail: "Unexpected token" },
      { rule: "extra-block", count: 3 },
      { rule: "dangling-id", ids: ["https://blog.example/team/ben/#person"] },
      { rule: "duplicate-id", ids: ["https://blog.example/#website"] },
    ]);
  });

  it("reports a page without a graph and one it could not read", () => {
    expect(jsonLdIntegrityProblems([])).toEqual([{ rule: "graph-missing" }]);
    expect(jsonLdIntegrityProblems([{ kind: "omitted", chars: 70_000 }])).toEqual([
      { rule: "not-checked", chars: 70_000 },
    ]);
  });
});

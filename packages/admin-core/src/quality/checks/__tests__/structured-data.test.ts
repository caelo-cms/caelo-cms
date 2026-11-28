// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { buildPageGraph, renderJsonLdScript } from "@caelo-cms/shared";
import type { StagedBuild, StagedPage } from "../check.js";
import { evaluateCheckFindings } from "../evaluate.js";
import { createStructuredDataCheck } from "../structured-data.js";

const BASE = "https://blog.example";
const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const MODULE_ID = "22222222-2222-4222-8222-222222222222";

const graph = renderJsonLdScript(
  buildPageGraph(
    {
      siteBaseUrl: BASE,
      canonical: `${BASE}/a/`,
      siteName: "Blog",
      siteLanguage: "en",
      pageLanguage: "en",
      pageTitle: "A",
      description: "",
      imageUrl: null,
      organization: { name: "Example" },
      breadcrumbs: [],
      liveDates: null,
    },
    [],
    () => null,
  ).graph,
);

const build: StagedBuild = {
  baseUrl: BASE,
  probe: async () => ({ found: true, status: 200 }),
  text: async () => null,
};

function page(head: string, body = ""): StagedPage {
  return {
    pageId: PAGE_ID,
    path: "/a",
    url: `${BASE}/a/`,
    html: `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
  };
}

const run = (p: StagedPage) => createStructuredDataCheck().run({ pages: [p], build });

describe("the core structured-data check (#1753)", () => {
  it("finds nothing wrong with core's graph", async () => {
    expect(await run(page(graph))).toEqual([]);
  });

  it("blocks Publish live on a dangling @id, naming the module that carries it", async () => {
    const module = `<div data-caelo-module-id="${MODULE_ID}"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","@id":"${BASE}/a/#article","author":{"@id":"${BASE}/team/ben/#person"}}</script></div>`;
    const findings = await run(page(graph, module));
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ["structured-data/extra-block", "warning"],
      ["structured-data/dangling-id", "error"],
    ]);
    const dangling = findings.find((f) => f.ruleId === "structured-data/dangling-id");
    expect(dangling?.message).toContain(`${BASE}/team/ben/#person`);
    expect(dangling?.message).toContain(MODULE_ID);
    expect(dangling?.fix?.tool).toBe("update_modules_many");
    // An error is a problem of the gate: Publish live refuses until it is fixed or accepted.
    const problems = evaluateCheckFindings(findings, new Map());
    expect(problems.map((p) => [p.ruleId, p.count, p.allowed])).toEqual([
      ["structured-data/dangling-id", 1, 0],
    ]);
  });

  it("reports invalid JSON, a node defined twice and a page without core's graph", async () => {
    const twice = `<script type="application/ld+json">{"@type":"WebSite","@id":"${BASE}/#website","name":"Again"}</script>`;
    const broken = `<script type="application/ld+json">{"@type": "FAQPage",}</script>`;
    const rules = (await run(page(graph, twice + broken))).map((f) => f.ruleId).sort();
    expect(rules).toEqual([
      "structured-data/duplicate-id",
      "structured-data/extra-block",
      "structured-data/invalid-json",
    ]);
    const missing = await run(page("<title>x</title>"));
    expect(missing.map((f) => [f.ruleId, f.severity])).toEqual([
      ["structured-data/graph-missing", "error"],
    ]);
  });

  it("skips a page staging answered with another document", async () => {
    expect(
      await createStructuredDataCheck().run({
        pages: [{ ...page("<title>x</title>"), redirectedTo: "/b" }],
        build,
      }),
    ).toEqual([]);
  });
});

// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PageCheck, SiteCheck, StagedPage } from "../check.js";
import { fetchStagedPages } from "../fetch-pages.js";
import {
  checkIdOfRule,
  checkIdSchema,
  type Finding,
  findingLabel,
  findingSchema,
  ruleIdSchema,
} from "../findings.js";
import { CheckRegistry, createCoreCheckRegistry, LIGHTHOUSE_CHECK_ID } from "../registry.js";
import { runFindingChecks } from "../runner.js";
import {
  metaDescriptions,
  NO_PROBE_BUILD,
  PLACEHOLDER_RULE,
  placeholderDescriptionCheck,
} from "./fixtures/test-checks.js";

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";

function page(pageId: string, path: string, html: string): StagedPage {
  return { pageId, path, url: `http://s.test${path}`, html };
}

const CORE = { kind: "core" } as const;

describe("findings shape", () => {
  it("rule ids are '<checkId>/<rule>' and never collide with Lighthouse audit ids", () => {
    expect(ruleIdSchema.safeParse("seo-check/title-missing").success).toBe(true);
    expect(ruleIdSchema.safeParse("seo-check.titles/too-long").success).toBe(true);
    for (const bad of ["image-alt", "Page/x", "a/b/c", "a/", "/b"]) {
      expect(ruleIdSchema.safeParse(bad).success).toBe(false);
    }
    expect(checkIdOfRule("seo-check.titles/too-long")).toBe("seo-check.titles");
  });

  it("check ids are kebab words with at most one dot namespace", () => {
    expect(checkIdSchema.safeParse("seo-check").success).toBe(true);
    expect(checkIdSchema.safeParse("seo-check.links").success).toBe(true);
    expect(checkIdSchema.safeParse("a.b.c").success).toBe(false);
    expect(checkIdSchema.safeParse("Upper").success).toBe(false);
  });

  it("a finding is strict: severity, uuid page, message, optional fix", () => {
    const ok: Finding = {
      ruleId: "x/y",
      severity: "warning",
      pageId: P1,
      message: "Label: detail",
      fix: { tool: "edit_module", hint: "do it" },
    };
    expect(findingSchema.safeParse(ok).success).toBe(true);
    expect(findingSchema.safeParse({ ...ok, severity: "fatal" }).success).toBe(false);
    expect(findingSchema.safeParse({ ...ok, pageId: "nope" }).success).toBe(false);
    expect(findingSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("the label is the text before the first colon, bounded", () => {
    expect(findingLabel("No meta description: search engines …")).toBe("No meta description");
    expect(findingLabel("plain")).toBe("plain");
    expect(findingLabel("x".repeat(200)).length).toBe(80);
  });
});

describe("CheckRegistry", () => {
  const check: PageCheck = { id: "demo", title: "Demo", scope: "page", run: () => [] };

  it("core registers Lighthouse and its structure (#820) and links (#849) checks", () => {
    const r = createCoreCheckRegistry({
      lighthouse: async () => ({ ok: true, pages: [], pageErrors: [] }),
      structure: { modules: async () => [], layouts: async () => [] },
      links: {
        modules: async () => [],
        layouts: async () => [],
        redirects: async () => [],
        siteUrls: async () => [],
        reportedDraftLinks: async () => [],
      },
      references: { issues: async () => ({ issues: [], truncated: false }) },
    });
    expect(r.list().map((e) => [e.id, e.kind])).toEqual([
      [LIGHTHOUSE_CHECK_ID, "lighthouse"],
      ["structure", "findings"],
      ["links", "findings"],
      ["references", "findings"],
    ]);
    expect(r.findingChecks().map((e) => [e.id, e.scope, e.source])).toEqual([
      ["structure", "site", { kind: "core" }],
      ["links", "site", { kind: "core" }],
      ["references", "site", { kind: "core" }],
    ]);
    expect(r.lighthouse()?.id).toBe("lighthouse");
  });

  it("accepts plugin-contributed checks next to core's", () => {
    const r = new CheckRegistry();
    r.register(check, { kind: "plugin", slug: "seo-check" });
    expect(r.findingChecks()[0]).toMatchObject({
      id: "demo",
      source: { kind: "plugin", slug: "seo-check" },
    });
    expect(r.lighthouse()).toBeNull();
  });

  it("refuses duplicate, reserved and malformed ids", () => {
    const r = new CheckRegistry();
    r.register(check, CORE);
    expect(() => r.register(check, CORE)).toThrow("already registered");
    expect(() => r.register({ ...check, id: "lighthouse" }, CORE)).toThrow("already registered");
    expect(() => r.register({ ...check, id: "Bad Id" }, CORE)).toThrow("invalid");
    r.registerLighthouse(async () => ({ ok: true, pages: [], pageErrors: [] }));
    expect(() =>
      r.registerLighthouse(async () => ({ ok: true, pages: [], pageErrors: [] })),
    ).toThrow();
  });
});

describe("runFindingChecks", () => {
  const pages = [page(P1, "/", "<html></html>"), page(P2, "/about", "<html></html>")];
  const entry = (c: PageCheck | SiteCheck) => {
    const r = new CheckRegistry();
    r.register(c, CORE);
    return r.findingChecks();
  };

  it("runs a page check once per page and stamps each finding with its page", async () => {
    const seen: string[] = [];
    const r = await runFindingChecks(
      entry({
        id: "pc",
        title: "pc",
        scope: "page",
        run: ({ page: p }) => {
          seen.push(p.path);
          return [{ ruleId: "pc/x", severity: "error", message: "X: y" }];
        },
      }),
      pages,
      NO_PROBE_BUILD,
    );
    expect(seen).toEqual(["/", "/about"]);
    expect(r.errors).toEqual([]);
    expect(r.findings.map((f) => f.pageId)).toEqual([P1, P2]);
  });

  it("runs a site check once with every page; page-less findings stay site-wide", async () => {
    let calls = 0;
    const r = await runFindingChecks(
      entry({
        id: "sc",
        title: "sc",
        scope: "site",
        run: ({ pages: all }) => {
          calls += 1;
          return [
            { ruleId: "sc/dup", severity: "warning", pageId: all[1]?.pageId, message: "Dup: x" },
            { ruleId: "sc/robots", severity: "error", message: "Robots: x" },
          ];
        },
      }),
      pages,
      NO_PROBE_BUILD,
    );
    expect(calls).toBe(1);
    expect(r.findings.map((f) => f.pageId)).toEqual([P2, undefined]);
  });

  it("a throwing, malformed or foreign-rule check is an error, never silent", async () => {
    const throwing = await runFindingChecks(
      entry({
        id: "t",
        title: "t",
        scope: "site",
        run: () => {
          throw new Error("boom");
        },
      }),
      pages,
      NO_PROBE_BUILD,
    );
    expect(throwing.errors[0]?.message).toContain("check 't' failed: boom");

    const malformed = await runFindingChecks(
      entry({
        id: "m",
        title: "m",
        scope: "site",
        run: () => [{ ruleId: "m/x", severity: "bad", message: "x" } as unknown as Finding],
      }),
      pages,
      NO_PROBE_BUILD,
    );
    expect(malformed.errors[0]?.message).toContain("invalid finding (severity");

    const foreign = await runFindingChecks(
      entry({
        id: "f",
        title: "f",
        scope: "site",
        run: () => [{ ruleId: "other/x", severity: "info", message: "x" }],
      }),
      pages,
      NO_PROBE_BUILD,
    );
    expect(foreign.errors[0]?.message).toContain("does not belong to check 'f'");

    const notArray = await runFindingChecks(
      entry({ id: "n", title: "n", scope: "site", run: () => ({}) as unknown as Finding[] }),
      pages,
      NO_PROBE_BUILD,
    );
    expect(notArray.errors[0]?.message).toContain("did not return an array");
  });

  it("a page check may not report another page; a site check only pages of the build", async () => {
    const other = await runFindingChecks(
      entry({
        id: "o",
        title: "o",
        scope: "page",
        run: () => [{ ruleId: "o/x", severity: "error", pageId: P2, message: "x" }],
      }),
      [pages[0] as StagedPage],
      NO_PROBE_BUILD,
    );
    expect(other.errors[0]).toMatchObject({ checkId: "o", pageId: P1 });
    const unknown = await runFindingChecks(
      entry({
        id: "u",
        title: "u",
        scope: "site",
        run: () => [
          {
            ruleId: "u/x",
            severity: "error",
            pageId: "00000000-0000-4000-8000-0000000000ff",
            message: "x",
          },
        ],
      }),
      pages,
      NO_PROBE_BUILD,
    );
    expect(unknown.errors[0]?.message).toContain("not a page of the staged build");
  });
});

describe("the test-only placeholder check (proves the framework)", () => {
  it("reads <meta name=description> in <head> only, decoding entities", () => {
    expect(
      metaDescriptions(
        '<html><head><META NAME="Description" content="A &amp; B"></head><body><meta name="description" content="body"></body></html>',
      ),
    ).toEqual(["A & B"]);
    expect(metaDescriptions("<html><head><meta name=description></head></html>")).toEqual([null]);
  });

  it("a real description passes; a TODO placeholder is an error with a fix", async () => {
    const run = (html: string) => placeholderDescriptionCheck.run({ page: page(P1, "/", html) });
    expect(await run('<head><meta name="description" content="Hello"></head>')).toEqual([]);
    const placeholder = await run('<head><meta name="description" content="TODO"></head>');
    expect(placeholder).toEqual([
      expect.objectContaining({
        ruleId: PLACEHOLDER_RULE,
        severity: "error",
        pageId: P1,
        fix: expect.objectContaining({ tool: "set_page_seo_many" }),
      }),
    ]);
    expect(findingLabel((placeholder[0] as Finding).message)).toBe("Placeholder meta description");
  });
});

describe("fetchStagedPages", () => {
  it("keeps the order and turns a bad status or a network failure into an error", async () => {
    const fetcher = (async (url: string) => {
      if (url.endsWith("/gone/")) return new Response("nope", { status: 404 });
      if (url.endsWith("/down/")) throw new Error("ECONNREFUSED");
      return new Response(`<p>${url}</p>`);
    }) as unknown as typeof fetch;
    const r = await fetchStagedPages(
      [
        { pageId: P1, path: "/", url: "http://s/" },
        { pageId: P2, path: "/gone", url: "http://s/gone/" },
        { pageId: "00000000-0000-4000-8000-000000000003", path: "/down", url: "http://s/down/" },
      ],
      fetcher,
    );
    expect(r.pages.map((p) => p.path)).toEqual(["/"]);
    expect(r.errors.map((e) => e.code)).toEqual(["page-status", "page-unreachable"]);
    expect(r.errors[0]?.message).toContain("staging answered 404 for /gone");
  });

  it("fetches at most six pages at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetcher = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(2);
      inFlight -= 1;
      return new Response("<p></p>");
    }) as unknown as typeof fetch;
    const many = Array.from({ length: 20 }, (_, i) => ({
      pageId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      path: `/${i}`,
      url: `http://s/${i}/`,
    }));
    const r = await fetchStagedPages(many, fetcher);
    expect(r.pages).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(6);
  });
});

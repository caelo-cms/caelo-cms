// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  buildLinkNotice,
  languageName,
  linksTheCheckMissed,
  type NoticePage,
  withBuiltLinks,
} from "./link-notice.js";
import type { ReferenceIssue, ReferenceProblem } from "./reference-integrity.js";

const EN_HOME = "00000000-0000-4000-8000-000000000001";
const PRICING = "00000000-0000-4000-8000-000000000002";
const DEMO = "00000000-0000-4000-8000-000000000003";

const pages = new Map<string, NoticePage>([
  [EN_HOME, { title: "Home", path: "/en" }],
  [PRICING, { title: "Pricing", path: "/preise" }],
  [DEMO, { title: "Demo", path: "/demo" }],
]);

function issue(over: Partial<ReferenceIssue> & { problem: ReferenceProblem }): ReferenceIssue {
  return {
    severity: "block",
    target: `"/preise"`,
    targetPageId: PRICING,
    variant: "en",
    where: "values.cta",
    place: { kind: "module-html", moduleId: "m", moduleName: "split-mit-ki-chat-13-mv5dt13m" },
    pageIds: [EN_HOME],
    shipped: true,
    area: "a page section",
    message: "for the AI",
    fix: { tool: "edit_content", hint: "for the AI" },
    ...over,
  };
}

describe("languageName", () => {
  it("names a language, and keeps a token that is no language", () => {
    expect(languageName("en")).toBe("English");
    expect(languageName("pt-BR")).toBe("Brazilian Portuguese");
    expect(languageName("not a tag")).toBe("not a tag");
  });
});

describe("buildLinkNotice", () => {
  it("says nothing when there is nothing to say", () => {
    expect(buildLinkNotice([], pages)).toBeNull();
  });

  it("groups by target page and names places, not slugs or ids", () => {
    const notice = buildLinkNotice(
      [
        issue({ problem: "variant-missing", area: "the header" }),
        issue({ problem: "variant-missing", area: "the footer" }),
        issue({ problem: "variant-missing", targetPageId: DEMO, area: "the cookie banner" }),
      ],
      pages,
    );
    expect(notice?.targets).toHaveLength(2);
    expect(notice?.operatorText).toBe(
      "2 pages linked from your English pages have no English version yet: " +
        "Pricing (/preise), linked from the footer and the header of /en; " +
        "Demo (/demo), linked from the cookie banner of /en. " +
        "Publish live stays blocked until each has a version in English or the link is changed, and the site is staged again.",
    );
    expect(notice?.fixLabel).toBe("Create English versions");
    expect(notice?.fixPrompt).toContain("Pricing (/preise) and Demo (/demo)");
    expect(notice?.linkingPages).toEqual([{ id: EN_HOME, path: "/en" }]);
  });

  it("gives the AI the operator's list plus the tools, and the operator no tools", () => {
    const notice = buildLinkNotice([issue({ problem: "variant-missing" })], pages);
    expect(notice?.aiText.startsWith(notice?.operatorText ?? "?")).toBe(true);
    expect(notice?.aiText).toContain("create_variant");
    expect(notice?.operatorText).not.toMatch(/create_variant|check_links|split-mit/);
  });

  it("names a deleted target without its id, and a draft as a draft", () => {
    const notice = buildLinkNotice(
      [
        issue({
          problem: "missing-target",
          target: `a deleted page (${PRICING})`,
          targetPageId: null,
          variant: null,
        }),
        issue({ problem: "unpublished-target", targetPageId: DEMO, variant: null }),
      ],
      pages,
    );
    expect(notice?.operatorText).toContain("a deleted page — linked from a page section of /en");
    expect(notice?.operatorText).toContain("Demo (/demo) is a draft");
    expect(notice?.operatorText).not.toContain(PRICING);
    expect(notice?.fixLabel).toBe("Fix these links");
  });
});

describe("a Stage's notice covers what the build rendered", () => {
  const built = {
    pageId: EN_HOME,
    pagePath: "/en",
    targetPageId: DEMO,
    targetUrl: "/demo/",
    variant: "en",
  };

  it("finds only links the check did not report", () => {
    const notice = buildLinkNotice([issue({ problem: "variant-missing" })], pages);
    expect(linksTheCheckMissed(notice, [{ ...built, targetPageId: PRICING }])).toEqual([]);
    expect(linksTheCheckMissed(notice, [built])).toEqual([built]);
    expect(
      linksTheCheckMissed(notice, [{ ...built, targetPageId: PRICING, variant: "fr" }]),
    ).toHaveLength(1);
  });

  it("adds a missed link, so Publish live refuses it too", () => {
    const merged = withBuiltLinks(null, [built]);
    expect(merged?.targets.map((t) => t.pageId)).toEqual([DEMO]);
    expect(merged?.linkingPages).toEqual([{ id: EN_HOME, path: "/en" }]);
    expect(merged?.operatorText).toContain("/demo/");
  });

  it("changes nothing when the check saw everything", () => {
    const notice = buildLinkNotice([issue({ problem: "variant-missing" })], pages);
    expect(withBuiltLinks(notice, [])).toBe(notice);
  });
});

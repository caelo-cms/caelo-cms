// SPDX-License-Identifier: MPL-2.0

/**
 * #1706 — the Owner's robots.txt rules: only Allow / Disallow paths per
 * user agent reach the file, and nothing a value holds can add a line, a
 * comment or a directive of its own.
 */

import { describe, expect, it } from "bun:test";
import {
  parseRobotsRulesText,
  robotsRulesSchema,
  robotsRulesText,
  robotsRulesWarnings,
  robotsTxt,
} from "./robots-rules.js";

const ok = (rules: unknown) => robotsRulesSchema.safeParse(rules).success;
const why = (rules: unknown) => {
  const r = robotsRulesSchema.safeParse(rules);
  return r.success ? "" : r.error.issues.map((i) => i.message).join("; ");
};

describe("robots rules", () => {
  it("takes the search results pages of two languages and an AI crawler", () => {
    expect(
      ok([
        { userAgents: ["*"], disallow: ["/de/suche/", "/en/search/", "/*?q="] },
        { userAgents: ["GPTBot"], allow: ["/blog/"], disallow: ["/"] },
      ]),
    ).toBe(true);
    // allow / disallow may be left out.
    expect(robotsRulesSchema.parse([{ userAgents: ["*"], disallow: ["/x"] }])[0]?.allow).toEqual(
      [],
    );
  });

  it("refuses anything that would write a line of its own", () => {
    expect(why([{ userAgents: ["*"], disallow: ["/a\nAllow: /secret"] }])).toContain(
      "no spaces or line breaks",
    );
    expect(
      why([{ userAgents: ["*"], disallow: ["/a\r\nSitemap: https://evil.example/s.xml"] }]),
    ).toContain("no spaces or line breaks");
    expect(ok([{ userAgents: ["*"], disallow: ["/a b"] }])).toBe(false);
    expect(ok([{ userAgents: ["*"], disallow: ["/a\u0000b"] }])).toBe(false);
    expect(why([{ userAgents: ["*"], disallow: ["/a # note"] }])).toContain("no spaces");
    expect(why([{ userAgents: ["*"], disallow: ["/a#note"] }])).toContain("`#`");
    expect(why([{ userAgents: ["Googlebot\nDisallow: /"], disallow: ["/x"] }])).toContain(
      "product token",
    );
    expect(ok([{ userAgents: ["Google bot"], disallow: ["/x"] }])).toBe(false);
  });

  it("refuses paths of other sites and unknown fields", () => {
    expect(why([{ userAgents: ["*"], disallow: ["de/suche/"] }])).toContain("starts with `/`");
    expect(ok([{ userAgents: ["*"], disallow: ["https://example.com/x"] }])).toBe(false);
    expect(ok([{ userAgents: ["*"], disallow: ["/x"], crawlDelay: 10 }])).toBe(false);
    expect(ok([{ userAgents: ["*"], noindex: ["/x"] }])).toBe(false);
  });

  it("wants each crawler in one group and `*` alone", () => {
    expect(why([{ userAgents: ["*"] }])).toContain("at least one allow or disallow");
    expect(why([{ userAgents: ["*", "GPTBot"], disallow: ["/x"] }])).toContain("stands alone");
    expect(
      why([
        { userAgents: ["GPTBot"], disallow: ["/x"] },
        { userAgents: ["gptbot"], disallow: ["/y"] },
      ]),
    ).toContain("two groups");
  });

  it("says what a rule set takes away from search engines", () => {
    const rules = robotsRulesSchema.parse([
      { userAgents: ["*"], disallow: ["/"] },
      { userAgents: ["GPTBot"], disallow: ["/*"], allow: ["/press/"] },
      { userAgents: ["CCBot"], disallow: ["/de/suche/"] },
    ]);
    const warnings = robotsRulesWarnings(rules);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("every crawler may crawl nothing");
    expect(warnings[1]).toContain("GPTBot may crawl only /press/");
    expect(robotsRulesWarnings(robotsRulesSchema.parse([]))).toEqual([]);
  });

  it("reads the settings field back into the rules it shows", () => {
    const rules = robotsRulesSchema.parse([
      { userAgents: ["*"], disallow: ["/de/suche/", "/en/search/"] },
      { userAgents: ["GPTBot", "CCBot"], allow: ["/press/"], disallow: ["/"] },
    ]);
    const text = robotsRulesText(rules);
    expect(text).toBe(
      "User-agent: *\nDisallow: /de/suche/\nDisallow: /en/search/\n\nUser-agent: GPTBot\nUser-agent: CCBot\nAllow: /press/\nDisallow: /",
    );
    expect(parseRobotsRulesText(text)).toEqual({ ok: true, rules });
    // Case and spacing as people type them; a blank line ends nothing.
    expect(parseRobotsRulesText("user-agent:*\r\ndisallow : /x\n\n\nDISALLOW: /y")).toEqual({
      ok: true,
      rules: [{ userAgents: ["*"], allow: [], disallow: ["/x", "/y"] }],
    });
    expect(parseRobotsRulesText("")).toEqual({ ok: true, rules: [] });
  });

  it("refuses lines that are no rules, with their line number", () => {
    expect(parseRobotsRulesText("User-agent: *\nSitemap: https://x.example/s.xml")).toMatchObject({
      ok: false,
      message: expect.stringContaining("line 2: only User-agent, Allow and Disallow"),
    });
    expect(parseRobotsRulesText("# comment\nUser-agent: *")).toMatchObject({ ok: false });
    expect(parseRobotsRulesText("Disallow: /x")).toMatchObject({
      ok: false,
      message: expect.stringContaining("before any User-agent"),
    });
    expect(parseRobotsRulesText("User-agent: *\nDisallow:")).toMatchObject({
      ok: false,
      message: expect.stringContaining("names nothing"),
    });
    expect(parseRobotsRulesText("User-agent: *\nDisallow: /a b")).toMatchObject({
      ok: false,
      message: expect.stringContaining("no spaces"),
    });
  });

  it("renders no rules as the site always had it", () => {
    expect(
      robotsTxt({
        robots: "index",
        siteBaseUrl: "https://example.com/",
        sitemap: true,
        feed: true,
        rules: [],
      }),
    ).toBe(
      "User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\nSitemap: https://example.com/feed.xml\n",
    );
  });
});

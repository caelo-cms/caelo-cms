// SPDX-License-Identifier: MPL-2.0

/**
 * #1706 — the Owner's robots.txt rules: only Allow / Disallow paths per
 * user agent reach the file, and nothing a value holds can add a line, a
 * comment or a directive of its own.
 */

import { describe, expect, it } from "bun:test";
import {
  contentSignalText,
  parseRobotsRulesText,
  robotsRulesNotes,
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
      message: expect.stringContaining(
        "line 2: only User-agent, Content-Signal, Allow and Disallow",
      ),
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

  it("#1758 — writes the training preference group and Content-Signal lines", () => {
    const rules = robotsRulesSchema.parse([
      { userAgents: ["*"], allow: ["/"], contentSignal: { search: true, aiTrain: false } },
      { userAgents: ["__USAGE_AI-Training"], disallow: ["/"], allow: ["/press/"] },
      { userAgents: ["GPTBot", "CCBot"], disallow: ["/"] },
    ]);
    // The token is stored as the draft spells it.
    expect(rules[1]?.userAgents).toEqual(["__usage_ai-training"]);
    expect(
      robotsTxt({
        robots: "index",
        siteBaseUrl: "https://example.com",
        sitemap: true,
        feed: false,
        rules,
      }),
    ).toBe(
      [
        "User-agent: *",
        "Content-Signal: search=yes, ai-train=no",
        "Allow: /",
        "",
        "User-agent: __usage_ai-training",
        "Allow: /press/",
        "Disallow: /",
        "",
        "User-agent: GPTBot",
        "User-agent: CCBot",
        "Disallow: /",
        "",
        "Sitemap: https://example.com/sitemap.xml",
        "",
      ].join("\n"),
    );
    // Keys always in one order, whichever order they were given in.
    expect(contentSignalText({ aiTrain: true, aiInput: false, search: false })).toBe(
      "search=no, ai-input=no, ai-train=yes",
    );
    // Staging keeps every crawler out, preference or not.
    expect(
      robotsTxt({
        robots: "noindex",
        siteBaseUrl: "https://x.example",
        sitemap: true,
        feed: true,
        rules,
      }),
    ).toBe("User-agent: *\nDisallow: /\n");
  });

  it("#1758 — refuses preference tokens and signals that are not what they claim", () => {
    // An unknown `__usage_` token would read as a crawler nobody runs.
    expect(why([{ userAgents: ["__usage_ai-search"], disallow: ["/"] }])).toContain(
      "no usage preference",
    );
    expect(ok([{ userAgents: ["__anything"], disallow: ["/"] }])).toBe(false);
    // The token stands alone and carries no Content-Signal.
    expect(why([{ userAgents: ["__usage_ai-training", "GPTBot"], disallow: ["/"] }])).toContain(
      "stands alone",
    );
    expect(
      why([
        { userAgents: ["__usage_ai-training"], disallow: ["/"], contentSignal: { aiTrain: false } },
      ]),
    ).toContain("takes no Content-Signal");
    // A group of only a Content-Signal would swallow the next group's agents.
    expect(why([{ userAgents: ["*"], contentSignal: { aiTrain: false } }])).toContain(
      "at least one allow or disallow",
    );
    // Booleans only: no text can ride a signal into the file.
    expect(
      ok([{ userAgents: ["*"], allow: ["/"], contentSignal: { aiTrain: "no\nDisallow: /" } }]),
    ).toBe(false);
    expect(
      ok([{ userAgents: ["*"], allow: ["/"], contentSignal: { aiTrain: false, x: true } }]),
    ).toBe(false);
    expect(why([{ userAgents: ["*"], allow: ["/"], contentSignal: {} }])).toContain(
      "at least one of",
    );
    // The token is named in one group only, whatever its case.
    expect(
      why([
        { userAgents: ["__usage_ai-training"], disallow: ["/"] },
        { userAgents: ["__USAGE_AI-TRAINING"], allow: ["/"] },
      ]),
    ).toContain("two groups");
  });

  it("#1758 — reads Content-Signal lines back from the settings field, strictly", () => {
    const rules = robotsRulesSchema.parse([
      {
        userAgents: ["*"],
        allow: ["/"],
        contentSignal: { search: true, aiInput: true, aiTrain: false },
      },
      { userAgents: ["__usage_ai-training"], disallow: ["/"] },
    ]);
    const text = robotsRulesText(rules);
    expect(text).toBe(
      "User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nAllow: /\n\nUser-agent: __usage_ai-training\nDisallow: /",
    );
    expect(parseRobotsRulesText(text)).toEqual({ ok: true, rules });
    // Spelling as people type it.
    expect(parseRobotsRulesText("User-agent: *\ncontent-signal:AI-TRAIN = No\nAllow: /")).toEqual({
      ok: true,
      rules: [{ userAgents: ["*"], allow: ["/"], disallow: [], contentSignal: { aiTrain: false } }],
    });
    const refused = (t: string) => {
      const r = parseRobotsRulesText(t);
      return r.ok ? "" : r.message;
    };
    expect(refused("User-agent: *\nContent-Signal: ai-train=maybe\nAllow: /")).toContain(
      "`yes` or `no`",
    );
    expect(refused("User-agent: *\nContent-Signal: train=no\nAllow: /")).toContain(
      "only search, ai-input and ai-train",
    );
    expect(refused("User-agent: *\nContent-Signal: search=yes, search=no\nAllow: /")).toContain(
      "twice",
    );
    expect(
      refused("User-agent: *\nContent-Signal: search=yes\nContent-Signal: ai-train=no\nAllow: /"),
    ).toContain("line 3: a group takes one Content-Signal");
    expect(refused("Content-Signal: search=yes")).toContain("before any User-agent");
    expect(refused("User-agent: *\nContent-Signal: search=yes # note\nAllow: /")).toContain(
      "`yes` or `no`",
    );
    // A User-agent after a Content-Signal starts a new group, so the first
    // group is left without a path and refused, as a parser would merge it.
    expect(
      refused("User-agent: *\nContent-Signal: ai-train=no\nUser-agent: GPTBot\nDisallow: /"),
    ).toContain("at least one allow or disallow");
    // Any other directive is still no line of the field.
    expect(refused("User-agent: *\nCrawl-delay: 10")).toContain("line 2: only User-agent");
    expect(refused("User-agent: *\nContent-Usage: train-ai=n")).toContain("line 2: only");
  });

  it("#1758 — notes and warnings for the preference lines", () => {
    const rules = robotsRulesSchema.parse([
      { userAgents: ["*"], allow: ["/"], contentSignal: { search: false } },
      { userAgents: ["__usage_ai-training"], disallow: ["/"] },
    ]);
    const warnings = robotsRulesWarnings(rules);
    // search=no for everyone takes the site out of search; the preference
    // group's `Disallow: /` takes nothing away from search engines.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("search=no");
    const notes = robotsRulesNotes(rules);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("keeps no crawler out");
    expect(notes[1]).toContain("Content-Signal");
    expect(
      robotsRulesNotes(robotsRulesSchema.parse([{ userAgents: ["GPTBot"], disallow: ["/"] }])),
    ).toEqual([]);
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

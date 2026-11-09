// SPDX-License-Identifier: MPL-2.0

/**
 * #1511 — the write hints say what the runtime will not bind to, and the
 * section the skill teaches gets none: skill, runtime and hints describe
 * one contract.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1, PluginWrite } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";
import { COMMENTS_SKILLS } from "./skills.js";
import { commentsModuleHints, writeHints } from "./write-hints.js";

/** The section markup of the skill, as the AI would store it. */
const SKILL_SECTION = (COMMENTS_SKILLS[0]?.body ?? "")
  .split("\n")
  .filter((l) => l.startsWith("   <"))
  .map((l) => l.trim())
  .join("");

const PAGE = "11111111-1111-4111-8111-111111111111";

const module = (html: string): PluginWrite => ({
  kind: "module",
  moduleId: null,
  html,
  fields: [],
});

describe("comments write hints (#1511)", () => {
  it("has nothing to say about the section the skill teaches", () => {
    expect(SKILL_SECTION).toContain('data-page-id="{{page.id}}"');
    expect(commentsModuleHints(SKILL_SECTION)).toEqual([]);
  });

  it("ignores modules without the comments placeholder", () => {
    expect(writeHints([module("<section><h2>Hello</h2></section>")])).toEqual([]);
    expect(writeHints([{ kind: "values", moduleId: null, values: { x: 1 } }])).toEqual([]);
  });

  it("points a page-bound placeholder at {{page.id}}, so one module serves many pages", () => {
    const html = SKILL_SECTION.replace("{{page.id}}", PAGE);
    const hints = commentsModuleHints(html);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("{{page.id}}");
    expect(hints[0]).toContain("add_module target 'template'");
  });

  it("names the placeholder shape the build matches", () => {
    const html = SKILL_SECTION.replace(
      '<div data-caelo-plugin="comments" data-page-id="{{page.id}}">',
      '<div class="c" data-caelo-plugin="comments" data-page-id="{{page.id}}">',
    );
    expect(commentsModuleHints(html)[0]).toContain("data-caelo-plugin first");
  });

  it("says a placeholder with markup inside it loses that markup", () => {
    const html = SKILL_SECTION.replace(
      'data-page-id="{{page.id}}"></div>',
      'data-page-id="{{page.id}}"><div>Loading</div></div>',
    );
    expect(commentsModuleHints(html).join(" ")).toContain("Leave the comments placeholder empty");
  });

  it("lists every missing part of the form in one hint", () => {
    const html =
      '<section data-comments><div data-caelo-plugin="comments" data-page-id="{{page.id}}"></div>' +
      '<form data-comment-form><label>{{site_text.a}}<input name="authorName"></label><label>x</label></form></section>';
    const hints = commentsModuleHints(html);
    const missing = hints.find((h) => h.startsWith("The comments module is missing")) ?? "";
    for (const part of [
      'name="content"',
      'type="submit"',
      "data-comment-status",
      "data-sent-text",
      "data-comment-older",
    ]) {
      expect(missing).toContain(part);
    }
  });

  it("asks for labels and site texts when the section has neither", () => {
    const html = SKILL_SECTION.replaceAll(/<\/?label[^>]*>/g, "").replace(
      /\{\{site_text\.([a-z_]+)\}\}/g,
      "Text",
    );
    const hints = commentsModuleHints(html).join(" ");
    expect(hints).toContain("<label>");
    expect(hints).toContain("{{site_text.<key>}}");
  });

  it("stays within core's five hints and says each thing once", () => {
    const html = '<div data-caelo-plugin="comments"><div></div>';
    const hints = writeHints([module(html), module(html)]);
    expect(hints.length).toBeLessThanOrEqual(5);
    expect(new Set(hints).size).toBe(hints.length);
  });

  it("is wired as the plugin's write-hints operation", async () => {
    expect(plugin.writeHintsOperation).toBe("write_hints");
    const op = plugin.operations.write_hints;
    if (!op) throw new Error("write_hints missing");
    const r = (await op({} as PluginContextTier1, {
      writes: [module(SKILL_SECTION.replace("{{page.id}}", PAGE))],
    })) as { hints: string[] };
    expect(r.hints).toHaveLength(1);
  });
});

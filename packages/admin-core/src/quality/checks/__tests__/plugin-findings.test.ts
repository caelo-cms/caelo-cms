// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — plugin contributions to the Stage audit: each contributing
 * plugin becomes a `plugin.<slug>` site check next to core's, its findings
 * land as `plugin.<slug>/<rule>` through the same runner validation, and
 * a failing plugin fails its check loudly.
 */

import { describe, expect, it } from "bun:test";
import type { PluginAuditFinding } from "@caelo-cms/plugin-sdk";
import type { StagedPage } from "../check.js";
import {
  createPluginAuditCheck,
  type PluginAuditSource,
  withPluginAuditChecks,
} from "../plugin-findings.js";
import { CheckRegistry } from "../registry.js";
import { runFindingChecks } from "../runner.js";
import { NO_PROBE_BUILD } from "./fixtures/test-checks.js";

const PAGE = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const pages: StagedPage[] = [{ pageId: PAGE, path: "/docs", url: "http://s.test/docs/", html: "" }];

function source(
  answers: Record<string, readonly PluginAuditFinding[] | Error>,
): PluginAuditSource & {
  asked: { slug: string; pages: unknown }[];
} {
  const asked: { slug: string; pages: unknown }[] = [];
  return {
    asked,
    contributors: () => Object.keys(answers),
    async findings(slug, p) {
      asked.push({ slug, pages: p });
      const a = answers[slug];
      if (a instanceof Error) throw a;
      return a ?? [];
    },
  };
}

const MISSING: PluginAuditFinding = {
  rule: "translation-missing",
  severity: "error",
  pageId: PAGE,
  message: 'Translation missing: menu entry "Docs" has no German label.',
  fix: { tool: "translate_variant", hint: "translate the entry, then Stage again" },
};

describe("plugin audit contributions (epic #1107)", () => {
  it("files a plugin's findings under plugin.<slug>/<rule>, asked with the staged pages", async () => {
    const src = source({ "international-site": [MISSING] });
    const check = createPluginAuditCheck("international-site", src);
    expect(check.id).toBe("plugin.international-site");
    const out = await runFindingChecks(
      [
        {
          kind: "findings",
          id: check.id,
          title: check.title,
          scope: "site",
          source: { kind: "plugin", slug: "international-site" },
          check,
        },
      ],
      pages,
      NO_PROBE_BUILD,
    );
    expect(out.errors).toEqual([]);
    expect(out.findings).toEqual([
      {
        ruleId: "plugin.international-site/translation-missing",
        severity: "error",
        pageId: PAGE,
        message: MISSING.message,
        fix: MISSING.fix,
      },
    ]);
    expect(src.asked).toEqual([
      { slug: "international-site", pages: [{ pageId: PAGE, path: "/docs" }] },
    ]);
  });

  it("adds one check per contributor next to core's, leaving the base registry untouched", () => {
    const base = new CheckRegistry();
    base.registerLighthouse(async () => {
      throw new Error("not run");
    });
    expect(withPluginAuditChecks(base, source({}))).toBe(base);
    const extended = withPluginAuditChecks(base, source({ a: [], "b-plugin": [] }));
    expect(extended.list().map((e) => [e.id, e.source])).toEqual([
      ["lighthouse", { kind: "core" }],
      ["plugin.a", { kind: "plugin", slug: "a" }],
      ["plugin.b-plugin", { kind: "plugin", slug: "b-plugin" }],
    ]);
    expect(base.list()).toHaveLength(1);
    // A 55-character slug still makes a valid check id.
    const long = "x".repeat(55);
    expect(() => withPluginAuditChecks(base, source({ [long]: [] }))).not.toThrow();
  });

  it("a failing plugin, or a finding on a page outside the build, fails the check loudly", async () => {
    const src = source({
      broken: new Error("storage unreachable"),
      stray: [{ ...MISSING, pageId: OTHER }],
    });
    const registry = withPluginAuditChecks(new CheckRegistry(), src);
    const out = await runFindingChecks(registry.findingChecks(), pages, NO_PROBE_BUILD);
    expect(out.findings).toEqual([]);
    expect(out.errors.map((e) => e.checkId)).toEqual(["plugin.broken", "plugin.stray"]);
    expect(out.errors[0]?.message).toContain("storage unreachable");
    expect(out.errors[1]?.message).toContain("not a page of the staged build");
  });
});

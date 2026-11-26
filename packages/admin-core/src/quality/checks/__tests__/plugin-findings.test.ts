// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — plugin contributions to the Stage audit: each contributing
 * plugin becomes a `plugin.<slug>` site check next to core's, its findings
 * land as `plugin.<slug>/<rule>` through the same runner validation, and
 * a failing plugin fails its check loudly.
 */

import { describe, expect, it } from "bun:test";
import type { PluginAuditFinding, PluginAuditFindingsArgs } from "@caelo-cms/plugin-sdk";
import type { StagedPage } from "../check.js";
import {
  collectPluginFindings,
  createPluginAuditCheck,
  fileOnce,
  PLUGIN_AUDIT_BATCH_CONCURRENCY,
  type PluginAuditAnswer,
  type PluginAuditCall,
  type PluginAuditSource,
  withPluginAuditChecks,
} from "../plugin-findings.js";
import { CheckRegistry } from "../registry.js";
import { MAX_CHECK_CALL_TIMEOUT_MS, MAX_FINDINGS_PER_CALL, runFindingChecks } from "../runner.js";
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
    siteUrls: async () => ["https://example.com"],
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

  it("reads the facts of the pages a plugin asks for, and the staged sitemap once", async () => {
    const html = `<html lang="de"><body><a href="/en/" hreflang="en">English</a></body></html>`;
    const twoPages: StagedPage[] = [
      { pageId: PAGE, path: "/docs", url: "http://s.test/docs/", html },
      { pageId: OTHER, path: "/en/docs", url: "http://s.test/en/docs/", html: "<html></html>" },
    ];
    const read: string[] = [];
    const build = {
      ...NO_PROBE_BUILD,
      text: async (path: string) => {
        read.push(path);
        return null;
      },
    };
    const src: PluginAuditSource = {
      contributors: () => ["international-site"],
      siteUrls: async () => [],
      async findings(_slug, _pages, facts) {
        const [a] = await facts([PAGE]);
        const [b] = await facts([OTHER]);
        return [
          {
            rule: "seen",
            severity: "info",
            message: `Seen: ${a?.lang} ${a?.links[0]?.path} ${b?.sitemapAlternates}`,
          },
        ];
      },
    };
    const registry = withPluginAuditChecks(new CheckRegistry(), src);
    const out = await runFindingChecks(registry.findingChecks(), twoPages, build);
    expect(out.errors).toEqual([]);
    expect(out.findings.map((f) => f.message)).toEqual(["Seen: de /en no-sitemap"]);
    expect(read).toEqual(["/sitemap.xml"]);
  });

  it("#1632 — each call has its own budget: more batches never time a working check out", async () => {
    // Four calls of 40 ms each: 160 ms in all, past one 100 ms budget for
    // the lot, which is how a 299-page site failed every Stage.
    const slow = (answer: PluginAuditAnswer, ms: number) =>
      new Promise<PluginAuditAnswer>((resolve) => setTimeout(() => resolve(answer), ms));
    const labels: string[] = [];
    const found = await collectPluginFindings(
      (args, label) => {
        labels.push(label);
        return slow(
          args.facts
            ? { findings: [{ ...MISSING, message: `${MISSING.message} (${label})` }] }
            : { findings: [], factBatches: [[PAGE], [PAGE], [PAGE]] },
          40,
        );
      },
      "international-site",
      pages,
      async () => [],
      { callTimeoutMs: 100, concurrency: 1 },
    );
    expect(labels).toEqual(["pages", "facts batch 1", "facts batch 2", "facts batch 3"]);
    expect(found).toHaveLength(3);

    // One call past its budget is hung, and the failure names it.
    const hung = collectPluginFindings(
      (args, label) =>
        slow(
          args.facts ? { findings: [] } : { findings: [], factBatches: [[PAGE], [PAGE]] },
          label === "facts batch 2" ? 300 : 10,
        ),
      "international-site",
      pages,
      async () => [],
      { callTimeoutMs: 100 },
    );
    await expect(hung).rejects.toThrow(
      'plugin "international-site" (facts batch 2) did not finish within 100 ms',
    );
    // The check as a whole runs under the runner's ceiling, not one call's budget.
    expect(createPluginAuditCheck("international-site", source({})).timeoutMs).toBe(
      MAX_CHECK_CALL_TIMEOUT_MS,
    );
  });

  it("#1721 — batch calls run a few at a time, and the findings come back in batch order", async () => {
    // Twelve batches whose calls end in a scrambled order: the answer is the
    // same at every concurrency, and never more calls run than allowed.
    const site = Array.from({ length: 12 }, (_, i) => ({
      pageId: `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
      path: `/p${i}`,
    }));
    const delays = [7, 1, 12, 3, 9, 2, 11, 5, 0, 8, 4, 6];
    const run = async (concurrency: number) => {
      let running = 0;
      let most = 0;
      const call: PluginAuditCall = async (args, label) => {
        if (!args.facts) {
          return {
            findings: [{ ...MISSING, pageId: undefined, message: "Site: first." }],
            factBatches: site.map((p) => [p.pageId]),
          };
        }
        running += 1;
        most = Math.max(most, running);
        const i = Number(label.replace("facts batch ", "")) - 1;
        await new Promise((r) => setTimeout(r, delays[i]));
        running -= 1;
        return {
          findings: args.facts.map((f) => ({
            ...MISSING,
            pageId: f.pageId,
            message: `Page: ${f.path}.`,
          })),
        };
      };
      const found = await collectPluginFindings(
        call,
        "international-site",
        site,
        async (ids) => ids.map((id) => factsOf(id, site)),
        { concurrency },
      );
      return { messages: found.map((f) => f.message), most };
    };
    const one = await run(1);
    expect(one.most).toBe(1);
    expect(one.messages).toEqual(["Site: first.", ...site.map((p) => `Page: ${p.path}.`)]);
    for (const n of [2, PLUGIN_AUDIT_BATCH_CONCURRENCY, 12, 50]) {
      const many = await run(n);
      expect(many.messages).toEqual(one.messages);
      expect(many.most).toBe(Math.min(n, site.length));
    }
    await expect(
      collectPluginFindings(
        async () => ({ findings: [] }),
        "x",
        site,
        async () => [],
        {
          concurrency: 0,
        },
      ),
    ).rejects.toThrow("concurrency must be a whole number of at least 1");
  });

  it("#1721 — with several failing batches, the lowest one's failure, at any concurrency", async () => {
    const site = Array.from({ length: 8 }, (_, i) => ({
      pageId: `00000000-0000-4000-8000-${String(200 + i).padStart(12, "0")}`,
      path: `/q${i}`,
    }));
    for (const concurrency of [1, 3, 8]) {
      const started: string[] = [];
      const failing = collectPluginFindings(
        async (args, label) => {
          if (!args.facts) return { findings: [], factBatches: site.map((p) => [p.pageId]) };
          started.push(label);
          // Batch 5 fails at once, batch 3 later: the report names batch 3.
          if (label === "facts batch 5") throw new Error("batch 5 broke");
          await new Promise((r) => setTimeout(r, 15));
          if (label === "facts batch 3") throw new Error("batch 3 broke");
          return { findings: [] };
        },
        "international-site",
        site,
        async (ids) => ids.map((id) => factsOf(id, site)),
        { concurrency },
      );
      await expect(failing).rejects.toThrow("batch 3 broke");
      // No batch starts after a failure is known.
      expect(started.length).toBeLessThanOrEqual(Math.max(5, concurrency));
    }
  });

  it('#1721 — with batchPages "own" a batch call carries its own pages, the same size on any site', async () => {
    const sizeOfBatchCall = async (sitePages: number) => {
      const site = Array.from({ length: sitePages }, (_, i) => ({
        pageId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        path: `/page-${String(i).padStart(6, "0")}`,
      }));
      const calls: PluginAuditFindingsArgs[] = [];
      await collectPluginFindings(
        async (args) => {
          calls.push(args);
          return args.facts
            ? { findings: [] }
            : {
                findings: [],
                factBatches: [site.slice(0, 3).map((p) => p.pageId)],
                batchPages: "own",
              };
        },
        "international-site",
        site,
        async (ids) => ids.map((id) => factsOf(id, site)),
      );
      const batch = calls[1] as PluginAuditFindingsArgs;
      expect(batch.batchPages).toBe("own");
      expect(batch.pages).toEqual(site.slice(0, 3));
      return { first: JSON.stringify(calls[0]).length, batch: JSON.stringify(batch).length };
    };
    const small = await sizeOfBatchCall(10);
    const large = await sizeOfBatchCall(10_000);
    expect(large.batch).toBe(small.batch);
    // The page list crosses once, with the first call.
    expect(large.first).toBeGreaterThan(100 * small.first);

    // Without "own", every batch call carries the whole build, as before.
    const calls: PluginAuditFindingsArgs[] = [];
    await collectPluginFindings(
      async (args) => {
        calls.push(args);
        return args.facts ? { findings: [] } : { findings: [], factBatches: [[PAGE]] };
      },
      "legacy",
      pages,
      async (ids) => ids.map((id) => factsOf(id, pages)),
    );
    expect(calls[1]?.pages).toEqual([{ pageId: PAGE, path: "/docs" }]);
    expect(calls[1]?.batchPages).toBeUndefined();
  });

  it("#1721 — a batch call answering batchPages or factBatches again fails the check", async () => {
    const again = collectPluginFindings(
      async (args) =>
        args.facts
          ? { findings: [], batchPages: "own" }
          : { findings: [], factBatches: [[PAGE]], batchPages: "own" },
      "international-site",
      pages,
      async (ids) => ids.map((id) => factsOf(id, pages)),
    );
    await expect(again).rejects.toThrow("answered batchPages again in facts batch 1");
  });

  it("files a finding two fact batches report once, and caps a flood with a note", () => {
    const shared: PluginAuditFinding = {
      rule: "hardcoded-language-link",
      severity: "error",
      message: "Hardcoded language link: the footer link English → /en/ is fixed.",
    };
    expect(fileOnce("plugin.international-site", [shared, shared, MISSING])).toHaveLength(2);

    const flood: PluginAuditFinding[] = Array.from(
      { length: MAX_FINDINGS_PER_CALL + 10 },
      (_, i) => ({
        rule: "content-mixed-language",
        severity: i === MAX_FINDINGS_PER_CALL + 9 ? "error" : "warning",
        message: `Untranslated text: example ${i}.`,
      }),
    );
    const filed = fileOnce("plugin.international-site", flood);
    expect(filed).toHaveLength(MAX_FINDINGS_PER_CALL);
    // The error survives the cut; the note says what was left out.
    expect(filed[0]?.severity).toBe("error");
    expect(filed.at(-1)?.ruleId).toBe("plugin.international-site/limit-reached");
  });
});

/** Minimal page facts of `pageId` (what the tests above read: id and path). */
function factsOf(
  pageId: string,
  site: readonly { readonly pageId: string; readonly path: string }[],
): NonNullable<PluginAuditFindingsArgs["facts"]>[number] {
  const path = site.find((p) => p.pageId === pageId)?.path ?? "/";
  return {
    pageId,
    path,
    lang: null,
    title: null,
    metaDescription: null,
    canonical: null,
    robots: null,
    ogLocale: null,
    ogLocaleAlternates: [],
    alternates: [],
    sitemapAlternates: "no-sitemap",
    links: [],
    texts: [],
    truncated: false,
  };
}

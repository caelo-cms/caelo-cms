// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  manifestFromDefinition,
  type PluginAuditFinding,
  type PluginContextTier1,
  pluginManifest,
} from "@caelo-cms/plugin-sdk";
import { type SeoAuditRule, seoAudit } from "./checks/index.js";
import { type SeoWriteHintRule, seoWriteHints } from "./hints/index.js";
import seo from "./index.js";

// The runners never touch the context; the rules under test do not either.
const ctx = {} as PluginContextTier1;

const pages = Array.from({ length: 450 }, (_, i) => ({
  pageId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  path: `/p${i}`,
}));

describe("seo plugin definition", () => {
  it("projects onto a manifest the SDK accepts", () => {
    const manifest = pluginManifest.parse(manifestFromDefinition(seo));
    expect(manifest.slug).toBe("seo");
    expect(manifest.auditFindingsOperation).toBe("audit");
    expect(manifest.writeHintsOperation).toBe("write_hints");
    // Every operation a hook or tool names exists.
    for (const op of [manifest.auditFindingsOperation, manifest.writeHintsOperation]) {
      expect(manifest.operations).toContain(op as string);
    }
    for (const tool of manifest.tools ?? [])
      expect(manifest.operations).toContain(tool.operationName);
  });

  it("has no visitor-facing surface", () => {
    const manifest = manifestFromDefinition(seo);
    expect(manifest.publicOperations ?? []).toEqual([]);
    expect(Object.keys(manifest.schema)).toEqual([]);
  });
});

describe("seo audit runner", () => {
  it("answers no findings and asks for no facts without rules", async () => {
    expect(await seoAudit(ctx, { pages }, [])).toEqual({ findings: [] });
  });

  it("runs site parts once and asks for facts in batches of its own pages", async () => {
    const seen: number[] = [];
    const rule: SeoAuditRule = {
      name: "probe",
      site: async (_ctx, input) => {
        seen.push(input.pages.length);
        return [{ rule: "probe", severity: "warning", message: "Probe: site." }];
      },
      facts: async (_ctx, input) =>
        input.facts.map(
          (f): PluginAuditFinding => ({
            rule: "probe",
            severity: "error",
            pageId: f.pageId,
            message: "Probe: page.",
          }),
        ),
    };
    const first = await seoAudit(ctx, { pages }, [rule]);
    expect(seen).toEqual([450]);
    expect(first.batchPages).toBe("own");
    expect(first.factBatches?.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(first.findings).toHaveLength(1);

    const facts = pages.slice(0, 2).map((p) => ({ ...p, links: [] }));
    const batch = await seoAudit(
      ctx,
      { pages: pages.slice(0, 2), batchPages: "own", auditRunId: "run", facts },
      [rule],
    );
    expect(batch.findings.map((f) => f.pageId)).toEqual(pages.slice(0, 2).map((p) => p.pageId));
    expect(batch.factBatches).toBeUndefined();
  });

  it("refuses an argument core does not send", async () => {
    await expect(seoAudit(ctx, { pages: [], extra: 1 }, [])).rejects.toThrow();
  });

  it("answers errors first and at most 499 findings", async () => {
    const many: SeoAuditRule = {
      name: "many",
      site: async () =>
        Array.from({ length: 600 }, (_, i) => ({
          rule: "many",
          severity: i === 599 ? ("error" as const) : ("info" as const),
          message: `Many: ${i}.`,
        })),
    };
    const r = await seoAudit(ctx, { pages: [] }, [many]);
    expect(r.findings).toHaveLength(499);
    expect(r.findings[0]?.severity).toBe("error");
  });
});

describe("seo write hints runner", () => {
  it("joins the families' sentences, each once", async () => {
    const a: SeoWriteHintRule = { name: "a", hints: async () => ["Link X?", "Shorter title?"] };
    const b: SeoWriteHintRule = { name: "b", hints: async () => ["Link X?"] };
    const writes = [{ kind: "values", moduleId: null, values: { title: "x" } }];
    expect(await seoWriteHints(ctx, { writes }, [a, b])).toEqual({
      hints: ["Link X?", "Shorter title?"],
    });
    expect(await seoWriteHints(ctx, { writes }, [])).toEqual({ hints: [] });
  });
});

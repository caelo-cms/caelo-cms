// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — plugin contributions to the Stage audit against the real
 * host: only active plugins that declare an `auditFindingsOperation`
 * contribute; the operation receives the staged pages and its answer is
 * validated; a failing operation or a malformed answer throws (the audit
 * then fails loudly instead of reading as "no findings"); the manifest
 * refuses a hook naming no operation. A plugin that checks rendered
 * pages asks for their facts in batches and is called once per batch.
 * The write-hints hook answers the same way, per active plugin.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import type { PluginAuditPageFacts } from "@caelo-cms/plugin-sdk";
import { definePlugin, manifestFromDefinition } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import {
  auditFindingContributors,
  bootstrap,
  collectPluginAuditFindings,
  collectPluginWriteHints,
  type PluginHostInfra,
  resetPluginHost,
  writeHintContributors,
} from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const PAGE = "00000000-0000-4000-8000-0000000d1107";
const OTHER = "00000000-0000-4000-8000-0000000d1108";

/** Facts as core would read them (only what the test plugins look at). */
const factsOf = async (ids: readonly string[]) =>
  ids.map(
    (pageId) =>
      ({ pageId, path: `/${pageId.slice(-4)}`, lang: "de" }) as unknown as PluginAuditPageFacts,
  );
const NO_FACTS = async () => {
  throw new Error("this plugin asks for no facts");
};

let adapter: DatabaseAdapter;
let infra: PluginHostInfra;

function contributor(slug: string, answer: (args: unknown) => unknown) {
  return definePlugin({
    slug,
    version: "0.1.0",
    tier: 1,
    schema: {},
    auditFindingsOperation: "audit_findings",
    operations: { audit_findings: async (_ctx: unknown, args: unknown) => answer(args) },
  });
}

async function boot(...defs: ReturnType<typeof definePlugin>[]): Promise<void> {
  const report = await bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: defs.map((definition) => ({ definition })),
  });
  expect(report.failed).toEqual([]);
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't1107d-%')
      )`);
      await tx.unsafe(
        "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't1107d-%')",
      );
      await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't1107d-%'");
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry };
  await cleanup();
});

afterEach(cleanup);

afterAll(async () => {
  await adapter.close();
});

describe("#1107 — plugin audit contributions", () => {
  it("asks only contributing plugins, with the staged pages, and returns validated findings", async () => {
    let asked: unknown = null;
    await boot(
      contributor("t1107d-translations", (args) => {
        asked = args;
        return {
          findings: [
            {
              rule: "translation-missing",
              severity: "error",
              pageId: PAGE,
              message: 'Translation missing: menu entry "Docs" has no German label.',
              fix: { tool: "translate_variant", hint: "translate the entry, then Stage again" },
            },
          ],
        };
      }),
      definePlugin({
        slug: "t1107d-silent",
        version: "0.1.0",
        tier: 1,
        schema: {},
        operations: { noop: async () => ({}) },
      }),
    );
    expect(auditFindingContributors()).toEqual(["t1107d-translations"]);
    const findings = await collectPluginAuditFindings(
      "t1107d-translations",
      [{ pageId: PAGE, path: "/docs" }],
      NO_FACTS,
    );
    expect(asked).toEqual({ pages: [{ pageId: PAGE, path: "/docs" }] });
    expect(findings).toEqual([
      expect.objectContaining({ rule: "translation-missing", severity: "error", pageId: PAGE }),
    ]);
  });

  it("a failing operation, a malformed answer or a non-contributor throws", async () => {
    await boot(
      contributor("t1107d-broken", () => {
        throw new Error("storage unreachable");
      }),
      contributor("t1107d-malformed", () => ({
        findings: [{ rule: "Bad Rule", severity: "fatal" }],
      })),
    );
    await expect(collectPluginAuditFindings("t1107d-broken", [], NO_FACTS)).rejects.toThrow(
      /t1107d-broken\.audit_findings \(pages\) failed/,
    );
    await expect(collectPluginAuditFindings("t1107d-malformed", [], NO_FACTS)).rejects.toThrow(
      /returned an invalid answer/,
    );
    await expect(collectPluginAuditFindings("t1107d-absent", [], NO_FACTS)).rejects.toThrow(
      /not active or declares no auditFindingsOperation/,
    );
  });

  it("the manifest carries the hook and refuses one naming no operation", () => {
    const def = contributor("t1107d-manifest", () => ({ findings: [] }));
    expect(manifestFromDefinition(def).auditFindingsOperation).toBe("audit_findings");
    expect(() => manifestFromDefinition({ ...def, auditFindingsOperation: "missing_op" })).toThrow(
      /missing_op.*is not one of the plugin.s operations/,
    );
  });

  it("calls the plugin once per fact batch it asked for, with those pages' facts", async () => {
    const calls: unknown[] = [];
    await boot(
      contributor("t1107d-facts", (args) => {
        calls.push(args);
        const a = args as { facts?: { pageId: string; lang: string }[] };
        if (!a.facts) {
          return {
            findings: [{ rule: "site", severity: "info", message: "Site: checked." }],
            factBatches: [[PAGE], [OTHER]],
          };
        }
        return {
          findings: a.facts.map((f) => ({
            rule: "page",
            severity: "warning",
            pageId: f.pageId,
            message: `Page: lang ${f.lang}.`,
          })),
        };
      }),
    );
    const pages = [
      { pageId: PAGE, path: "/a" },
      { pageId: OTHER, path: "/b" },
    ];
    const findings = await collectPluginAuditFindings("t1107d-facts", pages, factsOf);
    expect(calls).toHaveLength(3);
    expect((calls[2] as { facts: { pageId: string }[] }).facts.map((f) => f.pageId)).toEqual([
      OTHER,
    ]);
    expect(findings.map((f) => [f.rule, f.pageId])).toEqual([
      ["site", undefined],
      ["page", PAGE],
      ["page", OTHER],
    ]);
  });

  it("refuses a batch naming a page outside the staged build", async () => {
    await boot(contributor("t1107d-stray", () => ({ findings: [], factBatches: [[OTHER]] })));
    await expect(
      collectPluginAuditFindings("t1107d-stray", [{ pageId: PAGE, path: "/a" }], factsOf),
    ).rejects.toThrow(/not a page of the staged build/);
  });

  it("collects write hints from the plugins that give them, and reports a failing one", async () => {
    const hinting = definePlugin({
      slug: "t1107d-hints",
      version: "0.1.0",
      tier: 1,
      schema: {},
      writeHintsOperation: "write_hints",
      operations: {
        write_hints: async (_ctx: unknown, args: unknown) => ({
          hints: (args as { writes: { kind: string; html?: string }[] }).writes.some((w) =>
            w.html?.includes('href="/en/"'),
          )
            ? ["The link to /en/ is fixed."]
            : [],
        }),
      },
    });
    const failing = definePlugin({
      slug: "t1107d-hints-broken",
      version: "0.1.0",
      tier: 1,
      schema: {},
      writeHintsOperation: "write_hints",
      operations: { write_hints: async () => ({ hints: "not a list" }) },
    });
    await boot(hinting, failing);
    expect(writeHintContributors()).toEqual(["t1107d-hints", "t1107d-hints-broken"]);
    const results = await collectPluginWriteHints(
      [{ kind: "module", moduleId: null, html: '<a href="/en/">English</a>', fields: [] }],
      null,
    );
    expect(results).toEqual([
      { slug: "t1107d-hints", hints: ["The link to /en/ is fixed."] },
      { slug: "t1107d-hints-broken", error: expect.stringContaining("invalid answer") },
    ]);
    expect(manifestFromDefinition(hinting).writeHintsOperation).toBe("write_hints");
  });
});

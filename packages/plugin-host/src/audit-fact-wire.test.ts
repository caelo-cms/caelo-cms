// SPDX-License-Identifier: MPL-2.0

/**
 * The audit's fact batches on the sandbox wire: every call a sandboxed
 * plugin gets fits one message, at the byte, and nothing the plugin asked
 * for is dropped except what a page alone cannot carry (named in
 * `truncatedFacts`).
 */

import { describe, expect, it } from "bun:test";
import type { PluginAuditFindingsArgs, PluginAuditPageFacts } from "@caelo-cms/plugin-sdk";
import { AUDIT_CALL_ARGS_BYTES, auditCallsThatFit, cutPageFacts } from "./audit-fact-wire.js";
import { callInParts, type PluginAuditFindings } from "./audit-findings.js";
import { SANDBOX_MESSAGE_BYTES } from "./sandbox-protocol.js";

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function facts(n: number, textChars: number, texts = 1): PluginAuditPageFacts {
  return {
    pageId: id(n),
    path: `/p${n}`,
    lang: "en",
    title: `Page ${n}`,
    metaDescription: null,
    canonical: null,
    robots: null,
    ogLocale: null,
    ogLocaleAlternates: [],
    alternates: [],
    sitemapAlternates: null,
    links: [],
    texts: Array.from({ length: texts }, () => ({
      text: "x".repeat(textChars),
      moduleId: null,
      listItem: null,
      pluginSlug: null,
      source: "text",
    })),
    headings: [],
    images: [],
    jsonLd: [],
    socialMeta: [],
    truncated: false,
    truncatedFacts: [],
  };
}

function batch(all: PluginAuditPageFacts[], own: boolean): PluginAuditFindingsArgs {
  return {
    pages: all.map((f) => ({ pageId: f.pageId, path: f.path })),
    facts: all,
    ...(own ? { batchPages: "own" as const, auditRunId: id(999) } : {}),
  };
}

describe("audit fact batches on the sandbox wire", () => {
  it("leaves the room of one message for the envelope", () => {
    expect(AUDIT_CALL_ARGS_BYTES).toBeLessThan(SANDBOX_MESSAGE_BYTES);
    expect(SANDBOX_MESSAGE_BYTES - AUDIT_CALL_ARGS_BYTES).toBe(64 * 1024);
  });

  it("keeps a call that fits at the byte as one call, and cuts it one byte later", () => {
    const one = batch([facts(1, 10), facts(2, 10)], true);
    const exact = bytes(one);
    expect(auditCallsThatFit(one, exact)).toEqual([one]);
    const parts = auditCallsThatFit(one, exact - 1);
    expect(parts).toHaveLength(2);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(exact - 1);
    // Each part carries its own pages, in the order asked for.
    expect(parts.map((p) => p.pages.map((x) => x.pageId))).toEqual([[id(1)], [id(2)]]);
    expect(parts.map((p) => p.facts?.map((f) => f.pageId))).toEqual([[id(1)], [id(2)]]);
    expect(parts.every((p) => p.batchPages === "own" && p.auditRunId === id(999))).toBe(true);
  });

  it("fits a real batch of 200 ordinary pages into calls under 1 MB, every fact kept", () => {
    const all = Array.from({ length: 200 }, (_, i) => facts(i, 300, 60));
    const args = batch(all, true);
    expect(bytes(args)).toBeGreaterThan(SANDBOX_MESSAGE_BYTES);
    const parts = auditCallsThatFit(args);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(AUDIT_CALL_ARGS_BYTES);
    expect(parts.flatMap((p) => p.facts ?? [])).toEqual(all);
  });

  it("keeps every page in each part of an `all` batch call", () => {
    const all = Array.from({ length: 8 }, (_, i) => facts(i, 2000, 4));
    const args = batch(all, false);
    const parts = auditCallsThatFit(args, Math.ceil(bytes(args) / 3));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.pages).toEqual(args.pages);
    expect(parts.flatMap((p) => p.facts ?? [])).toEqual(all);
  });

  it("cuts a page whose facts alone do not fit, and says which facts it cut", () => {
    const big = facts(7, 300, 6000);
    const args = batch([facts(1, 10), big], true);
    const parts = auditCallsThatFit(args);
    for (const part of parts) expect(bytes(part)).toBeLessThanOrEqual(AUDIT_CALL_ARGS_BYTES);
    const cut = parts.flatMap((p) => p.facts ?? []).find((f) => f.pageId === big.pageId);
    expect(cut?.truncated).toBe(true);
    expect(cut?.truncatedFacts).toEqual(["texts"]);
    expect(cut?.texts.length).toBeLessThan(big.texts.length);
    expect(cut?.texts.length).toBeGreaterThan(0);
    // A page that fits is left as it was.
    expect(cutPageFacts(facts(1, 10), 1_000_000)).toEqual(facts(1, 10));
  });

  it("refuses a call whose page list alone does not fit", () => {
    const pages = Array.from({ length: 20 }, (_, i) => ({ pageId: id(i), path: `/p${i}` }));
    const args: PluginAuditFindingsArgs = { pages, facts: [facts(1, 10)] };
    expect(() => auditCallsThatFit(args, bytes({ pages, facts: [] }) - 1)).toThrow(
      'batchPages: "own"',
    );
  });

  it("runs the parts in order and joins their findings", async () => {
    const all = [facts(1, 10), facts(2, 10), facts(3, 10)];
    const args = batch(all, true);
    const labels: string[] = [];
    const call = async (
      part: PluginAuditFindingsArgs,
      label: string,
    ): Promise<PluginAuditFindings> => {
      labels.push(label);
      return {
        findings: (part.facts ?? []).map((f) => ({
          rule: "seen",
          severity: "info" as const,
          pageId: f.pageId,
          message: `Seen: ${f.path}`,
        })),
      };
    };
    const answer = await callInParts(
      call,
      args,
      "facts batch 1",
      bytes(batch([facts(1, 10)], true)) + 4,
    );
    expect(labels).toEqual([
      "facts batch 1, part 1 of 3",
      "facts batch 1, part 2 of 3",
      "facts batch 1, part 3 of 3",
    ]);
    expect(answer.findings.map((f) => f.pageId)).toEqual(all.map((f) => f.pageId));
    // A part that asks for batches again comes back as it answered.
    const again = await callInParts(
      async () => ({ findings: [], factBatches: [[id(1)]] }),
      args,
      "facts batch 1",
      bytes(batch([facts(1, 10)], true)) + 4,
    );
    expect(again.factBatches).toEqual([[id(1)]]);
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * #1297 — `forms.summarize` with `since` passed the host's `since` filter,
 * which ranges over `created_at`; `form_submissions` has `submitted_at`
 * only, so the host refused every windowed call. The query handle here
 * applies the host's real filter rule (`parseListFilter` against the
 * plugin's declared table), so a filter the host would refuse fails the
 * test the way it failed the plugin.
 */

import { describe, expect, it } from "bun:test";
import formsPlugin from "@caelo-cms/plugin-forms";
import { parseListFilter } from "@caelo-cms/plugin-host";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";

const ROWS = [
  { id: "3", status: "new", data: { m: "newest" }, submitted_at: "2026-11-01T12:00:00.000Z" },
  { id: "2", status: "new", data: { m: "middle" }, submitted_at: "2026-10-31T12:00:00.000Z" },
  { id: "1", status: "read", data: { m: "oldest" }, submitted_at: "2026-10-01T12:00:00.000Z" },
];

function ctxWithHostRule(seen: Record<string, unknown>[]): PluginContextTier1 {
  const columns = formsPlugin.schema.form_submissions;
  if (!columns) throw new Error("forms declares no form_submissions table");
  return {
    invocation: { origin: "chat", actorId: "a", aiDelegated: true },
    query: {
      list: async (table: string, filter: Record<string, unknown>) => {
        expect(table).toBe("form_submissions");
        const plan = parseListFilter("plugin_public_storage.list", columns, filter);
        if (typeof plan === "string") throw new Error(plan);
        seen.push(filter);
        return ROWS;
      },
    },
  } as unknown as PluginContextTier1;
}

const summarize = formsPlugin.operations.summarize;
if (!summarize) throw new Error("forms has no summarize operation");

describe("#1297 — forms.summarize with since", () => {
  it("reads through a filter the host accepts and keeps only submissions after since", async () => {
    const seen: Record<string, unknown>[] = [];
    const result = (await summarize(ctxWithHostRule(seen), {
      formSlug: "contact",
      since: "2026-10-30T00:00:00Z",
    })) as { totalConsidered: number; workItem: { instructions: { user: string } } };
    expect(seen).toEqual([
      { limit: 50, orderBy: "submitted_at", orderDir: "desc", form_slug: "contact" },
    ]);
    expect(result.totalConsidered).toBe(2);
    expect(result.workItem.instructions.user).toContain("newest");
    expect(result.workItem.instructions.user).not.toContain("oldest");
  });

  it("answers an empty window when nothing was submitted after since", async () => {
    expect(await summarize(ctxWithHostRule([]), { since: "2026-11-02T00:00:00Z" })).toEqual({
      summary: "No submissions in the requested window.",
    });
  });

  it("refuses a since that is not a timestamp before reading anything", async () => {
    const seen: Record<string, unknown>[] = [];
    for (const since of ["last week", ""]) {
      await expect(summarize(ctxWithHostRule(seen), { since })).rejects.toThrow(
        /not an ISO timestamp/,
      );
    }
    expect(seen).toEqual([]);
  });
});

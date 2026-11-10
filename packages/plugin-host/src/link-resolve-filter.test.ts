// SPDX-License-Identifier: MPL-2.0

/**
 * #1269 — the journal filter of kept link-resolve answers counts a change
 * of a declared page column even when `columns` leaves it out: a row moved
 * to another page changes two pages' answers.
 */

import { describe, expect, it } from "bun:test";
import type { LoadedPlugin } from "./dispatch.js";
import { linkResolveJournalFilter } from "./link-resolve.js";

const plugin = { pluginId: "00000000-0000-4000-8000-000000001269" } as LoadedPlugin;

describe("linkResolveJournalFilter (#1269)", () => {
  it("counts a page column that `columns` does not list", () => {
    const filter = linkResolveJournalFilter(
      plugin,
      {
        tables: ["page_variants"],
        columns: ["group_id"],
        pageColumns: { page_variants: "page_id" },
      },
      null,
    );
    expect(filter.columns?.plugin_storage).toEqual(
      expect.arrayContaining(["group_id", "page_id", "caelo_deleted_at", "caelo_chat_branch_id"]),
    );
  });

  it("lists each column once", () => {
    const filter = linkResolveJournalFilter(
      plugin,
      {
        tables: ["page_variants"],
        columns: ["page_id"],
        pageColumns: { page_variants: "page_id" },
      },
      null,
    );
    const columns = filter.columns?.plugin_storage ?? [];
    expect(columns.filter((c) => c === "page_id")).toHaveLength(1);
  });
});

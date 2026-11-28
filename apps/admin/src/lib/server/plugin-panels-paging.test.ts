// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1751 — a panel table pages by the result's own cursor when it names
 * one (`paging.nextCursorKey`): an operation that filters what it reads can
 * answer a page with no row while more of the list follows, and the next
 * page must still open. Without it, the last row's cursor, as before.
 */

import { describe, expect, it } from "bun:test";
import { pluginAdminPanel } from "@caelo-cms/plugin-sdk";
import { loadSections } from "./plugin-panels.js";

function panelWith(paging: Record<string, unknown>) {
  return pluginAdminPanel.parse({
    slug: "overview",
    title: "Overview",
    description: "Rows.",
    icon: "search",
    permission: "content.read",
    sections: [
      {
        kind: "table",
        id: "pages",
        title: "Pages",
        operation: "rows",
        rowsKey: "rows",
        rowKey: "id",
        columns: [{ key: "id", label: "Id", format: "text" }],
        paging: { pageSize: 50, limitArg: "limit", hasMoreKey: "hasMore", ...paging },
        emptyMessage: "None.",
      },
    ],
  });
}

async function nextHref(paging: Record<string, unknown>, value: unknown): Promise<string | null> {
  const [state] = await loadSections(
    panelWith(paging),
    new URL("https://admin.example/plugins/seo/overview"),
    async () => ({ ok: true, value }),
    "/plugins/seo/overview/download",
  );
  return state?.kind === "table" ? state.nextPageHref : null;
}

describe("panel table paging", () => {
  it("opens the next page from the result's cursor, also when the page holds no row", async () => {
    const href = await nextHref(
      { cursor: { arg: "cursor", key: "nextCursor" }, nextCursorKey: "nextCursor" },
      { rows: [], hasMore: true, nextCursor: "c7" },
    );
    expect(href).not.toBeNull();
    expect(new URL(href as string, "https://admin.example").searchParams.get("pages.cursor")).toBe(
      JSON.stringify("c7"),
    );
  });

  it("keeps paging by the last row's cursor without nextCursorKey", async () => {
    const href = await nextHref(
      { cursor: { arg: "cursor", key: "id" } },
      { rows: [{ id: "a" }, { id: "b" }], hasMore: true },
    );
    expect(new URL(href as string, "https://admin.example").searchParams.get("pages.cursor")).toBe(
      JSON.stringify("b"),
    );
    expect(
      await nextHref({ cursor: { arg: "cursor", key: "id" } }, { rows: [], hasMore: true }),
    ).toBeNull();
  });
});

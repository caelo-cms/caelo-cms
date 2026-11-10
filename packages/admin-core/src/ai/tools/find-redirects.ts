// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — `find_redirects` (2026-07: makeListReadTool — TOON output). The
 * uniform `filter` param maps to the op's server-side substring query so
 * matching runs over the WHOLE table, not one fetched page. #1538 — the op
 * pages by keyset cursor (ordered by address) and counts every matching
 * rule, so `next cursor` reaches every rule of a table of any size.
 *
 * #1550 — every rule with its state: `live`, or the state of its pending
 * change (`staged`, `draft`) and what the change does.
 */

import { z } from "zod";
import type { RedirectRule } from "../../ops/redirects.js";
import { makeListReadTool } from "./_list-read-tool.js";

const findRedirectsInput = z
  .object({
    statusCode: z
      .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308), z.literal(410)])
      .optional(),
    state: z
      .enum(["all", "live", "staged", "draft"])
      .optional()
      .describe("live: no pending change; staged / draft: a pending change in that state."),
  })
  .strict();

/** What a pending change does, as one cell: `remove`, `change from /x`, `create`, plus its cause. */
function changeCell(r: RedirectRule): string {
  const c = r.change;
  if (c === null) return "";
  const what =
    c.kind === "remove"
      ? "remove"
      : c.kind === "change" && r.live
        ? `change from ${r.live.toPath}`
        : "create";
  return c.origin === "manual" ? what : `${what} (${c.origin})`;
}

export const findRedirectsTool = makeListReadTool<z.infer<typeof findRedirectsInput>, RedirectRule>(
  {
    name: "find_redirects",
    description:
      "Search redirects (TOON rows: fromPath, toPath, status, state, change). Pre-flight before `bulk_delete_redirects` so the user sees what goes.",
    opName: "redirects.list",
    input: findRedirectsInput,
    paging: {
      kind: "cursor",
      maxLimit: 500,
      nextCursor: (value) => (value as { nextCursor: string | null }).nextCursor,
      total: (value) => (value as { totalCount: number }).totalCount,
    },
    listParamDescriptions: {
      filter: "Substring of fromPath / toPath (whole table).",
    },
    buildOpInput: (input) => ({
      ...(input.filter !== undefined ? { query: input.filter } : {}),
      ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
    }),
    label: "redirects",
    rows: (value) => (value as { redirects: RedirectRule[] }).redirects,
    columns: [
      { key: "from", value: (r) => r.fromPath },
      { key: "to", value: (r) => r.toPath },
      { key: "status", value: (r) => r.statusCode },
      { key: "state", value: (r) => r.state },
      { key: "change", value: (r) => changeCell(r) },
    ],
    emptyMessage: "No redirects matched.",
  },
);

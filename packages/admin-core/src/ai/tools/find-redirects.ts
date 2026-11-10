// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — `find_redirects` (2026-07: makeListReadTool — TOON output). The
 * uniform `filter` param maps to the op's server-side substring query so
 * matching runs over the WHOLE table, not one fetched page. #1538 — the op
 * pages by keyset cursor (ordered by fromPath) and counts every matching
 * row, so `next cursor` reaches every rule of a table of any size.
 */

import { z } from "zod";
import { makeListReadTool } from "./_list-read-tool.js";

const findRedirectsInput = z
  .object({
    statusCode: z
      .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308), z.literal(410)])
      .optional(),
  })
  .strict();

export const findRedirectsTool = makeListReadTool<
  z.infer<typeof findRedirectsInput>,
  { fromPath: string; toPath: string; statusCode: number }
>({
  name: "find_redirects",
  description:
    "Search redirects (TOON rows: fromPath, toPath, status). Pre-flight before `bulk_delete_redirects` so the user sees what goes.",
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
  }),
  label: "redirects",
  rows: (value) =>
    (value as { redirects: { fromPath: string; toPath: string; statusCode: number }[] }).redirects,
  columns: [
    { key: "from", value: (r) => r.fromPath },
    { key: "to", value: (r) => r.toPath },
    { key: "status", value: (r) => r.statusCode },
  ],
  emptyMessage: "No redirects matched.",
});

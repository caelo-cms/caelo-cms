// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — `find_redirects` (2026-07: makeListReadTool — TOON output). The
 * uniform `filter` param maps to the op's server-side substring query so
 * matching runs over the WHOLE table, not one fetched page.
 */

import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import { makeListReadTool } from "./_make-read-tool.js";
import type { ToolContext } from "./dispatch.js";

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
    "Search redirects (TOON rows: fromPath, toPath, status). `filter` matches fromPath/toPath server-side across the whole table; optional `statusCode`; `limit`/`offset`/`full` as usual. " +
    "Use as a pre-flight check before `bulk_delete_redirects` so the user sees what will be removed.",
  opName: "redirects.list",
  input: findRedirectsInput,
  buildOpInput: (
    input: { statusCode?: number; filter?: string; limit?: number; full?: boolean },
    _ctx: ExecutionContext,
    _toolCtx: ToolContext,
  ) => ({
    ...(input.filter !== undefined ? { query: input.filter } : {}),
    ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
    limit: input.full ? 200 : Math.min(input.limit ?? 50, 200),
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

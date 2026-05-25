// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.0 — AI tool: set_theme_tokens (#45 follow-up comment §1).
 *
 * The AI's primary way to edit a theme. Accepts loose names
 * (`primaryColor`, `fontHeading`, `spacingLg`, `radius`) — server
 * normalizes to canonical DTCG paths and returns what was written.
 * On ambiguity the server returns `UnknownTokenName` with did-you-mean
 * suggestions so the AI's retry lands.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const setThemeTokensToolInput = z
  .object({
    /** Optional — defaults to the active theme. */
    themeSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
    /** Loose-name → value map. Server normalizes to canonical paths. */
    set: z.record(z.string(), z.unknown()).optional(),
    /** Canonical DTCG paths to drop. */
    remove: z.array(z.string()).optional(),
  })
  .strict();
type SetThemeTokensToolInput = z.infer<typeof setThemeTokensToolInput>;

export const updateThemeTokensTool: ToolDefinitionWithHandler<SetThemeTokensToolInput> = {
  name: "set_theme_tokens",
  description:
    "Update theme tokens for one theme. Accepts loose names (`primaryColor`, `fontHeading`, " +
    "`spacingLg`) — server normalizes to canonical paths and returns what was written. " +
    "Pass `set` to add/replace tokens, `remove` to drop them. Works with the active theme " +
    "by default; pass `themeSlug` to target a specific theme. For a complete theme " +
    "replacement, use `set_theme_tokens` with all desired tokens (it's an upsert per token, " +
    "not per-theme). When ambiguous (a bare name with no value-shape signal) the tool " +
    "returns `UnknownTokenName` with did-you-mean suggestions; retry with the canonical " +
    "path.",
  schema: setThemeTokensToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      themeSlug: { type: "string", minLength: 1, maxLength: 120 },
      set: { type: "object", additionalProperties: true },
      remove: { type: "array", items: { type: "string" } },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "themes.update_tokens", input);
    if (!r.ok) {
      return { ok: false, content: `themes.update_tokens failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      themeId: string;
      canonicalPathsWritten: string[];
      canonicalPathsRemoved: string[];
    };
    const parts: string[] = [];
    if (v.canonicalPathsWritten.length > 0) {
      parts.push(`wrote ${v.canonicalPathsWritten.join(", ")}`);
    }
    if (v.canonicalPathsRemoved.length > 0) {
      parts.push(`removed ${v.canonicalPathsRemoved.join(", ")}`);
    }
    return {
      ok: true,
      content: parts.length > 0 ? parts.join("; ") : "no-op (nothing to set or remove)",
    };
  },
};

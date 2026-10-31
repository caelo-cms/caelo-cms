// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 / v0.2.14 — `set_site_defaults`. AI-callable per the §11.A
 * exception in `ops/site_defaults.ts` (existing templates keep their
 * pinned layout; the change only affects future templates created
 * without one; snapshot-revertable). The AI can resolve a request like
 * "make site-default the default layout" into a single tool call
 * without operator round-trips. #1276: the default layout is the only
 * default left — pages name their page type, templates theirs.
 *
 * Slugs are accepted (not ids) so the AI can pass natural names.
 */

import { execute } from "@caelo-cms/query-api";
import { setSiteDefaultsToolInput } from "@caelo-cms/shared";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface LayoutDetail {
  id: string;
  slug: string;
}

export const setSiteDefaultsTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetSiteDefaultsToolInput
> = {
  name: "set_site_defaults",
  // 2026-07 — STATIC on purpose: tool definitions are part of Anthropic's
  // prompt-cache prefix, so state-dependent text here busted the cache on
  // every site change. Current values + valid slugs are read with
  // get_site_defaults / list_layouts.
  description:
    "Set the site-wide default layout for new templates created without one. Safe to call directly: existing templates keep theirs. " +
    "Pass the slug (e.g. `site-default`, from `list_layouts`), not a UUID. No layouts yet -> `create_layout` first.",
  schema: setSiteDefaultsToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["defaultLayoutSlug"],
    properties: {
      defaultLayoutSlug: { type: "string", minLength: 1, maxLength: 120 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Resolve the slug via the read op first; that way a typo surfaces a
    // clear "not found" rather than the op-level ActorScopeRejected.
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.get", {
      slug: input.defaultLayoutSlug,
    });
    if (!got.ok) {
      return toolError(got.error, `layouts.get failed: ${describeError(got.error)}`);
    }
    const layout = (got.value as { layout: LayoutDetail | null }).layout;
    if (!layout) {
      return { ok: false, content: `layout "${input.defaultLayoutSlug}" not found` };
    }
    const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "site_defaults.set", {
      defaultLayoutId: layout.id,
    });
    if (!res.ok) {
      return toolError(res.error, `site_defaults.set failed: ${describeError(res.error)}`);
    }
    return { ok: true, content: `default layout set to ${input.defaultLayoutSlug}` };
  },
};

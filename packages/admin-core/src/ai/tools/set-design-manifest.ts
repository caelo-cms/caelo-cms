// SPDX-License-Identifier: MPL-2.0

/**
 * issue #165 — AI tool: set_design_manifest. The final Genesis
 * materialisation step and the maintenance surface when the design
 * evolves (token renamed, new pattern established). Full-replace
 * semantics: read the current `## Design system` block, merge
 * mentally, write the complete document.
 */

import { execute } from "@caelo-cms/query-api";
import { designManifestSchema } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const input = z.object({ manifest: designManifestSchema }).strict();
type Input = z.infer<typeof input>;

export const setDesignManifestTool: ToolDefinitionWithHandler<Input> = {
  name: "set_design_manifest",
  description:
    "Write THIS site's Design Manifest — the per-site design language every future page follows (rendered as the `## Design system` block). " +
    "Call it (1) as the LAST Genesis materialisation step, recording the token ROLES you just decided ('--color-primary: CTAs and links only'), typography + rhythm rules, and one `patterns` entry per section type you built (name + stable module `type` + one-line spec); " +
    "(2) whenever the design system materially changes (new pattern established, token role shifted). " +
    "FULL REPLACE — include everything that should remain true, not just the delta. This is how page B stays on page A's visual line without a global Caelo look.",
  schema: input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["manifest"],
    properties: {
      manifest: {
        type: "object",
        additionalProperties: false,
        properties: {
          tokenRoles: { type: "object", additionalProperties: { type: "string", maxLength: 300 } },
          typography: { type: "string", minLength: 1, maxLength: 1000 },
          rhythm: { type: "string", minLength: 1, maxLength: 1000 },
          patterns: {
            type: "array",
            maxItems: 24,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "spec"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 80 },
                moduleType: { type: "string", maxLength: 64 },
                spec: { type: "string", minLength: 1, maxLength: 500 },
              },
            },
          },
          imagery: { type: "string", minLength: 1, maxLength: 500 },
          avoid: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
  },
  handler: async (ctx, toolInput, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "design_manifest.set",
      toolInput,
    );
    if (!r.ok) {
      return { ok: false, content: `design_manifest.set failed: ${describeError(r.error)}` };
    }
    const sections = Object.keys(toolInput.manifest).join(", ");
    return {
      ok: true,
      content: `Design Manifest written (${sections}). It renders as the \`## Design system\` block from the next turn on — future pages follow it.`,
    };
  },
};

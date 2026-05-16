// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.12 — `list_layouts`. AI-callable wrapper around `layouts.list`.
 *
 * Why it exists: the `# Layouts on this site` system-prompt block already
 * surfaces every layout with its UUID on each turn. But when the AI
 * claims it doesn't have a UUID (passive failure mode, or genuinely
 * stale context after a propose/execute approval), it needs an explicit
 * tool to fetch the current state instead of asking the user.
 *
 * Returns slug + UUID + display name + block names per layout — same
 * shape as the system-prompt block, but on-demand.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listLayoutsInput = z
  .object({
    includeDeleted: z.boolean().default(false),
  })
  .strict();
type ListLayoutsInput = z.infer<typeof listLayoutsInput>;

export const listLayoutsTool: ToolDefinitionWithHandler<ListLayoutsInput> = {
  name: "list_layouts",
  description:
    "List every layout on the site with its UUID, slug, display name, and block names. " +
    "Use when you need a layout UUID and don't see it in the `# Layouts on this site` context block " +
    "(e.g. right after an Owner approved a layout-create proposal — the proposal flow doesn't include a tool-result with the new UUID, " +
    "so this is how you fetch it). " +
    "Returns the same data the context block carries, on demand. " +
    "DO NOT ask the operator to paste a UUID — call this tool.",
  schema: listLayoutsInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      includeDeleted: { type: "boolean", default: false },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.list", input);
    if (!r.ok) {
      return { ok: false, content: `layouts.list failed: ${describeError(r.error)}` };
    }
    const layouts = (
      r.value as {
        layouts: {
          id: string;
          slug: string;
          displayName: string;
          blocks: { name: string }[];
        }[];
      }
    ).layouts;
    if (layouts.length === 0) {
      return {
        ok: true,
        content:
          "No layouts on this site yet. Call create_layout to propose one (Owner-approved), then re-run list_layouts to fetch the resulting UUID.",
      };
    }
    const lines = layouts.map(
      (l) =>
        `- ${l.slug} (id=${l.id}) "${l.displayName}" — blocks: ${l.blocks.map((b) => b.name).join(", ")}`,
    );
    return {
      ok: true,
      content: `${layouts.length} layout${layouts.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
      // v0.6.0 alpha.2 — structured payload for the chat-runner's W3
      // retry path. nextAction.retryWithArgs={argName:"layoutId",
      // fromValuePath:"layouts.0.id"} extracts the first layout's id
      // and rewrites the failed templates.create call's args.
      value: { layouts },
    };
  },
};

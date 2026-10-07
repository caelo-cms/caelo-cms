// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin lifecycle steps the operator could only take at /security/plugins:
 *
 * - `list_plugin_grants` (read) — which capabilities each plugin version
 *   holds; the AI needs it before it can propose revoking one.
 * - `propose_revoke_plugin_capability` (§11.A gated) — revoking a grant of
 *   the running version disables the plugin, and getting it back is a new
 *   Owner approval, so the operator approves the card.
 * - `reject_plugin`, `revalidate_plugin` (routine) — both act only on a
 *   Tier 2 submission that is not running, and each undoes the other in one
 *   call. See the actorScope notes on `plugins.reject` / `plugins.revalidate`.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { proposeRevokeCapabilityInput } from "../../ops/plugins/capability_proposals.js";
import { describeError } from "./_describe-error.js";
import { makeProposeTool } from "./_make-propose-tool.js";
import { makeListReadTool } from "./_make-read-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";
import { generateInputSchema } from "./generate-input-schema.js";

interface GrantRow {
  slug: string;
  installationId: string;
  installationStatus: string;
  pluginStatus: string;
  capability: string;
  approvedAt: string;
}

const listGrantsInput = z
  .object({ slug: z.string().min(1).max(120).optional().describe("Limit to one plugin.") })
  .strict();

export const listPluginGrantsTool = makeListReadTool<z.infer<typeof listGrantsInput>, GrantRow>({
  name: "list_plugin_grants",
  description:
    "List the capabilities the Owner has granted to installed (runtime-installed) plugins: one row per grant, with whether it belongs to the current version or a pending update, and the plugin's status (a `disabled` plugin holds grants but is not running). " +
    "Use before propose_revoke_plugin_capability, or when the operator asks what a plugin is allowed to do.",
  opName: "plugins.list_capability_grants",
  input: listGrantsInput,
  label: "grants",
  rows: (value) => (value as { grants: GrantRow[] }).grants,
  columns: [
    { key: "slug", value: (g) => g.slug },
    { key: "version", value: (g) => (g.installationStatus === "active" ? "current" : "update") },
    { key: "pluginStatus", value: (g) => g.pluginStatus },
    { key: "capability", value: (g) => g.capability },
    { key: "approvedAt", value: (g) => g.approvedAt },
  ],
  emptyMessage: "No capability grants recorded.",
});

export const proposeRevokePluginCapabilityTool = makeProposeTool({
  toolName: "propose_revoke_plugin_capability",
  opName: "plugins.propose_revoke_capability",
  pendingQueuePath: "/security/pending",
  when:
    "Propose taking one granted capability away from an installed plugin (e.g. its image generation or private file storage). " +
    "Revoking a grant of the RUNNING version (target `running`, the default) DISABLES the plugin — its data is kept, but running it again needs a new Owner approval; target `pending_update` abandons an update that has not started (it must be staged and approved again). " +
    "Check list_plugin_grants first, and tell the operator what stops working.",
  schema: proposeRevokeCapabilityInput,
  inputSchema: generateInputSchema(proposeRevokeCapabilityInput),
  summarize: (input, preview) =>
    `revoke ${input.capability} from plugin ${input.slug}${preview.disablesPlugin ? " (disables it)" : ""}`,
});

const rejectInput = z
  .object({
    slug: z.string().min(1).max(120),
    reason: z
      .string()
      .max(2000)
      .optional()
      .describe("Why — kept on the row so a later fix can address it."),
  })
  .strict();

export const rejectPluginTool: ToolDefinitionWithHandler<z.infer<typeof rejectInput>> = {
  name: "reject_plugin",
  description:
    "Reject a submitted plugin that is NOT running yet (draft or awaiting activation), e.g. when the operator decides against it or you are withdrawing your own submission. " +
    "Source and validator errors are kept; revalidate_plugin re-files it. Not for running plugins — rejecting does not stop anything.",
  schema: rejectInput,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "plugins.reject", input);
    if (!r.ok) return { ok: false, content: `reject_plugin failed: ${describeError(r.error)}` };
    return { ok: true, content: `Plugin "${input.slug}" rejected. revalidate_plugin re-files it.` };
  },
};

const revalidateInput = z.object({ slug: z.string().min(1).max(120) }).strict();

export const revalidatePluginTool: ToolDefinitionWithHandler<z.infer<typeof revalidateInput>> = {
  name: "revalidate_plugin",
  description:
    "Re-run the plugin validator over a submitted plugin that is NOT running (draft, awaiting activation or rejected) — after a Caelo upgrade, or to re-file a rejected submission. " +
    "Passing moves it to awaiting activation (activate_plugin then proposes turning it on); failing returns the validator errors to fix. Refused for running, disabled or failed plugins — those are the Owner's call.",
  schema: revalidateInput,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "plugins.revalidate", input);
    if (!r.ok) return { ok: false, content: `revalidate_plugin failed: ${describeError(r.error)}` };
    const v = r.value as { status: string; validationErrors: Array<{ kind: string }> };
    return {
      ok: true,
      content:
        v.validationErrors.length === 0
          ? `"${input.slug}" passed validation and is awaiting activation.`
          : `"${input.slug}" failed validation (${v.validationErrors.length} error(s): ${v.validationErrors
              .slice(0, 5)
              .map((e) => e.kind)
              .join(", ")}); status ${v.status}.`,
      value: v,
    };
  },
};

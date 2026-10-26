// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin lifecycle steps the operator could only take at /settings/plugins:
 *
 * - `list_plugin_grants` (read) — which capabilities each plugin version
 *   holds; the AI needs it before it can propose revoking one.
 * - `list_plugin_installations` (read) — which staged packages still wait
 *   for the Owner's review (approving one stays the Owner's click).
 * - `propose_revoke_plugin_capability` (§11.A gated) — revoking a grant of
 *   the running version disables the plugin, and getting it back is a new
 *   Owner approval, so the operator approves the card.
 * - `reject_plugin`, `revalidate_plugin` (routine) — both act only on a
 *   Tier 2 submission that is not running, and each undoes the other in one
 *   call. See the actorScope notes on `plugins.reject` / `plugins.revalidate`.
 * - `reload_plugin` (routine, #1008) — retries loading an active plugin on
 *   every server; it changes no decision (see `plugins.reload`).
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
    "Capabilities the Owner granted to runtime-installed plugins: one row per grant, current version vs pending update, plugin status (`disabled` = holds grants, not running). Use before `propose_revoke_plugin_capability` or when asked what a plugin may do.",
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
  pendingQueuePath: "/settings/plugins/pending",
  when: "Propose removing one granted capability from an installed plugin (e.g. image generation, private file storage). Check `list_plugin_grants` first; tell the operator what stops working.",
  schema: proposeRevokeCapabilityInput,
  inputSchema: generateInputSchema(proposeRevokeCapabilityInput),
  summarize: (input, preview) =>
    `revoke ${input.capability} from plugin ${input.slug}${preview.disablesPlugin ? " (disables it)" : ""}`,
});

interface InstallationRow {
  id: string;
  slug: string;
  artifactDigest: string;
  status: string;
  origin: string;
  currentStatus: string;
}

export const listPluginInstallationsTool = makeListReadTool<Record<string, never>, InstallationRow>(
  {
    name: "list_plugin_installations",
    description:
      "Runtime-installed plugin packages by version: artifact status (pending = awaiting Owner review at /settings/plugins/installations), origin (AI-authored | uploaded), plugin status. Use after `submit_plugin` to tell the operator whether a package or update still awaits review. Approving it + choosing grants is the Owner's decision, never yours.",
    opName: "plugins.list_installations",
    input: z.object({}).strict(),
    // The op rows carry every version's full source; keep them out of the transcript.
    includeValue: false,
    label: "installations",
    rows: (value) => (value as { installations: InstallationRow[] }).installations,
    columns: [
      { key: "slug", value: (r) => r.slug },
      { key: "status", value: (r) => r.status },
      { key: "origin", value: (r) => r.origin },
      { key: "pluginStatus", value: (r) => r.currentStatus },
      { key: "digest", value: (r) => r.artifactDigest.slice(0, 12) },
      { key: "installationId", value: (r) => r.id },
    ],
    emptyMessage: "No runtime-installed plugin packages.",
  },
);

const rejectInput = z
  .object({
    slug: z.string().min(1).max(120),
    reason: z
      .string()
      .max(2000)
      .optional()
      .describe("Kept on the row so a later fix can address it."),
  })
  .strict();

export const rejectPluginTool: ToolDefinitionWithHandler<z.infer<typeof rejectInput>> = {
  name: "reject_plugin",
  description:
    "Reject a submitted plugin NOT running yet (draft | awaiting activation), e.g. operator decided against it or you withdraw your own. Source + validator errors kept; `revalidate_plugin` re-files it. Not for running plugins (stops nothing).",
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
    "Re-run the validator on a submitted plugin NOT running (draft | awaiting activation | rejected) — after a Caelo upgrade or to re-file a rejection. Pass -> awaiting activation (`activate_plugin` proposes turning it on); fail -> validator errors to fix. Refused for running/disabled plugins (Owner's call); active plugin failing to load -> `reload_plugin`.",
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

const reloadInput = z
  .object({ slug: z.string().min(1).max(120).describe("As `list_plugins` shows it.") })
  .strict();

/** Health fields `plugins.get` returns that this tool reports. */
interface ReloadedHealth {
  state: string;
  servers: { loaded: number; failing: number };
  problem: { message: string } | null;
}

export const reloadPluginTool: ToolDefinitionWithHandler<z.infer<typeof reloadInput>> = {
  name: "reload_plugin",
  description:
    "Retry loading an ACTIVE plugin on every server — the fix for health `failing` (servers don't retry on their own). Use after the cause was fixed, when transient, or when asked. Returns this server's result; others follow within seconds (`get_plugin`). " +
    "Not for awaiting-activation/disabled plugins (activation = Owner's decision: `activate_plugin`).",
  schema: reloadInput,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "plugins.reload", input);
    if (!r.ok) return { ok: false, content: `reload_plugin failed: ${describeError(r.error)}` };
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "plugins.get", input);
    if (!got.ok) {
      return {
        ok: true,
        content: `Reload of "${input.slug}" requested on every server; reading its health failed: ${describeError(got.error)}.`,
      };
    }
    const h = (got.value as { plugin: { health: ReloadedHealth } | null }).plugin?.health;
    const now = h
      ? `${h.state} (servers: ${h.servers.loaded} loaded, ${h.servers.failing} failing)${h.problem ? ` — ${h.problem.message}` : ""}`
      : "unknown";
    return {
      ok: true,
      content: `Reload of "${input.slug}" requested on every server. Health now: ${now}. Other servers follow within seconds; get_plugin shows their state.`,
    };
  },
};

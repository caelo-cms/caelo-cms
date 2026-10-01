// SPDX-License-Identifier: MPL-2.0

/**
 * `submit_plugin` — the AI writes a plugin against the SDK and submits it
 * for the Owner's approval (CMS_REQUIREMENTS §14). The AI submits; a human
 * Owner activates and grants. It never edits plugins shipped with Caelo.
 */

import { execute } from "@caelo-cms/query-api";
import { type SubmitPluginToolInput, submitPluginToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const submitPluginTool: ToolDefinitionWithHandler<SubmitPluginToolInput> = {
  name: "submit_plugin",
  description:
    "Submit a plugin you wrote for the operator's site, for validation and the Owner's approval. Use when the operator needs behaviour no existing tool or module gives (a form that stores entries, a booking list, a private notes tool). " +
    "TWO-STEP: this validates and queues only. The Owner approves the exact source at /security/plugins (or, if it requests access, at /security/plugins/installations) — say you have submitted it for approval; never claim it is active. " +
    "The plugin runs sandboxed: import ONLY @caelo-cms/plugin-sdk; no fetch, Deno, dynamic import, eval or SQL. Its own visitor data goes in `schema` (public tables). " +
    "Extra access must be requested and explained: `cms_admin_schema` for private author storage (declare `adminSchema`) and `chat_runner_tools` for tools you can call in chat (declare `tools`, each named `<slug_with_underscores>__<name>`); give each a reason in `capabilityReasons`. The Owner sees every tool name and description verbatim before approving, so describe honestly what each tool does. Private-storage writes made from a chat stay in the chat until it is published. " +
    "Inputs: slug (lowercase-with-hyphens, unique), version (semver), manifest (slug, version, tier: 2, schema, operations, optional adminSchema, tools, requestedCapabilities, capabilityReasons, publicOperations, hasStaticRender), source (the full JS module; its default export is the plugin definition). " +
    "Returns {pluginId, status, validationErrors[]}; on failure read each error's `hint`, fix the source and resubmit in the same turn.",
  schema: submitPluginToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "version", "manifest", "source"],
    properties: {
      slug: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 120 },
      version: {
        type: "string",
        pattern: "^\\d+\\.\\d+\\.\\d+(-[a-z0-9.]+)?$",
        maxLength: 40,
      },
      manifest: {
        type: "object",
        additionalProperties: true,
      },
      source: { type: "string", minLength: 1, maxLength: 200_000 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    if (input.manifest.slug !== input.slug || input.manifest.version !== input.version)
      return {
        ok: false,
        content: "submit_plugin failed: slug and version must match the manifest.",
      };
    if (
      Array.isArray(input.manifest.requestedCapabilities) &&
      input.manifest.requestedCapabilities.length > 0
    ) {
      const staged = await execute(
        toolCtx.registry,
        toolCtx.adapter,
        ctx,
        "plugins.stage_installation",
        {
          manifest: input.manifest,
          source: input.source,
          origin: "runtime-authored",
        },
      );
      if (!staged.ok)
        return { ok: false, content: `submit_plugin failed: ${describeError(staged.error)}` };
      return {
        ok: true,
        content: `Submitted plugin ${input.slug} v${input.version} for installation review. An Owner must review its exact source and grant each requested capability at /security/plugins/installations. The package has not been activated.`,
      };
    }
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "plugins.submit", input);
    if (!r.ok) {
      return { ok: false, content: `submit_plugin failed: ${describeError(r.error)}` };
    }
    const { pluginId, status, validationErrors } = r.value as {
      pluginId: string;
      status: string;
      validationErrors: Array<{ kind: string; hint: string; snippet?: string }>;
    };
    if (status === "awaiting_activation") {
      return {
        ok: true,
        content:
          `Submitted plugin ${input.slug} v${input.version} (id=${pluginId}). Status: awaiting_activation. ` +
          `An Owner must click Approve at /security/plugins to activate. The plugin is NOT active yet.`,
      };
    }
    const errorList = validationErrors
      .map((e, i) => `  ${i + 1}. [${e.kind}] ${e.hint}${e.snippet ? ` — near: ${e.snippet}` : ""}`)
      .join("\n");
    return {
      ok: true,
      content:
        `Submitted plugin ${input.slug} v${input.version} (id=${pluginId}). Status: draft (validation failed).\n\n` +
        `Validator returned ${validationErrors.length} structured error${validationErrors.length === 1 ? "" : "s"}:\n${errorList}\n\n` +
        `Fix the source per each hint and resubmit. Plugins may import ONLY from "@caelo-cms/plugin-sdk".`,
    };
  },
};

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
    "Submit a plugin you wrote for validation + the Owner's approval. USE when the operator needs behaviour no existing tool or module gives (form storing entries, booking list, private notes tool).\n" +
    "CORE RULES:\n" +
    "- TWO-STEP: validates and queues only. The Owner approves the exact source at /settings/plugins (/settings/plugins/installations if it requests access) — say it is submitted for approval; never claim it is active.\n" +
    "- `slug` and `version` must equal the manifest's.\n" +
    "- Extra access must be requested + explained: `cms_admin_schema` for private author storage (declare `adminSchema`), `chat_runner_tools` for chat-callable tools (declare `tools`, each named `<slug_with_underscores>__<name>`); a reason per capability in `capabilityReasons`. The Owner sees every tool name + description verbatim — describe honestly what each does. Private-storage writes from a chat stay in the chat until it is published.\n" +
    "- Result has validationErrors[]; on failure read each `hint`, fix the source, resubmit in the same turn.",
  schema: submitPluginToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "version", "manifest", "source"],
    properties: {
      slug: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 55, description: "Unique." },
      version: {
        type: "string",
        pattern: "^\\d+\\.\\d+\\.\\d+(-[a-z0-9.]+)?$",
        maxLength: 40,
      },
      manifest: {
        type: "object",
        additionalProperties: true,
        description:
          "{slug, version, tier: 2, schema (public tables for its own visitor data), operations, optional adminSchema, tools, requestedCapabilities, capabilityReasons, publicOperations, hasStaticRender}.",
      },
      source: {
        type: "string",
        minLength: 1,
        maxLength: 4_000_000,
        description:
          "Full JS module; default export = the plugin definition. Sandboxed: import ONLY @caelo-cms/plugin-sdk; no fetch, Deno, dynamic import, eval/Function (nor calling a `.constructor`) or SQL; never alias or pass globalThis (write `globalThis.X` directly).",
      },
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
        content: `Submitted plugin ${input.slug} v${input.version} for installation review. An Owner must review its exact source and grant each requested capability at /settings/plugins/installations. The package has not been activated.`,
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
          `An Owner must click Approve at /settings/plugins to activate. The plugin is NOT active yet.`,
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

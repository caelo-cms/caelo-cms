// SPDX-License-Identifier: MPL-2.0

/**
 * P11 — `submit_plugin`. AI authors a Tier 2 plugin against the SDK
 * and submits it for Owner approval. CLAUDE.md §2: AI submits, human
 * Owner activates. The AI tool surface is Tier 2 only — Tier 1 plugins
 * ship via human PR + signed release.
 */

import { execute } from "@caelo/query-api";
import { type SubmitPluginToolInput, submitPluginToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const submitPluginTool: ToolDefinitionWithHandler<SubmitPluginToolInput> = {
  name: "submit_plugin",
  description:
    "Submit a Tier 2 plugin for validation + Owner approval. " +
    "TWO-STEP: this only validates and queues — an Owner must click Approve at /security/plugins to activate. DO NOT claim the plugin is active. " +
    "Tier 2 plugins are sandboxed (Deno --no-read --no-write --no-net); source must use ONLY @caelo/plugin-sdk imports (no fetch / Deno / dynamic imports / raw SQL). " +
    "Manifests must declare `tier: 2`; do NOT include `requestedCapabilities`, `workers`, or `tools` (those are Tier 1 / core only — submitting them gets rejected). " +
    "Schema invariant: any table with `page_id` MUST also declare `locale`. " +
    "Inputs: slug (lowercase-with-hyphens, unique site-wide), version (semver), manifest (JSON object: slug, version, tier=2, schema, operations, optional component, hasStaticRender), source (full JS module string). " +
    "Returns {pluginId, status, validationErrors[]}. On validation failure the AI sees structured `{kind, hint}` errors and can auto-fix + resubmit in the same turn — read each `hint` and adjust the source accordingly.",
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
        `Fix the source per each hint and resubmit. Plugins may import ONLY from "@caelo/plugin-sdk".`,
    };
  },
};

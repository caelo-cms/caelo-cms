// SPDX-License-Identifier: MPL-2.0

/**
 * issue #251 (WS5) — single source of truth for a tool's argument schema.
 *
 * Historically every tool hand-maintained TWO schemas: the Zod `schema`
 * (validated at dispatch) and a JSON `inputSchema` (shipped to the AI
 * provider). They drifted — a field declared `type: object` in one and
 * loosely typed in the other is exactly how the provider ends up under-
 * instructing the model, which then emits a stringified scalar/object that
 * the strict Zod parse rejects (findings F11/F12/F17, #245). Deriving the
 * provider JSON Schema FROM the Zod schema removes the second copy, so the
 * two can no longer diverge.
 *
 * Zod v4 ships `z.toJSONSchema`, so no converter dependency is needed.
 */

import { z } from "zod";
import type { ToolInputSchema } from "./dispatch.js";

/**
 * Derive the provider-facing JSON Schema for a tool's arguments from its
 * Zod `schema`. Uses `io: "input"` so `.default()`/preprocess fields carry
 * their pre-parse (accepted-input) shape — the model is instructed on what
 * it may SEND, not on the post-parse output — and `unrepresentable: "any"`
 * so a field Zod can't express as JSON Schema (e.g. a bare `z.unknown()`)
 * degrades to the permissive empty schema rather than throwing.
 *
 * The `$schema` dialect marker is stripped: the AI SDK's `jsonSchema()`
 * wrapper and the Anthropic/OpenAI/Gemini tool surfaces want the bare
 * schema object, and carrying the marker only adds noise to every request.
 *
 * @param schema the tool's Zod input schema (`ToolDefinitionWithHandler.schema`).
 * @returns a JSON Schema object suitable for `inputSchema`.
 */
export function generateInputSchema(schema: z.ZodType): ToolInputSchema {
  const json = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete json.$schema;
  return json as ToolInputSchema;
}

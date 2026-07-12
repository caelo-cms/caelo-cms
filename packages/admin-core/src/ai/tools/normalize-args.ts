// SPDX-License-Identifier: MPL-2.0

/**
 * issue #251 (WS5) — tolerant tool-argument normalization.
 *
 * Providers occasionally deliver tool-call arguments with scalar values
 * stringified (`position: "2"` where the inputSchema says integer) or
 * whole objects/arrays JSON-encoded as strings (`options: "[...]"`,
 * findings F11/F12/F17). Each such call used to bounce off the strict
 * Zod parse as a red error card in the operator's chat and burn a
 * retry turn. This layer repairs the *encoding* — guided strictly by
 * the tool's declared JSON inputSchema — before the Zod schema
 * validates the *content*. It never invents values and never touches a
 * property whose declared type already matches.
 *
 * Every repair is reported to the caller so dispatch can log it —
 * telemetry for the #245 root-cause hunt (which layer stringifies?),
 * per CLAUDE.md §4: the coercion is the seatbelt, not the diagnosis.
 */

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  [key: string]: unknown;
}

/** Result of a normalization pass: repaired args + what was repaired. */
export interface NormalizedArgs {
  args: unknown;
  /** JSON-pointer-ish paths that were coerced, e.g. `position`, `options`. */
  coercedPaths: string[];
}

const typeSet = (t: string | string[] | undefined): Set<string> =>
  new Set(typeof t === "string" ? [t] : Array.isArray(t) ? t : []);

function parseJsonIfPossible(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function coerceValue(value: unknown, schema: SchemaNode, path: string, out: string[]): unknown {
  const types = typeSet(schema.type);

  if (typeof value === "string") {
    // Declared integer/number, got a numeric string.
    if (types.has("integer") || types.has("number")) {
      const trimmed = value.trim();
      if (trimmed !== "" && !Number.isNaN(Number(trimmed))) {
        const n = Number(trimmed);
        if (!types.has("integer") || Number.isInteger(n)) {
          out.push(path);
          return n;
        }
      }
    }
    // Declared boolean, got "true"/"false".
    if (types.has("boolean") && (value === "true" || value === "false")) {
      out.push(path);
      return value === "true";
    }
    // Declared object/array, got a JSON-encoded string.
    if (types.has("object") || types.has("array")) {
      const parsed = parseJsonIfPossible(value);
      if (parsed !== undefined) {
        out.push(path);
        // Recurse: the decoded payload may itself carry stringified leaves.
        return coerceValue(parsed, schema, path, out);
      }
    }
    return value;
  }

  if (Array.isArray(value) && schema.items) {
    return value.map((v, i) => coerceValue(v, schema.items as SchemaNode, `${path}[${i}]`, out));
  }

  if (value !== null && typeof value === "object" && schema.properties) {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const propSchema = schema.properties[k];
      result[k] = propSchema ? coerceValue(v, propSchema, path ? `${path}.${k}` : k, out) : v;
    }
    return result;
  }

  return value;
}

/**
 * Repairs provider-side encoding damage on tool-call arguments, guided
 * by the tool's declared JSON inputSchema. Returns the repaired args
 * plus the list of coerced paths (empty when nothing needed repair).
 */
export function normalizeToolArgs(rawArgs: unknown, inputSchema: unknown): NormalizedArgs {
  const schema = (inputSchema ?? {}) as SchemaNode;
  const coercedPaths: string[] = [];

  // Whole-args-as-string: the top-level object arrived JSON-encoded.
  let args = rawArgs;
  if (typeof args === "string") {
    const parsed = parseJsonIfPossible(args);
    if (parsed !== undefined) {
      coercedPaths.push("(root)");
      args = parsed;
    }
  }

  return { args: coerceValue(args, schema, "", coercedPaths), coercedPaths };
}

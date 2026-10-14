// SPDX-License-Identifier: MPL-2.0

/**
 * Lighthouse describes a DOM element as a `node` details value (selector,
 * HTML snippet, label, explanation). The failing-audit findings
 * (lighthouse-extract.ts) and the Performance metrics
 * (lighthouse-metrics.ts) both reduce it to a `FlaggedElement`, the shape
 * the AI uses to find the module behind the element.
 */

import type { FlaggedElement } from "./ratchet.js";

const MAX_ELEMENT_TEXT = 300;

/** A non-empty string, truncated to the stored length; else undefined. */
export function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, MAX_ELEMENT_TEXT) : undefined;
}

/**
 * The element a Lighthouse `node` value describes, or null when the value
 * is not a node or names nothing usable.
 */
export function elementFromNode(node: unknown): FlaggedElement | null {
  if (node === null || typeof node !== "object") return null;
  const n = node as Record<string, unknown>;
  if (n.type !== undefined && n.type !== "node") return null;
  const element: FlaggedElement = {
    ...(nonEmpty(n.selector) ? { selector: nonEmpty(n.selector) } : {}),
    ...(nonEmpty(n.snippet) ? { snippet: nonEmpty(n.snippet) } : {}),
    ...(nonEmpty(n.nodeLabel) ? { label: nonEmpty(n.nodeLabel) } : {}),
    ...(nonEmpty(n.explanation) ? { explanation: nonEmpty(n.explanation) } : {}),
  };
  return Object.keys(element).length > 0 ? element : null;
}

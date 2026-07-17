// SPDX-License-Identifier: MPL-2.0

/**
 * Slice 1 (SDK approval gate) — operator-facing preview for a paused gated
 * tool call. §11.A requires the Owner sees WHAT they're approving + its
 * blast radius before clicking. The SDK's tool-approval-request carries only
 * the tool name + raw input; this turns that into a readable one-liner.
 *
 * This is the generic fallback. A gated tool that can compute a real
 * blast-radius (affected page count, redirects to be created) supplies a
 * richer `buildApprovalPreview` on its definition (Slice 2); until then the
 * operator still sees the concrete change being requested, never an opaque
 * "approve this tool call".
 */

/** Tool name → human label for the approval card headline. */
const TOOL_LABELS: Record<string, string> = {
  propose_update_layout: "Update the site layout",
  propose_delete_layout: "Delete a layout",
};

/** Compact, readable rendering of a tool call for the Approve/Reject card. */
export function buildApprovalPreview(name: string, args: unknown): string {
  const label = TOOL_LABELS[name] ?? name.replace(/^propose_/, "").replace(/_/g, " ");
  const argLines = renderArgs(args);
  return argLines.length > 0 ? `${label}\n${argLines}` : label;
}

/** One indented `key: value` line per top-level arg, values truncated. */
function renderArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `  ${k}: ${truncate(stringify(v))}`)
    .join("\n");
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, max = 160): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

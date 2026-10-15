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
  accept_quality_findings: "Accept these quality findings (only on the pages named)",
  publish_despite_failed_audit: "Publish live although the quality check failed",
  // The card is all the operator reads before an irreversible click, so it
  // names the consequence, not just the action.
  propose_rotate_gateway_cookie_secret:
    "Rotate the public gateway's cookie secret — every site visitor is logged out and re-identified (rate-limit and captcha state restart); this cannot be undone",
  propose_set_plugin_ai_cost_cap: "Change a plugin's AI spend cap (max AI cost per 24h)",
  propose_set_staging_access:
    "Change who can open the protected staging site (the unpublished work) — access modes, crawler login, IP allowlist",
  propose_set_staging_host:
    "Move the protected staging site to another host — it needs a DNS record and domain mapping before it answers",
  propose_rotate_staging_credentials:
    "Replace the staging crawler credentials — every crawler using the old one is locked out; this cannot be undone",
};

/** Longest preview the card stores (`chat.record_turn_approvals`). */
export const MAX_APPROVAL_PREVIEW_LENGTH = 120_000;

/**
 * Compact, readable rendering of a tool call for the Approve/Reject card.
 * `fullArgs` (#635) are shown whole, after the one-line args, because the
 * approver approves their exact text; everything else is cut to one line.
 * A preview that would not fit the card is refused rather than cut, since a
 * cut "full" argument would no longer be what gets approved.
 */
export function buildApprovalPreview(
  name: string,
  args: unknown,
  fullArgs: readonly string[] = [],
): string {
  const label = TOOL_LABELS[name] ?? name.replace(/^propose_/, "").replace(/_/g, " ");
  const full = new Set(fullArgs);
  const argLines = renderArgs(args, full);
  const fullBlocks = renderFullArgs(args, full);
  const preview = [label, argLines, fullBlocks].filter((part) => part.length > 0).join("\n");
  if (preview.length > MAX_APPROVAL_PREVIEW_LENGTH) {
    throw new Error(
      `${name}: the approval card would be ${preview.length} characters (limit ${MAX_APPROVAL_PREVIEW_LENGTH}) — shorten the arguments`,
    );
  }
  return preview;
}

/** One indented `key: value` line per top-level arg, values truncated. */
function renderArgs(args: unknown, full: ReadonlySet<string>): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args as Record<string, unknown>)
    .filter(([k]) => !full.has(k))
    .map(([k, v]) => `  ${k}: ${truncate(stringify(v))}`)
    .join("\n");
}

/** Each full arg as a `key:` header followed by its whole text. */
function renderFullArgs(args: unknown, full: ReadonlySet<string>): string {
  if (!args || typeof args !== "object" || full.size === 0) return "";
  return Object.entries(args as Record<string, unknown>)
    .filter(([k]) => full.has(k))
    .map(([k, v]) => `--- ${k} (exactly as approved) ---\n${stringify(v)}`)
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

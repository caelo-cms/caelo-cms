// SPDX-License-Identifier: MPL-2.0

/**
 * Validate a gated tool's payload BEFORE asking the operator to approve it.
 *
 * The click is the scarce resource the §11.A gate exists to obtain, and until
 * now it could be spent on a proposal that then failed a schema check. On
 * 2026-07-28 an operator approved the same theme three times: each time the
 * card appeared, the click landed, and only then did `themes.propose_create`
 * reject the payload — once for a `motion` token written as the CSS shorthand
 * `"180ms ease"`. The model corrected and re-proposed; the operator clicked
 * again. Two of the three clicks bought nothing.
 *
 * Validating at call time turns that into a normal AI-actionable rejection:
 * the model gets the error immediately, fixes it, and only a proposal that can
 * actually apply ever reaches a human.
 *
 * The rejection is expressed the SDK's own way — a `tool-approval-response`
 * with `approved: false` and the validation error as its reason (CLAUDE.md
 * §12: use the SDK's shape, do not invent a parallel one). No card is shown
 * and no operator decision is recorded, because none was asked for.
 *
 * Only the SHAPE is checked here. Whether a proposal is a good idea is exactly
 * what the human is for; this removes the proposals that were never applicable
 * in the first place.
 */

import type { OperationRegistry } from "@caelo-cms/query-api";

import type { ToolRegistry } from "../tools/index.js";

/** A payload that cannot apply, phrased for the model that has to fix it. */
export interface PreflightRejection {
  readonly toolName: string;
  readonly reason: string;
}

/**
 * Returns a rejection when the gated tool's arguments cannot satisfy the
 * propose op it would run, or null when the proposal is worth a click.
 *
 * Unknown tool, non-gated tool, or an op we cannot resolve → null. A preflight
 * that guesses would block legitimate proposals, and the post-approval path
 * still validates; this only moves a rejection earlier when it is certain.
 */
export function preflightGatedCall(
  tools: ToolRegistry,
  registry: OperationRegistry,
  toolName: string,
  args: unknown,
): PreflightRejection | null {
  // Anything we cannot inspect is not something we can rule out. A preflight
  // that throws would turn a cost optimisation into a broken turn.
  if (typeof tools?.get !== "function") return null;
  const tool = tools.get(toolName);
  const proposeOp = tool?.gated?.proposeOp;
  if (!proposeOp) return null;

  if (typeof registry?.lookup !== "function") return null;
  const op = registry.lookup(proposeOp);
  if (!op.ok) return null;

  const parsed = op.value.input.safeParse(args);
  if (parsed.success) return null;

  // The model reads this, so it names the op that would have failed and the
  // failing paths rather than dumping a Zod tree.
  const issues = parsed.error.issues
    .slice(0, 6)
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `- \`${path}\`: ${i.message}`;
    })
    .join("\n");
  return {
    toolName,
    reason:
      `${toolName} was NOT shown to the operator: its payload cannot satisfy ${proposeOp}, ` +
      `so approving it would have failed.\n${issues}\n` +
      "Fix the named fields and call the tool again. Do not ask the operator about this — " +
      "no approval was requested and none is pending.",
  };
}

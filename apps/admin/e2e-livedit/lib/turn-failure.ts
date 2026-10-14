// SPDX-License-Identifier: MPL-2.0

/**
 * Turn-fatal errors → the scenario's failure message.
 *
 * When a chat turn dies on the provider call (spending limit, rejected
 * history, overload after the SDK's retries, cost cap), the chat-runner files
 * an `ai_bug_reports` row titled {@link TURN_FAILURE_TITLE} and the turn ends
 * quietly — so the scenario carried on and failed later on a downstream
 * assertion ("module is null", "no <h1>", a 6-minute Stage wait) that pointed
 * nowhere near the cause (run 38455081117). `sendChatPromptAndWait` reads
 * those rows after every turn and fails with the provider's own message
 * instead. Playwright-free so the message shape is unit-tested.
 */

/** Title `fileTurnFatalProviderReport` (admin-core chat-runner) files under. */
export const TURN_FAILURE_TITLE = "AI turn failed: provider error";

export interface TurnFailureReport {
  readonly createdAt: string;
  readonly whatHappened: string;
}

/**
 * The error a scenario should fail with, or null when no top-level turn
 * failed. `prompt` is the start of the operator message the turn answered.
 */
export function turnFailureError(
  reports: readonly TurnFailureReport[],
  prompt: string,
): Error | null {
  if (reports.length === 0) return null;
  const distinct = [...new Set(reports.map((r) => r.whatHappened.trim()))];
  const head = prompt.replace(/\s+/g, " ").slice(0, 80);
  return new Error(
    `The AI turn for "${head}${prompt.length > 80 ? "…" : ""}" died on a turn-fatal error ` +
      `(${reports.length} ${TURN_FAILURE_TITLE} report(s)) — the scenario stops here instead of ` +
      `failing on a downstream assertion:\n` +
      distinct.map((m) => `  - ${m.slice(0, 600)}`).join("\n") +
      `\nA spending/usage limit, invalid key or provider outage is an account/provider problem, ` +
      `not a regression; anything else is a Caelo bug (see the report's evidence in bug-reports.json).`,
  );
}

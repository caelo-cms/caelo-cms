// SPDX-License-Identifier: MPL-2.0

/**
 * #834 / #835 — the wording Publish live's parity refusal shares between
 * the server that writes it (admin-core `build-parity.ts`) and the Live
 * edit toolbar that renders it. The toolbar truncates long errors, so it
 * recognises a parity refusal by its prefix and shows the next step
 * ("Stage again") as its own, untruncated hint next to the button.
 */

/** Every parity refusal starts with this. */
export const PARITY_REFUSAL_PREFIX = "Publish live stopped:";

/**
 * The next step every parity refusal ends with. Operators use the
 * toolbar's "Stage again" button next to Publish live; the AI re-stages
 * with its tools.
 */
export const RESTAGE_NEXT_STEP =
  'Next step: Stage again (the "Stage again" button next to Publish live, or stage_changes / deploy_staging in chat), check staging, then Publish live.';

/** True when `message` is a Publish-live parity refusal. */
export function isParityRefusal(message: string): boolean {
  return message.startsWith(PARITY_REFUSAL_PREFIX);
}

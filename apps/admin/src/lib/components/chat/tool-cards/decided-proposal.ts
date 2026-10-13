// SPDX-License-Identifier: MPL-2.0

/** A proposal the operator decided on its tool card (ProposeCard → ChatPanel). */
export interface DecidedProposal {
  readonly proposalId: string;
  readonly kind: string;
  readonly action: "approve" | "reject";
  /** What `onDecisionStart` returned at the click (issue #658: Stop ordering). */
  readonly ticket?: number;
}

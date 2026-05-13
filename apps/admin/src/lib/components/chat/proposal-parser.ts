// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.13 — shared canonical-shape parser for propose-style tool results.
 *
 * Every propose tool emits the v0.5.11-locked content shape:
 *   "Queued proposal <uuid>: <summary>. ... /security/<domain>/pending ..."
 *
 * Both `ProposeCard` (renders inline Approve / Reject) and
 * `ChatPanel`'s optimistic pending-strip push need to extract the
 * proposalId, summary, queue URL, and domain from that string. Pre-
 * v0.5.13 ProposeCard had its own inline regex; v0.5.13 lifts it into
 * this module so the two surfaces stay in sync, and the v0.5.11
 * `propose-content-shape.test.ts` wording-lock keeps the upstream
 * content contract honest.
 */

/** v0.5.11 canonical content shape. Anchored at start of string. */
export const PROPOSAL_CONTENT_PATTERN = /^Queued proposal ([0-9a-f-]{36}):\s*([^.]+)\./;

/** Queue URL embedded in the content, e.g. `/security/layouts/pending`. */
export const PROPOSAL_QUEUE_URL_PATTERN = /(\/security\/([^\s/.]+)\/pending)/;

export interface ParsedProposal {
  readonly proposalId: string;
  readonly summary: string;
  readonly queueUrl: string;
  readonly domain: string;
}

/**
 * Parse a propose-style tool's success content. Returns null for
 * non-canonical strings (the v0.5.11 lock means every shipped tool
 * matches this shape; future broken shapes return null and degrade
 * gracefully to plain markdown).
 */
export function parseProposalContent(content: string): ParsedProposal | null {
  const proposalMatch = PROPOSAL_CONTENT_PATTERN.exec(content);
  const queueMatch = PROPOSAL_QUEUE_URL_PATTERN.exec(content);
  if (!proposalMatch || !queueMatch) return null;
  const proposalId = proposalMatch[1];
  const summary = proposalMatch[2]?.trim();
  const queueUrl = queueMatch[1];
  const domain = queueMatch[2];
  if (!proposalId || !summary || !queueUrl || !domain) return null;
  return { proposalId, summary, queueUrl, domain };
}

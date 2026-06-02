// SPDX-License-Identifier: MPL-2.0

/**
 * Canonical status vocabulary for the propose/execute pattern (CLAUDE.md
 * §11.A, `docs/propose-execute-pattern.md`). Every gated domain's
 * `<domain>_pending_actions` row moves through these four states:
 *
 *   pending    — AI/Owner queued the proposal; awaiting a human click.
 *   applied    — Owner approved; `execute_proposal` ran the real op.
 *   rejected   — Owner declined (with an optional reason).
 *   superseded — a newer proposal for the same target replaced this one
 *                (dedup/GC), so it can never be approved.
 *
 * Lives in `@caelo-cms/shared` so the ~14 pending-op Zod schemas import one
 * source instead of re-typing the literal — which is how the four states
 * stay value-identical across every domain that adopted the pattern.
 *
 * Domains that need extra states extend this rather than re-typing it:
 *   - list-filter ops add `"all"`:  `z.enum([...PROPOSAL_STATUSES, "all"] as const)`
 *   - themes adds `"cancelled"`:    `z.enum([...PROPOSAL_STATUSES, "cancelled"] as const)`
 *   - deploy proposals never get `"superseded"`: `proposalStatus.exclude(["superseded"])`
 * Keep the `as const` on any spread so `z.enum` infers the literal union,
 * not `string[]`.
 *
 * NOTE: this is NOT the vocabulary for skill/AI-memory *review* status
 * (`accepted`/`rejected`) nor for deploy/translation *run* status
 * (`running`/`succeeded`/…) — those are different value sets and must not
 * be collapsed into this enum.
 */

import { z } from "zod";

/** The four propose/execute states, in canonical order. */
export const PROPOSAL_STATUSES = ["pending", "applied", "rejected", "superseded"] as const;

/** Zod enum over {@link PROPOSAL_STATUSES} — the single source for every gated-domain `status` schema. */
export const proposalStatus = z.enum(PROPOSAL_STATUSES);

/** Union of the four propose/execute states. */
export type ProposalStatus = z.infer<typeof proposalStatus>;

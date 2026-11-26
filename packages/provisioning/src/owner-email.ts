// SPDX-License-Identifier: MPL-2.0

/**
 * The Owner email of an install the wizard resumes.
 *
 * The address decides who passes the admin's Google sign-in gate before any
 * Caelo user exists: the stacks' `iapAllowlist` and the operator-access
 * job's static members (operator-access.ts installIapAllowlist). A typo
 * therefore locks everyone out of `/setup`, and a re-run is how the operator
 * corrects it: `--owner-email`, or the prompt with the recorded address
 * prefilled. Before, a resumed install always took the recorded address and
 * dropped what the operator typed.
 *
 * install.json is the one record the rest reads (the converge half of the
 * install, `upgrade`, `status`), so a correction is written there before any
 * step runs, and the same run applies it: `pulumi up` sets the stacks' IAP
 * members, the operator-access step redeploys the job with the new static
 * members, the summary names the address the Owner setup link is for. The
 * link's token is not bound to an address and stays valid. The converge job
 * (converge-job-gcp.ts) keeps refusing while install.json and the deployed
 * job disagree, so until this run got that far an in-product cloud-setup
 * update waits; its check is not relaxed.
 *
 * An install that is provisioned may have an Owner already. The address can
 * still change there: whoever runs the installer holds the project's IAM
 * rights and could add any IAP member directly, so refusing would protect
 * nothing, while a dead address would stay an IAP member for good. In a
 * terminal the change is confirmed, and it says what it leaves alone: the
 * Caelo accounts, which Settings → Users manages.
 */

import { cancel, confirm, isCancel, log, note, text } from "@clack/prompts";
import { bold } from "kleur/colors";
import { type InstallMetadata, isStepDone, readMetadata, writeMetadata } from "./install-state.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why `value` is not a usable Owner email, or undefined when it is. */
export function ownerEmailProblem(value: string): string | undefined {
  if (value.trim().length === 0) return "Email is required";
  if (!EMAIL.test(value.trim())) return "Looks like an invalid email";
  return undefined;
}

/** Whether two spellings name the same address, as IAP compares them (installIapAllowlist). */
export function sameOwnerEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Whether the install's first `pulumi up` finished, so its admin exists and
 * an Owner may be set up. Read from the progress checkpoint every resume
 * already relies on.
 */
export function isProvisioned(meta: Pick<InstallMetadata, "installId" | "projectId">): boolean {
  return meta.projectId !== null && isStepDone(meta.installId, `pulumi-up-${meta.projectId}`);
}

/** What a resumed install's Owner email becomes. */
export type OwnerEmailDecision =
  | { readonly kind: "keep" }
  | { readonly kind: "change"; readonly from: string; readonly to: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "refuse"; readonly error: string };

/** The operator side of {@link decideOwnerEmail}; clack in the CLI, fakes in tests. */
export interface OwnerEmailPrompts {
  /** Ask for the address with `recorded` prefilled; null when cancelled. */
  readonly ask: (recorded: string) => Promise<string | null>;
  /** Confirm a change on a provisioned install; null when cancelled. */
  readonly confirm: (message: string) => Promise<boolean | null>;
  /** Show the operator what a change does. */
  readonly note: (lines: readonly string[]) => void;
}

/** What changing the address on a provisioned install does, and what it leaves alone. */
export function ownerEmailChangeLines(from: string, to: string): string[] {
  return [
    `The Owner email changes from ${from} to ${to}:`,
    `  - ${to} gets through the admin's Google sign-in (IAP), and the Owner setup link is for it;`,
    `  - ${from} no longer gets through, unless it belongs to a Caelo user.`,
    "If an Owner is set up already, the Caelo accounts stay as they are: manage them under Settings → Users.",
    "It takes effect when this run has finished the install.",
  ];
}

/**
 * Settle the Owner email of a resumed install: `requested` (`--owner-email`)
 * when given, else the operator's answer to a prompt with the recorded
 * address prefilled, else (non-interactive) the recorded one. A change on an
 * install that is not provisioned is a plain correction. On a provisioned one
 * the operator sees what it does and, in a terminal, confirms it; declining
 * keeps the recorded address.
 */
export async function decideOwnerEmail(
  input: {
    readonly recorded: string;
    readonly requested?: string;
    readonly nonInteractive: boolean;
    readonly provisioned: boolean;
  },
  prompts: OwnerEmailPrompts,
): Promise<OwnerEmailDecision> {
  let wanted: string;
  if (input.requested !== undefined) {
    const problem = ownerEmailProblem(input.requested);
    if (problem) return { kind: "refuse", error: `--owner-email ${input.requested}: ${problem}.` };
    wanted = input.requested.trim();
  } else if (input.nonInteractive) {
    return { kind: "keep" };
  } else {
    const answer = await prompts.ask(input.recorded);
    if (answer === null) return { kind: "cancelled" };
    wanted = answer.trim();
  }
  if (sameOwnerEmail(wanted, input.recorded)) return { kind: "keep" };
  const change = { kind: "change", from: input.recorded, to: wanted } as const;
  if (!input.provisioned) return change;
  prompts.note(ownerEmailChangeLines(input.recorded, wanted));
  if (input.nonInteractive) return change;
  const ok = await prompts.confirm(`Change the Owner email to ${wanted}?`);
  if (ok === null) return { kind: "cancelled" };
  return ok ? change : { kind: "keep" };
}

/**
 * Record `ownerEmail` in install.json (the bucket's copy for an install whose
 * state lives there), over what install.json holds now.
 *
 * @returns the metadata as now recorded
 */
export function recordOwnerEmail(installId: string, ownerEmail: string): InstallMetadata {
  const current = readMetadata(installId);
  if (!current) throw new Error(`No install.json for install '${installId}'.`);
  const next: InstallMetadata = { ...current, ownerEmail };
  writeMetadata(installId, next);
  return next;
}

/** {@link OwnerEmailPrompts} in the terminal. */
export const clackOwnerEmailPrompts: OwnerEmailPrompts = {
  ask: async (recorded) => {
    const value = await text({
      message:
        "Owner email (gets through the admin's Google sign-in; the Owner setup link is for this address)",
      initialValue: recorded,
      validate: (v) => ownerEmailProblem(v ?? ""),
    });
    return isCancel(value) ? null : String(value);
  },
  confirm: async (message) => {
    const value = await confirm({ message, initialValue: true });
    return isCancel(value) ? null : value;
  },
  note: (lines) => note(lines.join("\n"), "Owner email"),
};

/** Options of {@link resolveResumedOwnerEmail}. */
export interface ResumedOwnerEmailOpts {
  /** `--owner-email`, when given. */
  readonly requested?: string | undefined;
  readonly nonInteractive: boolean;
}

/**
 * {@link decideOwnerEmail} in the terminal for a resumed install.
 *
 * @returns the address to record when it changes, or null to keep the
 *   recorded one. Exits on a cancel or a malformed `--owner-email`.
 */
export async function resolveResumedOwnerEmail(
  meta: InstallMetadata,
  opts: ResumedOwnerEmailOpts,
  prompts: OwnerEmailPrompts = clackOwnerEmailPrompts,
): Promise<string | null> {
  const decision = await decideOwnerEmail(
    {
      recorded: meta.ownerEmail,
      ...(opts.requested !== undefined ? { requested: opts.requested } : {}),
      nonInteractive: opts.nonInteractive,
      provisioned: isProvisioned(meta),
    },
    prompts,
  );
  switch (decision.kind) {
    case "keep":
      return null;
    case "change":
      log.info(`Owner email: ${decision.from} → ${bold(decision.to)}`);
      return decision.to;
    case "cancelled":
      cancel("Cancelled.");
      process.exit(0);
      break;
    case "refuse":
      cancel(decision.error);
      process.exit(2);
  }
}

/**
 * {@link resolveResumedOwnerEmail}, recorded in install.json when it
 * changes: the Owner email a resumed install continues with. For an install
 * without an install job; job mode records under the job's launch lock
 * (wizards/gcp-install-job.ts).
 */
export async function settleResumedOwnerEmail(
  meta: InstallMetadata,
  opts: ResumedOwnerEmailOpts,
  prompts: OwnerEmailPrompts = clackOwnerEmailPrompts,
): Promise<string> {
  const changed = await resolveResumedOwnerEmail(meta, opts, prompts);
  return changed === null ? meta.ownerEmail : recordOwnerEmail(meta.installId, changed).ownerEmail;
}

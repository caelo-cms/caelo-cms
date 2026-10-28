// SPDX-License-Identifier: MPL-2.0

/**
 * Environment of the bug intake. Every value is required: a missing one
 * stops the service at boot with the variable named (CLAUDE.md §2), rather
 * than an intake that silently files nothing — or files without limits.
 */

import { z } from "zod";

const repoSlug = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo");

/** "true" / "false" only: a typo must not leave the kill switch in an unknown state. */
const boolFlag = z.enum(["true", "false"]).transform((v) => v === "true");

const intakeEnv = z.object({
  /** Cloud Run injects PORT. */
  PORT: z.coerce.number().int().min(1),
  /** GitHub App that files the issues (Issues: write + Metadata: read, nothing else). */
  GITHUB_APP_ID: z.string().min(1),
  /** The App's private key, PEM (PKCS#1 as GitHub issues it, or PKCS#8). */
  GITHUB_APP_PRIVATE_KEY: z.string().includes("PRIVATE KEY"),
  /** The App installation on the caelo-cms organisation. */
  GITHUB_APP_INSTALLATION_ID: z.string().regex(/^\d+$/),
  /** Public repository the issues are filed in. */
  BUG_INTAKE_PUBLIC_REPO: repoSlug,
  /**
   * GCP project and Firestore database holding clusters, pinned keys and raw
   * reports. Named explicitly instead of inferred from the runtime so the
   * intake can never write into whatever project it happens to run in.
   * Credentials come from the runtime service account (ADC), never a key file.
   */
  BUG_INTAKE_FIRESTORE_PROJECT: z
    .string()
    .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "expected a GCP project id"),
  BUG_INTAKE_FIRESTORE_DATABASE: z
    .string()
    .regex(/^(\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/, "expected a Firestore database id"),
  /** Distinct installs a defect needs before it gets a public issue (1 = every defect). */
  BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS: z.coerce.number().int().min(1),
  /**
   * New public issues per UTC day. Registration is unauthenticated (TOFU), so
   * at threshold 1 anyone can file; this bounds what that costs. Defects over
   * the cap are stored and get their issue on a later day.
   */
  BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY: z.coerce.number().int().min(1),
  /**
   * New public suggestion issues per UTC day (#1192): a slot pool of its
   * own, so suggestions never take a defect's slot (the cap above counts
   * defects only). Same queueing as defects; 0 keeps suggestions stored and
   * queued without filing any. Digits only: an empty value must not coerce
   * to that 0.
   */
  BUG_INTAKE_MAX_NEW_SUGGESTIONS_PER_DAY: z
    .string()
    .regex(/^\d+$/, "expected an integer ≥ 0")
    .transform(Number),
  /** Kill switch for defects and suggestions: reports are still accepted and stored, GitHub is not written. */
  BUG_INTAKE_ISSUES_PAUSED: boolFlag,
  /** Registrations per hour across all clients, on top of the per-address limit. */
  BUG_INTAKE_MAX_REGISTRATIONS_PER_HOUR: z.coerce.number().int().min(1),
  /** Key and model for matching differently worded AI reports of the same defect. */
  ANTHROPIC_API_KEY: z.string().min(1),
  BUG_INTAKE_MATCH_MODEL: z.string().min(1),
});

export type IntakeEnv = z.infer<typeof intakeEnv>;

/** Parse the process environment; throws naming every missing or invalid variable. */
export function loadIntakeEnv(env: Record<string, string | undefined>): IntakeEnv {
  const parsed = intakeEnv.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`bug intake configuration is incomplete:\n  ${problems.join("\n  ")}`);
  }
  return parsed.data;
}

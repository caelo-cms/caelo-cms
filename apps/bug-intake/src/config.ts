// SPDX-License-Identifier: MPL-2.0

/**
 * Environment of the bug intake. Every value is required: a missing one
 * stops the service at boot with the variable named (CLAUDE.md §2), rather
 * than an intake that silently files nothing.
 */

import { z } from "zod";

const repoSlug = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo");

const intakeEnv = z.object({
  /** Cloud Run injects PORT. */
  PORT: z.coerce.number().int().min(1),
  /** GitHub App that files the issues and writes the data repo. */
  GITHUB_APP_ID: z.string().min(1),
  /** The App's private key, PEM (PKCS#1 as GitHub issues it, or PKCS#8). */
  GITHUB_APP_PRIVATE_KEY: z.string().includes("PRIVATE KEY"),
  /** The App installation on the caelo-cms organisation. */
  GITHUB_APP_INSTALLATION_ID: z.string().regex(/^\d+$/),
  /** Public repository the issues are filed in. */
  BUG_INTAKE_PUBLIC_REPO: repoSlug,
  /** Private repository holding clusters, pinned keys and raw reports. */
  BUG_INTAKE_DATA_REPO: repoSlug,
  /** Distinct installs a defect needs before it gets a public issue (1 = every defect). */
  BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS: z.coerce.number().int().min(1),
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

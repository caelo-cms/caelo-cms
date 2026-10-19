// SPDX-License-Identifier: MPL-2.0

/**
 * The e2e-only auto-approve switch (CLAUDE.md §11.A): autonomous test runs
 * set `CAELO_E2E_AUTO_APPROVE_PROPOSALS=1` so a gated tool call does not
 * stall waiting for a click nobody will make.
 *
 * It is the one switch that removes the human from the §11.A gate, so it
 * never takes effect under `NODE_ENV=production` — a copied env file or a
 * leftover container variable must not turn every Approve card into an
 * automatic yes on a real install (PR #863, M-11). The e2e stacks run the
 * admin outside production mode already (the test provider registry needs
 * it too, see providers/test-registry.ts), so the guard costs them nothing.
 */

/**
 * Whether gated tool calls and `propose_*` results are approved without a
 * click in this process.
 *
 * @param env - the environment to read; defaults to `process.env`.
 */
export function isE2eAutoApproveEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.CAELO_E2E_AUTO_APPROVE_PROPOSALS === "1" && env.NODE_ENV !== "production";
}

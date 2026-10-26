// SPDX-License-Identifier: MPL-2.0

/**
 * Resolve the root directory that relative `deploy_targets.out_dir`
 * values are joined against.
 *
 * Migration run #9 R10 (issue #262): defaulting straight to
 * `process.cwd()` silently couples build placement to wherever the
 * admin process happens to run. In dev-compose the Caddy containers
 * bind-mount the *checkout's* `apps/admin/output/<env>`, so an admin
 * started from a worktree/tmp copy wrote every build into a directory
 * nothing served — while reporting success. `CAELO_OUTPUT_ROOT` lets an
 * operator pin the output root to the directory the serving layer
 * actually mounts (for the dev compose stack: `<checkout>/apps/admin`).
 * An explicit per-call `repoRoot` (tests) still wins.
 */
export function resolveOutputRoot(explicit?: string): string {
  return explicit ?? process.env.CAELO_OUTPUT_ROOT ?? process.cwd();
}

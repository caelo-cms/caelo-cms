// SPDX-License-Identifier: MPL-2.0

/**
 * Tools that only work on some install kinds.
 *
 * A tool the AI is offered but that cannot work on this install is worse than
 * no tool: the model reaches for it (it is in the tool list and the playbook
 * names it), gets an error, and only then falls back — a wasted round-trip and
 * an auto-filed bug report on every such install (e2e-livedit, 2026-10:
 * `inspect_built_page` failed with "only available on GCP installs" in four
 * runs). So the catalogue and the system prompt leave such a tool out
 * entirely where it cannot run. The install kind is fixed per process, so the
 * catalogue and prompt stay byte-stable within a run (prompt-cache safe).
 *
 * The tools stay REGISTERED everywhere: skill allowlists and the release's
 * Power-MCP snapshot name them by their real names, and a GCP install needs
 * them. Only what the AI is offered changes.
 */

/** The process env the availability rules read (`CAELO_PROVIDER`). */
export type InstallEnv = Readonly<Record<string, string | undefined>>;

/**
 * True on the GCP install kinds (`gcp`, `gcp-firebase`) — the ones whose
 * Stage and Confirm-publish write the built site to GCS buckets the admin can
 * read back.
 */
export function isGcpInstall(env: InstallEnv): boolean {
  const provider = env.CAELO_PROVIDER?.trim();
  return provider === "gcp" || provider === "gcp-firebase";
}

/**
 * Each install-dependent tool and the rule that says whether it can run here.
 * `inspect_built_page` reads the staged/live build from GCS; self-hosted,
 * AWS and Azure installs have no such bucket API.
 */
const INSTALL_DEPENDENT_TOOLS: ReadonlyMap<string, (env: InstallEnv) => boolean> = new Map([
  ["inspect_built_page", isGcpInstall],
]);

/**
 * The tool names that cannot run on this install and must therefore be
 * left out of every catalogue the AI sees.
 *
 * @param env - usually `process.env`; tests pass a literal.
 */
export function installUnavailableToolNames(env: InstallEnv): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [name, isAvailable] of INSTALL_DEPENDENT_TOOLS) {
    if (!isAvailable(env)) out.add(name);
  }
  return out;
}

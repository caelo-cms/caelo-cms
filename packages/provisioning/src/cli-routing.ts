// SPDX-License-Identifier: MPL-2.0

/**
 * Argv → command routing for `cms-provision`, kept free of side effects so
 * it can be unit-tested (cli.ts dispatches at module load).
 *
 * The documented one-command entry point (CLAUDE.md §11.C) is
 * `bunx @caelo-cms/provisioning --provider gcp --domain …` — flags only,
 * no sub-command. That shape must reach the wizard; treating the first
 * flag as an unknown sub-command silently prints usage instead.
 */

/** What the CLI should do for a given argv. */
export type CliRoute = { kind: "handler"; name: string } | { kind: "wizard" } | { kind: "usage" };

/**
 * Resolve the route for `argv` (a full `process.argv`, so the sub-command
 * sits at index 2).
 *
 * @param handlerNames - registered sub-commands; flag-shaped names such as
 *   `--version` win over the wizard fallback.
 */
export function resolveCliRoute(argv: readonly string[], handlerNames: Iterable<string>): CliRoute {
  const first = argv[2];
  if (first !== undefined && new Set(handlerNames).has(first)) {
    return { kind: "handler", name: first };
  }
  const flagsOnly = first === undefined || first.startsWith("-");
  if (!flagsOnly) return { kind: "usage" };
  if (argv.includes("--no-wizard") || argv.includes("--help") || argv.includes("-h")) {
    return { kind: "usage" };
  }
  return { kind: "wizard" };
}

/**
 * Whether `init --provider <p>` belongs to the wizard. Only self-hosted
 * keeps the compose-file `init` flow; every cloud provider is provisioned
 * end-to-end by the wizard rather than by printed manual Pulumi steps.
 */
export function initDelegatesToWizard(provider: string): boolean {
  return provider !== "self-hosted";
}

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
  // #707 — `--provider self-hosted --domain … --owner-email …` is the
  // self-hosted one-command install: `init` writes `.caelo/` and starts the
  // stack. (The cloud wizard has nothing to provision for it.)
  const provider = argv.indexOf("--provider");
  if (provider !== -1 && argv[provider + 1] === "self-hosted") {
    return { kind: "handler", name: "init" };
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

/** One documented `cms-provision` sub-command (the usage text and the public CLI reference). */
export interface CliCommandDoc {
  /** The sub-command as typed, e.g. `upgrade` or `state migrate`. */
  readonly name: string;
  /** Arguments and flags in usage notation; empty when it takes none. */
  readonly args: string;
  /** One sentence for an operator: what it does and when to run it. */
  readonly summary: string;
}

/**
 * The documented sub-commands, in usage order. The single source for both
 * the usage text `cms-provision --help` prints ({@link cliUsage}) and the
 * provisioning CLI page of the developer reference mirrored into the docs
 * on every release (scripts/docs-reference.ts, #828), so the two never
 * drift. Internal entry points (`install-job`, `agent`, the
 * `*-self-hosted` aliases) are deliberately absent.
 */
export const CLI_COMMANDS: readonly CliCommandDoc[] = [
  {
    name: "init",
    args: "--domain <d> --owner-email <e> [--staging-domain <host>] [--version x.y.z] [--tls acme|internal] [--http-port 80] [--https-port 443]",
    summary:
      "Self-hosted only: write the install's config with fresh secrets, verify the signed release images and start the Docker Compose stack; prints the Owner setup link. Cloud providers run the wizard instead.",
  },
  {
    name: "up",
    args: "",
    summary:
      "Self-hosted only: converge the database roles, re-emit the Compose file and Caddyfile, and (re)start the stack.",
  },
  {
    name: "migrate",
    args: "",
    summary:
      "Self-hosted only: apply the database migrations with the admin image the install runs. Idempotent.",
  },
  {
    name: "status",
    args: "[--install <id|domain|all>]",
    summary: "Show the install's health and its estimated monthly cost.",
  },
  {
    name: "upgrade",
    args: "[--version x.y.z] [--channel stable|rc|beta] [--region <r>] [--skip-verify] [--skip-health-check] [--install <id|domain|all>]",
    summary:
      "Roll the install to a newer release (latest stable by default) after verifying the image signatures.",
  },
  {
    name: "backup",
    args: "[--to <file>] [--install <id|domain|all>]",
    summary:
      "Take a backup now: an on-demand Cloud SQL backup on cloud installs, an archive of the databases, published site and media on self-hosted.",
  },
  {
    name: "restore",
    args: "--from <backup.tar.gz> --yes",
    summary:
      "Self-hosted only: replace both databases, the published site and the media with a backup archive. Destructive.",
  },
  {
    name: "rotate-secret",
    args: "<name>",
    summary: "Rotate one of the install's runtime secrets; run without a name to list them.",
  },
  {
    name: "truncate",
    args: "",
    summary:
      "Delete all content and history while keeping users, roles, providers, domains and settings. Destructive.",
  },
  {
    name: "destroy",
    args: "",
    summary: "Permanently delete the install and every resource it created. Asks twice.",
  },
  {
    name: "regenerate-caddy",
    args: "",
    summary: "Self-hosted only: re-emit the Caddyfile from the install's domains and reload Caddy.",
  },
  {
    name: "admin-domain",
    args: "enable",
    summary:
      "gcp-firebase: bind admin.<domain> to the admin and wait for its TLS certificate (resumable).",
  },
  {
    name: "staging-domain",
    args: "enable [--staging-domain <host>] [--rotate-staging-password] [--show-staging-password]",
    summary:
      "gcp-firebase: bind the protected staging host and set up its basic auth; prints the credentials on the first run.",
  },
  {
    name: "owner-reset",
    args: "[--install <id>] [--email <addr>]",
    summary:
      "Print a one-time password-reset link for a locked-out Owner on installs whose admin cannot send email.",
  },
  {
    name: "state migrate",
    args: "[--install <id|domain>] [--to remote|local] [--dry-run] [--yes]",
    summary: "Move the install's Pulumi state into (or out of) the install's own cloud project.",
  },
  {
    name: "attach",
    args: "--project <gcp-project-id>",
    summary: "Set up this machine to manage an existing install whose state lives in its project.",
  },
  {
    name: "pulumi-output-sync",
    args: "",
    summary:
      "Copy the stack outputs into the admin so its DNS and settings pages show current values; run after a manual `pulumi up`.",
  },
  {
    name: "version",
    args: "",
    summary: "Print the CLI's version.",
  },
];

/** The text `cms-provision --help` prints, built from {@link CLI_COMMANDS}. */
export function cliUsage(): string {
  return (
    `Usage: cms-provision [wizard] [--provider <name> --domain <d> [--staging-domain <host>] --owner-email <e> --region <r>] [--local|--install-job] | <${CLI_COMMANDS.map((c) => c.name).join("|")}> [options]\n` +
    "With several installs on this machine, pick one with --install <install-id or domain> (status, upgrade and backup also take --install all); in a terminal you are asked otherwise.\n" +
    "Pass --no-wizard with no sub-command to print this usage instead of the wizard."
  );
}

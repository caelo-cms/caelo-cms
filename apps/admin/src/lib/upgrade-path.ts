// SPDX-License-Identifier: MPL-2.0

import {
  cloudShellUpgradeCommand,
  cloudShellUpgradeUrl,
  installHintFromSiteUrl,
  provisioningCommand,
  provisioningUpgradeCommand,
} from "@caelo-cms/shared";

/**
 * How the Owner upgrades THIS install (issue #696 Phase 0), as Settings →
 * Updates shows it.
 *
 * An upgrade by hand is the provisioning CLI's `upgrade` command: for Google
 * Cloud installs run on the machine that installed Caelo (or Cloud Shell),
 * for self-hosted installs on the server, in the folder that holds
 * `.caelo/` (#696 Phase 4). AWS and Azure have none yet (`lifecycle.ts`
 * refuses them), so the page says plainly what is missing there — a command
 * that would only print "not yet implemented" is worse than none.
 *
 * Pure, with the environment passed in, so it is unit-testable.
 */

/** Upgrade guide for every install the CLI upgrades (Google Cloud and self-hosted). */
const UPGRADE_DOCS_URL = "https://caelo-cms.com/docs/install/maintenance/";

/**
 * Install overview, for providers without an upgrade command: the docs have
 * no AWS or Azure page yet, and the overview says which installs exist today.
 */
const INSTALL_DOCS_URL = "https://caelo-cms.com/docs/install/";

/** Providers whose installs `cms-provision upgrade` can upgrade. */
const CLI_UPGRADE_PROVIDERS = ["gcp", "gcp-firebase", "self-hosted"] as const;
type CliUpgradeProvider = (typeof CLI_UPGRADE_PROVIDERS)[number];

export type UpgradePath =
  /**
   * Run `command` on the machine that installed Caelo (self-hosted: on the
   * server, in the folder that holds `.caelo/`).
   */
  | {
      readonly kind: "cli";
      readonly provider: CliUpgradeProvider;
      readonly command: string;
      /** The site's domain (the `--install` value on Google Cloud). */
      readonly install: string;
      readonly docsUrl: string;
    }
  /** This provider has no upgrade command yet. */
  | {
      readonly kind: "unsupported";
      readonly providerLabel: string;
      readonly docsUrl: string;
    }
  /** The admin lacks what it needs to build the command (no fallback: say what is missing). */
  | { readonly kind: "misconfigured"; readonly problem: string };

/** The environment the resolver reads. */
export interface UpgradePathEnv {
  readonly CAELO_PROVIDER?: string;
  readonly CAELO_SITE_URL?: string;
  readonly NODE_ENV?: string;
  /**
   * Test-only stand-in for CAELO_PROVIDER, honoured outside production
   * only: the Playwright suite runs the admin without a cloud provider
   * (setting CAELO_PROVIDER there would switch on real GCP calls elsewhere)
   * but must see the Google Cloud command. Same gate as
   * CAELO_FAKE_IMAGE_PROVIDER.
   */
  readonly CAELO_E2E_UPDATES_PROVIDER?: string;
  /** Test-only, same gate: `stopped` ends the fake job's latest run (server/upgrader.ts). */
  readonly CAELO_E2E_RUN_STATE?: string;
  /** `projects/<id>/locations/<region>/jobs/<job>` — names the install's project. */
  readonly CAELO_UPGRADER_JOB?: string;
}

function isCliProvider(p: string): p is CliUpgradeProvider {
  return (CLI_UPGRADE_PROVIDERS as readonly string[]).includes(p);
}

/**
 * The provider this admin was installed with; unset means self-hosted (the
 * Compose file of installs before #696 Phase 4c set none).
 */
export function updatesProvider(env: UpgradePathEnv): string {
  const e2e = env.NODE_ENV !== "production" ? env.CAELO_E2E_UPDATES_PROVIDER?.trim() : undefined;
  return e2e || env.CAELO_PROVIDER?.trim() || "self-hosted";
}

const PROVIDER_LABELS: Record<string, string> = {
  "self-hosted": "self-hosted",
  aws: "AWS",
  azure: "Azure",
};

/**
 * Resolve the upgrade path to `version` for this install.
 *
 * @param env the admin's environment (`process.env` in production).
 * @param version the release to upgrade to (the release check's newest).
 */
export function resolveUpgradePath(env: UpgradePathEnv, version: string): UpgradePath {
  const provider = updatesProvider(env);
  if (!isCliProvider(provider)) {
    return {
      kind: "unsupported",
      providerLabel: PROVIDER_LABELS[provider] ?? provider,
      docsUrl: INSTALL_DOCS_URL,
    };
  }
  const siteUrl = env.CAELO_SITE_URL?.trim();
  if (!siteUrl) {
    return {
      kind: "misconfigured",
      problem:
        "CAELO_SITE_URL is not set on the admin service, so the admin cannot tell which install it is. The provisioner sets it; run the installer once more (it keeps your release) to restore it.",
    };
  }
  const install = installHintFromSiteUrl(siteUrl);
  if (provider === "self-hosted") {
    // The CLI finds the install by its `.caelo/` folder; --install names
    // cloud installs only.
    return {
      kind: "cli",
      provider,
      install: install ?? siteUrl,
      command: provisioningCommand(version, ["upgrade", "--version", version]),
      docsUrl: UPGRADE_DOCS_URL,
    };
  }
  if (!install) {
    return {
      kind: "misconfigured",
      problem: `CAELO_SITE_URL (${JSON.stringify(siteUrl)}) is not an https://<domain> address, so the admin cannot name this install in the command.`,
    };
  }
  return {
    kind: "cli",
    provider,
    install,
    command: provisioningUpgradeCommand({ version, install }),
    docsUrl: UPGRADE_DOCS_URL,
  };
}

/**
 * The install's Google Cloud project, from the upgrader job's resource name
 * (`projects/<id>/…`); null when the admin has no upgrader job.
 */
function installProjectId(env: Pick<UpgradePathEnv, "CAELO_UPGRADER_JOB">): string | null {
  return (
    /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\//.exec(env.CAELO_UPGRADER_JOB?.trim() ?? "")?.[1] ??
    null
  );
}

/**
 * The break-glass way to install a release that changes the install's cloud
 * setup, when installing from Settings → Updates keeps failing (#696
 * maintainer decision 1, #816): in Google Cloud Shell — a terminal in the
 * browser, signed in as the Owner — because only the Owner's own identity
 * may change the project's permissions; the admin's upgrader may not.
 *
 * One button and one line. The button opens the release's UPGRADE
 * walkthrough (`cloudShellUpgradeUrl`, caelo-cms/install on the release's
 * branch), never the install wizard. The line is what that walkthrough
 * runs: `./run.sh upgrade`, which verifies its tools (Bun, cosign, the
 * provisioner's npm provenance), attaches the install from its project and
 * upgrades it. Nothing is installed unverified.
 *
 * A release whose branch has no upgrade walkthrough (a pre-release, or one
 * before `CLOUD_SHELL_UPGRADE_FIRST_VERSION`) gets no button; the line is
 * then the CLI's upgrade command, for the computer the Owner installed from.
 *
 * @returns null when the CLI path itself is unavailable (see resolveUpgradePath)
 */
export function cloudShellUpgrade(
  env: UpgradePathEnv,
  version: string,
): {
  /** The walkthrough link; null when the release's branch has none. */
  readonly consoleUrl: string | null;
  readonly projectId: string | null;
  /** The one line to run: in the walkthrough, or (no link) on the installing computer. */
  readonly command: string;
} | null {
  const path = resolveUpgradePath(env, version);
  // Self-hosted installs upgrade on their own server, never in Cloud Shell.
  if (path.kind !== "cli" || path.provider === "self-hosted") return null;
  const projectId = installProjectId(env);
  const consoleUrl = cloudShellUpgradeUrl(version, path.provider);
  return {
    consoleUrl,
    projectId,
    command: consoleUrl
      ? cloudShellUpgradeCommand({ project: projectId, install: path.install })
      : path.command,
  };
}

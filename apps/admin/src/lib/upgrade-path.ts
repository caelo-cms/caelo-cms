// SPDX-License-Identifier: MPL-2.0

import {
  cloudShellInstallUrl,
  installHintFromSiteUrl,
  provisioningCommand,
  provisioningUpgradeCommand,
} from "@caelo-cms/shared";

/**
 * How the Owner upgrades THIS install (issue #696 Phase 0), as Settings →
 * Updates shows it.
 *
 * Today an upgrade is the provisioning CLI's `upgrade` command, run by the
 * Owner on the machine that installed Caelo. That command exists for Google
 * Cloud installs only (`lifecycle.ts` refuses every other provider), so the
 * page offers it there and says plainly what is missing everywhere else —
 * a command that would only print "not yet implemented" is worse than none.
 *
 * Pure, with the environment passed in, so it is unit-testable.
 */

/** Docs page per provider; each has an upgrade section. */
const DOCS_BASE = "https://caelo-cms.com";

/** Providers whose installs `cms-provision upgrade` can upgrade. */
const CLI_UPGRADE_PROVIDERS = ["gcp", "gcp-firebase"] as const;
type CliUpgradeProvider = (typeof CLI_UPGRADE_PROVIDERS)[number];

export type UpgradePath =
  /** Run `command` on the machine that installed Caelo. */
  | {
      readonly kind: "cli";
      readonly provider: CliUpgradeProvider;
      readonly command: string;
      /** The `--install` value: the site's domain. */
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
  /** `projects/<id>/locations/<region>/jobs/<job>` — names the install's project. */
  readonly CAELO_UPGRADER_JOB?: string;
}

function isCliProvider(p: string): p is CliUpgradeProvider {
  return (CLI_UPGRADE_PROVIDERS as readonly string[]).includes(p);
}

/** The provider this admin was installed with; unset means self-hosted (compose sets none). */
function providerOf(env: UpgradePathEnv): string {
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
  const provider = providerOf(env);
  if (!isCliProvider(provider)) {
    const docsPage =
      provider === "aws" || provider === "azure" ? `install-${provider}` : "install-self-hosted";
    return {
      kind: "unsupported",
      providerLabel: PROVIDER_LABELS[provider] ?? provider,
      docsUrl: `${DOCS_BASE}/${docsPage}`,
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
    docsUrl: `${DOCS_BASE}/install-gcp`,
  };
}

/**
 * The start of a release's notes for the Updates page: whole paragraphs up
 * to `maxChars`, shown as plain text (never rendered as HTML — the notes
 * come from GitHub). The full notes are one click away on GitHub.
 *
 * @returns the excerpt and whether anything was left out.
 */
export function releaseNotesExcerpt(
  notes: string,
  maxChars = 1200,
): { text: string; truncated: boolean } {
  const trimmed = notes.replace(/\r\n/g, "\n").trim();
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  const cut = trimmed.lastIndexOf("\n\n", maxChars);
  // A first paragraph longer than the budget is cut at a word instead.
  const end = cut > 0 ? cut : trimmed.lastIndexOf(" ", maxChars);
  return { text: `${trimmed.slice(0, end > 0 ? end : maxChars).trimEnd()}\n…`, truncated: true };
}

/**
 * The install's Google Cloud project, from the upgrader job's resource name
 * (`projects/<id>/…`); null when the admin has no upgrader job.
 */
export function installProjectId(env: Pick<UpgradePathEnv, "CAELO_UPGRADER_JOB">): string | null {
  return (
    /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\//.exec(env.CAELO_UPGRADER_JOB?.trim() ?? "")?.[1] ??
    null
  );
}

/** Bun's official installer — Cloud Shell has Node but not Bun. */
const BUN_INSTALL =
  'curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"';

/**
 * How to install a release that changes the install's cloud setup (#696,
 * maintainer decision 1): in Google Cloud Shell — a terminal in the browser,
 * signed in as the Owner — because only the Owner's own identity may change
 * the project's permissions; the admin's upgrader may not.
 *
 * The "Open Cloud Shell" link is the release-pinned one every Caelo surface
 * shows (`cloudShellInstallUrl`, the caelo-cms/install walkthrough on the
 * release's branch). The pinned commands are the copyable fallback: Bun,
 * then fetch the install's records from its own project, then the same
 * upgrade the CLI runs anywhere.
 *
 * @returns null when the CLI path itself is unavailable (see resolveUpgradePath)
 */
export function cloudShellUpgrade(
  env: UpgradePathEnv,
  version: string,
): {
  /** null for a pre-release, which has no pinned Cloud Shell branch. */
  readonly consoleUrl: string | null;
  readonly projectId: string | null;
  readonly commands: readonly string[];
} | null {
  const path = resolveUpgradePath(env, version);
  if (path.kind !== "cli") return null;
  const projectId = installProjectId(env);
  const commands = [BUN_INSTALL];
  if (projectId) commands.push(provisioningCommand(version, ["attach", "--project", projectId]));
  commands.push(path.command);
  let consoleUrl: string | null = null;
  try {
    consoleUrl = cloudShellInstallUrl(version, path.provider);
  } catch {
    // Pre-releases get no release branch in caelo-cms/install: commands only.
  }
  return { consoleUrl, projectId, commands };
}

// SPDX-License-Identifier: MPL-2.0

/**
 * The "Open in Google Cloud Shell" links (epic #696, Phase 3).
 *
 * The INSTALL link names no version: it opens github.com/caelo-cms/install
 * on `main`, whose `run.sh` resolves the newest stable release itself (npm
 * `latest`) and verifies it before anything runs, so the link is right for
 * every release and never moves. The UPGRADE link names one target release:
 * it opens that release's `release-v<version>` branch (created by the
 * install repository's track-release workflow, never moved), and `run.sh`
 * there takes the version from the branch name. One builder per link for
 * every place that shows it, so they can't drift.
 */

import { isNewerVersion } from "./version.js";

/** The repository the Cloud Shell button clones. */
export const CLOUD_SHELL_INSTALL_REPO = "https://github.com/caelo-cms/install";

/** The button image Google publishes for "Open in Cloud Shell" links. */
export const CLOUD_SHELL_BUTTON_IMAGE = "https://gstatic.com/cloudssh/images/open-btn.svg";

/** Providers the Cloud Shell install covers (one tutorial each). */
export type CloudShellProvider = "gcp" | "gcp-firebase";

const STABLE = /^v?(\d+\.\d+\.\d+)$/;

/**
 * The Cloud Shell install link: always the newest stable release.
 *
 * @example cloudShellInstallUrl("gcp")
 *   // → "https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/caelo-cms/install&cloudshell_git_branch=main&cloudshell_tutorial=gcp.md"
 */
export function cloudShellInstallUrl(provider: CloudShellProvider): string {
  return [
    "https://shell.cloud.google.com/cloudshell/editor",
    `?cloudshell_git_repo=${CLOUD_SHELL_INSTALL_REPO}`,
    "&cloudshell_git_branch=main",
    `&cloudshell_tutorial=${provider}.md`,
  ].join("");
}

/**
 * The first release whose `release-v<version>` branch in the install
 * repository ships the break-glass upgrade (#816): `upgrade-gcp.md`,
 * `upgrade-gcp-firebase.md` and `./run.sh upgrade`. Release branches are
 * cut from the install repository's main when the release is tracked and
 * never move, so older branches lack the tutorial; for them the admin shows
 * the CLI command instead of a link that would open nothing.
 *
 * Set to the release that follows caelo-cms/install#3 (the upgrade
 * tutorials) merging; if that merge slips past a release, raise it.
 */
export const CLOUD_SHELL_UPGRADE_FIRST_VERSION = "0.10.60";

/**
 * The Cloud Shell link that opens the break-glass UPGRADE walkthrough of a
 * stable release (#816), never the install wizard.
 *
 * Cloud Shell links cannot carry the project or the install: Google
 * documents no parameter for either, and a tutorial cannot read the URL.
 * `./run.sh upgrade` finds the Owner's install itself (the projects whose
 * ops bucket holds `install/install.json`); the admin shows the explicit
 * `--project … --install …` line ({@link cloudShellUpgradeCommand}) next to
 * the button for an Owner with several installs.
 *
 * @returns null for a pre-release (no pinned branch) or a release before
 *   {@link CLOUD_SHELL_UPGRADE_FIRST_VERSION} (its branch has no tutorial)
 *
 * @example cloudShellUpgradeUrl("0.10.60", "gcp-firebase")
 *   // → "https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/caelo-cms/install&cloudshell_git_branch=release-v0.10.60&cloudshell_tutorial=upgrade-gcp-firebase.md"
 */
export function cloudShellUpgradeUrl(version: string, provider: CloudShellProvider): string | null {
  const m = STABLE.exec(version);
  if (!m?.[1]) return null;
  if (isNewerVersion(CLOUD_SHELL_UPGRADE_FIRST_VERSION, m[1])) return null;
  return [
    "https://shell.cloud.google.com/cloudshell/editor",
    `?cloudshell_git_repo=${CLOUD_SHELL_INSTALL_REPO}`,
    `&cloudshell_git_branch=release-v${m[1]}`,
    `&cloudshell_tutorial=upgrade-${provider}.md`,
  ].join("");
}

/**
 * The one line the break-glass walkthrough runs, from the clone of the
 * install repository: `./run.sh upgrade` with the install named when the
 * admin knows it (`--project` from its upgrader job, `--install` = domain).
 *
 * @example cloudShellUpgradeCommand({ project: "acme-site", install: "acme.com" })
 *   // → "./run.sh upgrade --project acme-site --install acme.com"
 */
export function cloudShellUpgradeCommand(target: {
  readonly project: string | null;
  readonly install: string;
}): string {
  return [
    "./run.sh upgrade",
    ...(target.project ? ["--project", target.project] : []),
    "--install",
    target.install,
  ].join(" ");
}

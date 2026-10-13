// SPDX-License-Identifier: MPL-2.0

/**
 * The "Open in Google Cloud Shell" install link (epic #696, Phase 3).
 *
 * The link opens github.com/caelo-cms/install on the `release-v<version>`
 * branch that repository's track-release workflow creates for every stable
 * release (and never moves), with the provider's walkthrough tutorial. Its
 * `run.sh` pins and verifies exactly that release of the provisioner. One
 * builder for every place that shows the link — README, docs, and the
 * admin's "run this release in Cloud Shell" hint — so they can't drift.
 */

/** The repository the Cloud Shell button clones. */
export const CLOUD_SHELL_INSTALL_REPO = "https://github.com/caelo-cms/install";

/** The button image Google publishes for "Open in Cloud Shell" links. */
export const CLOUD_SHELL_BUTTON_IMAGE = "https://gstatic.com/cloudssh/images/open-btn.svg";

/** Providers the Cloud Shell install covers (one tutorial each). */
export type CloudShellProvider = "gcp" | "gcp-firebase";

const STABLE = /^v?(\d+\.\d+\.\d+)$/;

/**
 * The Cloud Shell install link for a stable release.
 *
 * @throws for a pre-release or non-SemVer version — only stable releases
 *   get a `release-v<version>` branch in the install repository
 *
 * @example cloudShellInstallUrl("0.10.47", "gcp")
 *   // → "https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/caelo-cms/install&cloudshell_git_branch=release-v0.10.47&cloudshell_tutorial=gcp.md"
 */
export function cloudShellInstallUrl(version: string, provider: CloudShellProvider): string {
  const m = STABLE.exec(version);
  if (!m) {
    throw new Error(
      `no Cloud Shell install link for "${version}": only stable releases are pinned in ${CLOUD_SHELL_INSTALL_REPO}`,
    );
  }
  return [
    "https://shell.cloud.google.com/cloudshell/editor",
    `?cloudshell_git_repo=${CLOUD_SHELL_INSTALL_REPO}`,
    `&cloudshell_git_branch=release-v${m[1]}`,
    `&cloudshell_tutorial=${provider}.md`,
  ].join("");
}

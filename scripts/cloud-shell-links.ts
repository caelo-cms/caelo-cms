// SPDX-License-Identifier: MPL-2.0

/**
 * The "Open in Cloud Shell" install links in the README pin the release
 * they install (`cloudshell_git_branch=release-v<version>`,
 * epic #696). scripts/release.ts moves them to each new stable release in
 * the release commit; cloud-shell-links.test.ts checks they always name the
 * current version.
 *
 * The `release-v<version>` branch in github.com/caelo-cms/install is
 * created by that repository's track-release workflow shortly after the
 * GitHub Release is published (it polls every 30 minutes).
 */

/**
 * Files carrying Cloud Shell install links (repo-relative). The end-user
 * docs at caelo-cms.com/docs/ carry the same links, but they are CMS
 * pages, not repo files (CLAUDE.md §10): the release's docs-sync draft
 * moves them there (#827), and the Owner publishes it. Writing to the
 * live site from here would bypass that publish click. RELEASING.md
 * "5. End-user docs" has the procedure.
 */
export const CLOUD_SHELL_LINK_FILES: readonly string[] = ["README.md"];

/** The pinned branch inside a Cloud Shell install link. */
export const CLOUD_SHELL_BRANCH = /cloudshell_git_branch=release-v(\d+\.\d+\.\d+)/g;

/**
 * `text` with every Cloud Shell install link moved to `version`. A
 * pre-release has no pinned branch, so the links stay on the last stable one.
 *
 * @returns the new text (unchanged for a pre-release)
 */
export function pinCloudShellLinks(text: string, version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return text;
  return text.replace(CLOUD_SHELL_BRANCH, `cloudshell_git_branch=release-v${version}`);
}

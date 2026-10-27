// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #696 — the AI's read of "which Caelo version is this, and is there
 * a newer one?". Read-only by design: updates are installed by the Owner at
 * Settings → Updates, never by the AI (CLAUDE.md §2, #696 maintainer
 * decision 3: the AI informs and links, no approval card). The result says
 * so in words the AI can pass on, so it never claims it can upgrade.
 */

import { z } from "zod";
import type { PlatformUpdateStatus } from "../../ops/platform-updates.js";
import { makeReadTool } from "./_make-read-tool.js";

/** Render `platform_updates.status` for the AI. */
export function formatCaeloVersion(s: PlatformUpdateStatus): string {
  const lines = [`Installed Caelo version: ${s.installedVersion}`];
  if (s.latestVersion === null) {
    lines.push(
      s.checkedAt === null
        ? "Newest release: unknown — the hourly release check has not run yet."
        : `Newest release: unknown — the last release check (${s.checkedAt}) could not reach GitHub.`,
    );
  } else if (s.upgradeAvailable) {
    lines.push(
      `Newest release: ${s.latestVersion}${s.publishedAt ? ` (published ${s.publishedAt.slice(0, 10)})` : ""} — an update is available.`,
    );
    if (s.releaseUrl) lines.push(`Release notes: ${s.releaseUrl}`);
    if (s.infraChange === true) {
      lines.push(
        "This release also changes this install's Google Cloud setup. Where the install has Caelo's converge job, the Owner installs it from Settings → Updates like any other update (it takes a little longer); otherwise once from Google Cloud Shell, and the page walks them through it.",
      );
    }
    if (s.ownerAction !== null) {
      lines.push(`Before the Owner updates (from the release): ${s.ownerAction}`);
    }
  } else {
    lines.push(`Newest release: ${s.latestVersion} — this install is up to date.`);
  }
  lines.push(
    `Updates are installed by the Owner at ${s.updatesPath} (Settings → Updates), which shows the exact command for this install. ` +
      "You cannot install or schedule an update: tell the operator what is available and point them to that page.",
  );
  return lines.join("\n");
}

export const getCaeloVersionTool = makeReadTool<Record<string, never>>({
  name: "get_caelo_version",
  description:
    "Running Caelo version, newest release, update available (+ release-notes link). Use for version/update/release questions, or when a missing feature may need a newer Caelo. You cannot install updates — the Owner does at Settings → Updates (/settings/updates); say so and link it.",
  opName: "platform_updates.status",
  input: z.object({}).strict(),
  format: (value) => formatCaeloVersion(value as PlatformUpdateStatus),
  // The release notes are long and add nothing the formatted lines lack.
  includeValue: false,
});

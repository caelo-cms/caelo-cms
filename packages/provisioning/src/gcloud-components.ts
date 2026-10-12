// SPDX-License-Identifier: MPL-2.0

/**
 * Ensure an optional gcloud component (`beta`, `alpha`, …) is installed
 * BEFORE a command that needs it runs.
 *
 * Why this exists: invoking `gcloud beta …` without the `beta` component
 * makes gcloud ask "Do you want to continue (Y/n)?" to install it. Our
 * runner captures gcloud's output, so that prompt was invisible and the CLI
 * hung forever (`admin-domain enable`). The runner now sets
 * `CLOUDSDK_CORE_DISABLE_PROMPTS=1`, which turns the hang into a fast
 * failure; this helper turns the failure into the bootstrap step §11.C
 * promises — check, install with a visible message, carry on.
 *
 * Installs from a system package manager (apt/dnf `google-cloud-cli`, snap)
 * have the component manager disabled: `gcloud components install` refuses.
 * There we cannot fix it ourselves, so we fail with the command to run —
 * gcloud's own message already names the exact package-manager command,
 * so it is passed through verbatim next to ours.
 */

import type { GcloudResult } from "./gcloud.js";

type Run = (args: string[]) => Promise<GcloudResult>;

export type EnsureComponentResult = { ok: true; installed: boolean } | { ok: false; error: string };

/** gcloud's wording when its component manager is disabled for this installation. */
const COMPONENT_MANAGER_DISABLED =
  /component manager\s+is disabled|managed by an external package manager/i;

/**
 * Install `component` if it is not installed locally.
 *
 * @param opts.run - gcloud runner (injectable for tests).
 * @param opts.log - receives the progress line shown while installing, so the
 *   operator sees why the command pauses (the install downloads for ~1 min).
 * @returns `installed: true` when this call installed it; `ok: false` with an
 *   actionable message when it is missing and could not be installed.
 */
export async function ensureGcloudComponent(
  component: string,
  opts: { run: Run; log: (message: string) => void },
): Promise<EnsureComponentResult> {
  const listed = await opts.run([
    "components",
    "list",
    "--only-local-state",
    `--filter=id=${component}`,
    "--format=value(id)",
  ]);
  if (!listed.ok) {
    return {
      ok: false,
      error: `check whether the gcloud "${component}" component is installed: ${listed.stderr.trim()}`,
    };
  }
  const installedIds = listed.stdout.split("\n").map((s) => s.trim());
  if (installedIds.includes(component)) return { ok: true, installed: false };

  opts.log(`Installing the gcloud "${component}" component (needed once; takes about a minute)…`);
  const install = await opts.run(["components", "install", component, "--quiet"]);
  if (install.ok) return { ok: true, installed: true };

  const stderr = install.stderr.trim();
  if (COMPONENT_MANAGER_DISABLED.test(stderr)) {
    return {
      ok: false,
      error:
        `the gcloud "${component}" component is missing, and this gcloud was installed by a ` +
        "system package manager, so it cannot install components itself. Install it with " +
        "your package manager (Debian/Ubuntu: `sudo apt-get install google-cloud-cli`; " +
        "Fedora/RHEL: `sudo dnf install google-cloud-cli`), or switch to the standalone " +
        "Google Cloud CLI from https://cloud.google.com/sdk/docs/install, then re-run this " +
        `command.\ngcloud said:\n${stderr}`,
    };
  }
  return {
    ok: false,
    error:
      `install the gcloud "${component}" component: ${stderr}\n` +
      `Run \`gcloud components install ${component}\` yourself (add \`sudo\` if your ` +
      "Google Cloud CLI directory is not writable by your user), then re-run this command.",
  };
}

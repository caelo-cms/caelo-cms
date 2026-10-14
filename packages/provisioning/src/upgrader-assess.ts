// SPDX-License-Identifier: MPL-2.0

/**
 * Whether the upgrader job may install the release an update request names
 * (epic #696). Pure: the job fetches the signed manifest and reads the
 * install's own state, this decides.
 *
 * The request row comes from the admin, so it is untrusted input: it only
 * names a version and who asked. Everything that decides — the digests, the
 * minimum version to upgrade from, whether the release changes the
 * infrastructure or carries destructive migrations, whether it is a
 * security release — comes from the manifest Caelo's release workflow
 * signed, and the installed version from install.json in the install's ops
 * bucket (which the admin cannot write). So a compromised admin can at most
 * ask for "the newest signed release" again; it cannot pick an older one,
 * skip a required intermediate release or get an infrastructure change past
 * the Owner.
 *
 * Refusal matrix (table-tested in upgrader-assess.test.ts):
 *
 * | Condition                                           | Status            |
 * |-----------------------------------------------------|-------------------|
 * | registry unreachable                                | failed (retry)    |
 * | bad signature / tampered blob / replayed manifest   | refused           |
 * | manifest too new for this upgrader                  | needs_cloud_shell |
 * | installed version unknown (never upgraded via CLI)  | needs_cloud_shell |
 * | target not newer than installed (downgrade/same)    | refused           |
 * | installed below the release's minFromVersion        | refused           |
 * | release raises the infrastructure contract          | needs_cloud_shell |
 * | contract (destructive) migrations, automatic run    | refused           |
 * | contract migrations, Owner's click                  | proceed + warning |
 * | automatic run the update policy does not allow      | refused           |
 * | automatic "security" run, signed manifest disagrees | refused           |
 *
 * Self-hosted installs (the host agent, #696 Phase 4c) have no separately
 * converged infrastructure: their Compose file, roles and bootstrap script
 * are rendered by the target release's own provisioning CLI in the same run
 * that rolls the images. So for them `installed.infraContractVersion` is
 * null and the infra-contract row never applies; every "needs_cloud_shell"
 * stop names the upgrade command on the server instead of Cloud Shell.
 */

import {
  type AutoUpdateBasis,
  autoInstallRefusal,
  type PlatformUpdateTrigger,
  type StoredUpdatePolicy,
  updateKind,
} from "@caelo-cms/shared";
import {
  assessAutoInstall,
  channelForVersion,
  compareSemver,
  type ReleaseManifest,
  type ReleaseManifestResult,
} from "./release-manifest.js";
import { needsConverge } from "./upgrade/converge.js";

/** Machine-readable reason codes (`platform_update_requests.refusal_codes`). */
export type RefusalCode =
  | "registry"
  | "signature"
  | "manifest-unreadable"
  | "install-version-unknown"
  | "not-newer"
  | "min-from-version"
  | "infra-contract"
  | "contract-migrations"
  | "policy";

export type RequestDecision =
  | {
      readonly kind: "proceed";
      readonly manifest: ReleaseManifest;
      /** Notes for the timeline (e.g. destructive migrations the Owner accepted). */
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: "stop";
      readonly status: "refused" | "needs_cloud_shell" | "failed";
      readonly codes: readonly RefusalCode[];
      /** Plain words for the Owner. */
      readonly reason: string;
      /** The manifest, when it verified (for the facts the page explains). */
      readonly manifest?: ReleaseManifest;
    };

/** What the install's own state says it runs. */
export interface InstalledState {
  /** install.json `releaseVersion` (self-hosted: release.json); null when never recorded. */
  readonly version: string | null;
  /**
   * install.json `infraContractVersion` (0 when never converged); null for
   * an install without separately converged infrastructure (self-hosted).
   */
  readonly infraContractVersion: number | null;
}

/** Where the Owner runs an upgrade by hand when the automatic path cannot. */
export type ManualUpgradePath = "cloud-shell" | "server";

/** "…once with Cloud Shell" / "…once on the server": the hand-run upgrade, in words. */
function manualRun(path: ManualUpgradePath): string {
  return path === "server"
    ? "with the upgrade command on the server (Settings → Updates shows it)"
    : "with Cloud Shell";
}

const stop = (
  status: "refused" | "needs_cloud_shell" | "failed",
  code: RefusalCode,
  reason: string,
  manifest?: ReleaseManifest,
): RequestDecision => ({
  kind: "stop",
  status,
  codes: [code],
  reason,
  ...(manifest ? { manifest } : {}),
});

/** Decide what the job does with a request. See the file comment for the matrix. */
export function assessUpgradeRequest(input: {
  readonly request: {
    readonly targetVersion: string;
    readonly trigger: PlatformUpdateTrigger;
    /** Why the admin's scheduler queued an automatic request (Phase 5). */
    readonly autoBasis?: AutoUpdateBasis | null;
  };
  readonly manifest: ReleaseManifestResult;
  readonly installed: InstalledState;
  readonly policy: StoredUpdatePolicy;
  readonly now: Date;
  /** Default `cloud-shell` (the GCP upgrader job). */
  readonly manualPath?: ManualUpgradePath;
}): RequestDecision {
  const { request, installed } = input;
  const by = manualRun(input.manualPath ?? "cloud-shell");
  const target = request.targetVersion;
  if (!input.manifest.ok) {
    const e = input.manifest.error;
    switch (e.code) {
      case "registry":
        return stop(
          "failed",
          "registry",
          `Could not reach the Caelo release registry to verify v${target} (${e.message}). Nothing was changed; try again later.`,
        );
      case "schema":
        return stop(
          "needs_cloud_shell",
          "manifest-unreadable",
          `This upgrader is too old to read the release information of v${target}. Install it once ${by}; afterwards the admin can install updates again. (${e.message})`,
        );
      default:
        return stop(
          "refused",
          "signature",
          `The release information of v${target} is not signed by Caelo's release workflow, so it was not installed. Nothing was changed. (${e.message})`,
        );
    }
  }
  const manifest = input.manifest.manifest;
  if (installed.version === null) {
    return stop(
      "needs_cloud_shell",
      "install-version-unknown",
      `This install has not recorded which Caelo release it runs yet. Upgrade it once ${by}; that records it, and the admin can install updates from then on.`,
      manifest,
    );
  }
  if (compareSemver(target, installed.version) <= 0) {
    return stop(
      "refused",
      "not-newer",
      `v${target} is not newer than the installed v${installed.version}; Caelo never installs an older release over a newer one.`,
      manifest,
    );
  }
  if (compareSemver(installed.version, manifest.minFromVersion) < 0) {
    return stop(
      "refused",
      "min-from-version",
      `v${target} can only be installed over v${manifest.minFromVersion} or newer; this install runs v${installed.version}. Install v${manifest.minFromVersion} first.`,
      manifest,
    );
  }
  // Self-hosted: the target's own CLI renders the host setup in this run.
  const infraContractVersion = installed.infraContractVersion ?? manifest.infraContractVersion;
  if (
    installed.infraContractVersion !== null &&
    needsConverge({ infraContractVersion }, manifest.infraContractVersion)
  ) {
    return stop(
      "needs_cloud_shell",
      "infra-contract",
      `v${target} changes this install's cloud setup (infrastructure contract ${infraContractVersion} → ${manifest.infraContractVersion}). The admin may not change cloud permissions, so this release is installed once with your own Google account in Cloud Shell.`,
      manifest,
    );
  }
  const assessment = assessAutoInstall(manifest, {
    version: installed.version,
    infraContractVersion,
  });
  const destructive = assessment.mode === "manual";
  const warnings: string[] = [];
  if (destructive) {
    if (request.trigger === "auto") {
      return stop(
        "refused",
        "contract-migrations",
        `v${target} makes database changes the previous release cannot run on (${assessment.reasons.join("; ")}), so it never installs automatically. Install it from Settings → Updates.`,
        manifest,
      );
    }
    warnings.push(
      `This release makes database changes the previous release cannot run on (${assessment.reasons.join("; ")}). If it has to roll back, the pre-upgrade backup must be restored.`,
    );
  }
  if (request.trigger === "auto") {
    const kind = updateKind(installed.version, target);
    const refusal =
      kind === null
        ? "the release is not a newer version"
        : autoInstallRefusal(
            input.policy,
            {
              kind,
              security: assessment.kind === "security",
              contractMigrations: destructive,
              channel: channelForVersion(target) ?? "unknown",
            },
            input.now,
          );
    if (refusal) {
      return stop("refused", "policy", `Not installed automatically: ${refusal}.`, manifest);
    }
    // The scheduler read the manifest unverified; it may only have used the
    // security fix's shorter soak period if the SIGNED manifest backs it.
    if (request.autoBasis === "security" && assessment.kind !== "security") {
      return stop(
        "refused",
        "policy",
        `Not installed automatically: v${target} was queued as a security fix, but its signed release information names no published security advisory. Install it from Settings → Updates.`,
        manifest,
      );
    }
  }
  return { kind: "proceed", manifest, warnings };
}

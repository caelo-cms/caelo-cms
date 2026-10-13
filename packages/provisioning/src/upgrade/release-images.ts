// SPDX-License-Identifier: MPL-2.0

/**
 * The release images an upgrade rolls to: their digests, resolved from the
 * public registry, and their cosign signatures, verified against the Caelo
 * release workflow's keyless identity before anything changes. CLI-side
 * (`cms-provision upgrade`); the in-cloud upgrader job (epic #696) takes the
 * digests from the signed release manifest instead.
 */

import { confirm, isCancel, log, spinner } from "@clack/prompts";
import { green, red } from "kleur/colors";

/** Where Caelo's release images live (public Artifact Registry repo). */
export const RELEASE_REGISTRY = {
  region: "europe-west1",
  project: "caelo-website",
  repo: "caelo-cms-images",
} as const;

/** The digest-pinned reference of release image `slug@digest`. */
export function releaseImageRef(slug: string, digest: string): string {
  const r = RELEASE_REGISTRY;
  return `${r.region}-docker.pkg.dev/${r.project}/${r.repo}/${slug}@${digest}`;
}

/**
 * Resolve a tag (e.g. `0.2.6` or `latest`) to the underlying sha256
 * digest via the Docker Registry V2 API directly, without needing the
 * caller's gcloud session to have IAM access to the registry's
 * project. Used for the upgrade pre-flight resolve — the registry is
 * public so an anonymous HEAD on the manifest endpoint suffices.
 */
export async function resolveTagDigest(
  image: string,
  tag: string,
): Promise<{ ok: true; digest: string } | { ok: false; reason: string }> {
  const { region, project, repo } = RELEASE_REGISTRY;
  const url = `https://${region}-docker.pkg.dev/v2/${project}/${repo}/${image}/manifests/${tag}`;
  // Accept both Docker v2 + OCI manifest types so the registry returns
  // the resource we asked about (single-arch + multi-arch index both
  // surface a Docker-Content-Digest header that names the manifest
  // we'd pull on a `docker pull <image>:<tag>`).
  const accept = [
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.index.v1+json",
  ].join(",");
  try {
    const res = await fetch(url, { method: "HEAD", headers: { Accept: accept } });
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
    }
    const digest = res.headers.get("docker-content-digest");
    if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      return { ok: false, reason: `unexpected digest header: ${digest ?? "(missing)"}` };
    }
    return { ok: true, digest };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function probeBinary(argv: string[]): boolean {
  try {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Ensure cosign is on PATH. If not — and the operator is on macOS with
 * brew available — offer to `brew install cosign` interactively. Falls
 * back to printing the platform install URL + the --skip-verify
 * escape hatch when auto-install isn't possible.
 *
 * Returns true if cosign is callable after this function returns.
 */
async function ensureCosignAvailable(): Promise<boolean> {
  if (probeBinary(["cosign", "version"])) return true;

  log.error(red("cosign not found on PATH — required for image-signature verification."));

  // macOS auto-install offer. Only when `brew` is itself on PATH —
  // otherwise the operator is on a stripped-down install where
  // homebrew was never set up, and the manual instructions are more
  // useful than a failing brew shell-out.
  if (process.platform === "darwin" && probeBinary(["brew", "--version"])) {
    const proceed = await confirm({
      message: "Install cosign via brew now? (one-shot: brew install cosign)",
      initialValue: true,
    });
    if (!isCancel(proceed) && proceed === true) {
      const s = spinner();
      s.start("brew install cosign");
      const installResult = Bun.spawnSync(["brew", "install", "cosign"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (installResult.exitCode === 0 && probeBinary(["cosign", "version"])) {
        s.stop(green("cosign installed ✓"));
        return true;
      }
      const stderr = new TextDecoder().decode(installResult.stderr);
      s.stop(red("brew install cosign failed"));
      log.error(stderr.trim().slice(0, 500));
    }
  }

  log.warn(
    "Install cosign:\n" +
      "  • brew install cosign           (macOS)\n" +
      "  • https://docs.sigstore.dev/cosign/installation/  (other)\n" +
      "Or pass --skip-verify to roll without signature checks (NOT recommended for production).",
  );
  return false;
}

/**
 * P21 ship 4 — verify cosign keyless signatures on every planned
 * image digest. Sigstore Fulcio + Rekor; the certificate identity
 * must match the Caelo release-images workflow. A mismatch means
 * either a registry compromise, a typosquat, or the operator pointed
 * at a fork's image. Either way: refuse to roll.
 *
 * Returns true on success (or skips with a clear error and returns
 * false if cosign isn't installed / verification fails).
 */
export async function verifyCosignAll(
  plans: readonly { readonly slug: string; readonly digest: string }[],
): Promise<boolean> {
  // Probe cosign. Bun.spawnSync THROWS ENOENT when the binary is
  // missing (instead of returning a non-zero exit), so the probe
  // needs try/catch — relying on `exitCode !== 0` would surface a
  // confusing stack trace to the operator instead of the actionable
  // "install cosign" hint.
  if (!(await ensureCosignAvailable())) return false;

  for (const plan of plans) {
    const s = spinner();
    s.start(`Verifying cosign signature for ${plan.slug}@${plan.digest.slice(0, 19)}...`);
    const fullRef = releaseImageRef(plan.slug, plan.digest);
    const verify = Bun.spawnSync(
      [
        "cosign",
        "verify",
        fullRef,
        "--certificate-identity-regexp",
        // Both release-images.yml and release.yml dispatch images;
        // accept either workflow as the signer identity. The repo
        // path is fixed; only the workflow filename varies.
        "https://github.com/caelo-cms/caelo-cms/.github/workflows/(release-images|release).yml@.*",
        "--certificate-oidc-issuer",
        "https://token.actions.githubusercontent.com",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (verify.exitCode !== 0) {
      const stderr = new TextDecoder().decode(verify.stderr);
      s.stop(red(`cosign verify FAILED for ${plan.slug}`));
      log.error(
        red(
          `${plan.slug}@${plan.digest.slice(0, 19)} signature does NOT match the Caelo release workflow identity.\n` +
            "Either:\n" +
            "  • the registry was compromised, OR\n" +
            "  • you're targeting a fork's image (verify your install's registry path), OR\n" +
            "  • cosign / sigstore had a transient outage (retry).\n" +
            `cosign stderr: ${stderr.trim().slice(0, 500)}`,
        ),
      );
      return false;
    }
    s.stop(green(`${plan.slug} signature verified ✓`));
  }
  return true;
}

// SPDX-License-Identifier: MPL-2.0

/**
 * The signed release manifest (epic #696): one JSON document per release
 * that names the exact image digests plus the facts an upgrader needs to
 * decide whether it may install the release on its own.
 *
 * Trust model. `release.yml` generates the manifest on the release tag,
 * signs it with `cosign sign-blob` (keyless, the workflow's GitHub OIDC
 * identity) and pushes it as an OCI artifact holding two layers — the
 * manifest and its Sigstore bundle. Verification pins the signer to
 * `release.yml` running on the tag `v<version>` of caelo-cms/caelo-cms,
 * so neither a compromised admin nor a registry mirror can mint, alter or
 * replay a manifest: changing a digest, flipping `security`, or serving
 * v0.9's manifest as v0.10's all fail the signature or the version check.
 * The signature rides inside the artifact (not as an OCI referrer), so
 * any plain registry copy keeps it — the failure mode that left mirrored
 * images unsigned (see release-images.yml, "oras copy -r") cannot apply.
 *
 * Errors are values: every failure carries a code plus a message that
 * says what to check next.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  IMAGE_DIGEST,
  RELEASE_OIDC_ISSUER,
  RELEASE_WORKFLOWS_URL,
} from "./upgrade/release-images.js";

/** Release channels. Pre-release versions name theirs (`0.11.0-rc.1` → `rc`). */
export const RELEASE_CHANNELS = ["stable", "rc", "beta", "alpha"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const GHSA_ID = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

/** The services a release ships images for. */
export const RELEASE_IMAGES = ["admin", "gateway", "ops"] as const;
export type ReleaseImage = (typeof RELEASE_IMAGES)[number];

const digest = z.string().regex(IMAGE_DIGEST, "expected sha256:<64 hex>");

/** Zod schema of `release-manifest.json` (manifestVersion 1). */
export const ReleaseManifestSchema = z.object({
  manifestVersion: z.literal(1),
  version: z.string().regex(SEMVER, "expected a SemVer version without a leading v"),
  channel: z.enum(RELEASE_CHANNELS),
  digests: z.object({ admin: digest, gateway: digest, ops: digest }),
  minFromVersion: z.string().regex(SEMVER),
  infraContractVersion: z.number().int().positive(),
  migrations: z.object({
    /** True when the release carries destructive (contract) migrations. */
    contract: z.boolean(),
    /**
     * Newest release up to and including this one that carried contract
     * migrations (null: none known). An install below it that jumps
     * straight here would run those destructive steps while its old image
     * still serves — so it is manual too, even when `contract` is false.
     */
    lastContractVersion: z.string().regex(SEMVER).nullable(),
    /** Newest cms_admin migration in the release, e.g. `0262_tool_approval_branch`. */
    head: z.string().min(1),
  }),
  /** Set only via the release-cut input, backed by published GitHub Security Advisories. */
  security: z.boolean(),
  advisories: z.array(z.string().regex(GHSA_ID, "expected a GHSA id")),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

/** Registry the upgrader reads manifests from — the public AR mirror Cloud Run pulls from. */
export const RELEASE_MANIFEST_REGISTRY = "europe-west1-docker.pkg.dev";
/** Repository path of the manifest artifact inside {@link RELEASE_MANIFEST_REGISTRY}. */
export const RELEASE_MANIFEST_REPOSITORY = "caelo-website/caelo-cms-images/release-manifest";

/** OCI artifact type + layer media types of the pushed manifest. */
export const RELEASE_MANIFEST_ARTIFACT_TYPE = "application/vnd.caelo.release-manifest.v1";
export const RELEASE_MANIFEST_MEDIA_TYPE = "application/vnd.caelo.release-manifest.v1+json";
export const SIGSTORE_BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";

// The signer constants are shared with the image verification (one source).
export { RELEASE_OIDC_ISSUER };

/**
 * The only identity allowed to sign the manifest of `version`: release.yml
 * of caelo-cms/caelo-cms running on that exact tag. Exact, not a regex —
 * a manifest signed on another ref (a branch, another tag) is refused.
 */
export function releaseManifestSignerIdentity(version: string): string {
  return `${RELEASE_WORKFLOWS_URL}/release.yml@refs/tags/v${version}`;
}

/**
 * Compare two SemVer strings: negative when `a < b`, 0 when equal,
 * positive when `a > b`. A pre-release sorts below its release; two
 * pre-release tags compare by SemVer identifier rules.
 *
 * @throws Error when either argument is not SemVer.
 */
export function compareSemver(a: string, b: string): number {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) throw new Error(`not a SemVer version: ${ma ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === undefined || pb === undefined) {
    return pa === pb ? 0 : pa === undefined ? 1 : -1;
  }
  const ia = pa.split(".");
  const ib = pb.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The channel a version ships on.
 *
 * @returns null for a pre-release whose identifier names no known channel.
 */
export function channelForVersion(version: string): ReleaseChannel | null {
  const m = SEMVER.exec(version);
  if (!m) return null;
  if (m[4] === undefined) return "stable";
  const id = m[4].split(".")[0];
  return (RELEASE_CHANNELS as readonly string[]).includes(id ?? "") ? (id as ReleaseChannel) : null;
}

/** Why fetching or verifying a manifest failed. */
export type ReleaseManifestErrorCode =
  | "registry"
  | "artifact-shape"
  | "blob-digest"
  | "signature"
  | "schema"
  | "version-mismatch";

export interface ReleaseManifestError {
  readonly code: ReleaseManifestErrorCode;
  readonly message: string;
}

export type ReleaseManifestResult =
  | { readonly ok: true; readonly manifest: ReleaseManifest }
  | { readonly ok: false; readonly error: ReleaseManifestError };

/** Side effects of {@link fetchVerifiedReleaseManifest}, injectable for tests. */
export interface ReleaseManifestDeps {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Runs `cosign` with `args`; resolves with its exit code + stderr. */
  readonly cosign: (args: readonly string[]) => Promise<{ exitCode: number; stderr: string }>;
  /** Registry host + repository; defaults to the fixed public mirror. */
  readonly registry?: string;
  readonly repository?: string;
}

/** `cosign` from PATH. Missing binary → exit code 127 with a hint. */
async function runCosign(args: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
  try {
    const proc = Bun.spawn(["cosign", ...args], { stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    return { exitCode: await proc.exited, stderr };
  } catch (e) {
    return {
      exitCode: 127,
      stderr: `cosign could not be started (${e instanceof Error ? e.message : String(e)}) — install cosign (it ships in the caelo-ops image)`,
    };
  }
}

const defaultDeps: ReleaseManifestDeps = {
  fetch: (url, init) => fetch(url, init),
  cosign: runCosign,
};

interface OciDescriptor {
  readonly mediaType: string;
  readonly digest: string;
}

const OciManifestSchema = z.object({
  artifactType: z.string().optional(),
  layers: z.array(z.object({ mediaType: z.string(), digest: z.string().regex(IMAGE_DIGEST) })),
});

function fail(code: ReleaseManifestErrorCode, message: string): ReleaseManifestResult {
  return { ok: false, error: { code, message } };
}

async function fetchBlob(
  deps: ReleaseManifestDeps,
  base: string,
  layer: OciDescriptor,
): Promise<Uint8Array | ReleaseManifestError> {
  const res = await deps.fetch(`${base}/blobs/${layer.digest}`);
  if (!res.ok) {
    return { code: "registry", message: `blob ${layer.digest}: HTTP ${res.status}` };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== layer.digest) {
    return {
      code: "blob-digest",
      message: `blob content does not match its digest (${layer.digest} expected, ${actual} served) — the registry or a proxy altered it`,
    };
  }
  return bytes;
}

/**
 * Fetch the manifest of `version` from the fixed registry, verify its
 * Sigstore bundle against the release workflow identity for that exact
 * tag, schema-validate it, and check it describes `version`.
 *
 * @param version - SemVer without a leading `v`.
 * @param deps - injected fetch + cosign runner (tests); defaults to the real ones.
 */
export async function fetchVerifiedReleaseManifest(
  version: string,
  deps: ReleaseManifestDeps = defaultDeps,
): Promise<ReleaseManifestResult> {
  if (!SEMVER.test(version)) return fail("schema", `"${version}" is not a SemVer version`);
  const base = `https://${deps.registry ?? RELEASE_MANIFEST_REGISTRY}/v2/${deps.repository ?? RELEASE_MANIFEST_REPOSITORY}`;

  let artifact: z.infer<typeof OciManifestSchema>;
  try {
    const res = await deps.fetch(`${base}/manifests/${version}`, {
      headers: { Accept: "application/vnd.oci.image.manifest.v1+json" },
    });
    if (!res.ok) {
      return fail(
        "registry",
        `no release manifest for v${version} at ${base} (HTTP ${res.status}). Releases before the signed manifest (epic #696) have none; otherwise check the version exists.`,
      );
    }
    const parsed = OciManifestSchema.safeParse(await res.json());
    if (!parsed.success)
      return fail("artifact-shape", `not an OCI manifest: ${parsed.error.message}`);
    artifact = parsed.data;
  } catch (e) {
    return fail("registry", `registry unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (artifact.artifactType !== RELEASE_MANIFEST_ARTIFACT_TYPE) {
    return fail(
      "artifact-shape",
      `artifactType is ${artifact.artifactType ?? "(none)"}, expected ${RELEASE_MANIFEST_ARTIFACT_TYPE}`,
    );
  }
  const manifestLayers = artifact.layers.filter((l) => l.mediaType === RELEASE_MANIFEST_MEDIA_TYPE);
  const bundleLayers = artifact.layers.filter((l) => l.mediaType === SIGSTORE_BUNDLE_MEDIA_TYPE);
  const [manifestLayer] = manifestLayers;
  const [bundleLayer] = bundleLayers;
  if (manifestLayers.length !== 1 || bundleLayers.length !== 1 || !manifestLayer || !bundleLayer) {
    return fail(
      "artifact-shape",
      "the artifact must hold exactly one release-manifest layer and one Sigstore bundle layer",
    );
  }

  let manifestBytes: Uint8Array;
  let bundleBytes: Uint8Array;
  try {
    const m = await fetchBlob(deps, base, manifestLayer);
    if (!(m instanceof Uint8Array)) return { ok: false, error: m };
    const b = await fetchBlob(deps, base, bundleLayer);
    if (!(b instanceof Uint8Array)) return { ok: false, error: b };
    manifestBytes = m;
    bundleBytes = b;
  } catch (e) {
    return fail("registry", `registry unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  // cosign verifies files, so the exact bytes go to a private temp dir.
  const dir = await mkdtemp(join(tmpdir(), "caelo-release-manifest-"));
  try {
    const manifestPath = join(dir, "release-manifest.json");
    const bundlePath = join(dir, "release-manifest.json.sigstore.json");
    await writeFile(manifestPath, manifestBytes, { mode: 0o600 });
    await writeFile(bundlePath, bundleBytes, { mode: 0o600 });
    const verify = await deps.cosign([
      "verify-blob",
      "--bundle",
      bundlePath,
      "--certificate-identity",
      releaseManifestSignerIdentity(version),
      "--certificate-oidc-issuer",
      RELEASE_OIDC_ISSUER,
      manifestPath,
    ]);
    if (verify.exitCode !== 0) {
      return fail(
        "signature",
        `the manifest of v${version} is not signed by ${releaseManifestSignerIdentity(version)} — refuse to install. cosign: ${verify.stderr.trim().slice(0, 500)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    return fail("schema", "the signed manifest is not valid JSON");
  }
  const parsed = ReleaseManifestSchema.safeParse(json);
  if (!parsed.success) {
    return fail(
      "schema",
      `the signed manifest does not match manifestVersion 1 — this CLI may be too old to read it: ${parsed.error.message}`,
    );
  }
  if (parsed.data.version !== version) {
    return fail(
      "version-mismatch",
      `asked for v${version} but the signed manifest describes v${parsed.data.version}`,
    );
  }
  return { ok: true, manifest: parsed.data };
}

/** One image whose resolved digest differs from the manifest's. */
export interface DigestMismatch {
  readonly image: ReleaseImage;
  readonly expected: string;
  readonly actual: string | null;
}

/**
 * Compare the digests a registry resolved for the release's tags with the
 * signed manifest. Only images present in `resolved` are compared, except
 * that an explicitly `null` entry (tag did not resolve) is a mismatch.
 *
 * @returns every mismatch; empty means the registry serves the signed images.
 */
export function compareImageDigests(
  manifest: ReleaseManifest,
  resolved: Partial<Record<ReleaseImage, string | null>>,
): DigestMismatch[] {
  const out: DigestMismatch[] = [];
  for (const image of RELEASE_IMAGES) {
    if (!(image in resolved)) continue;
    const actual = resolved[image] ?? null;
    if (actual !== manifest.digests[image]) {
      out.push({ image, expected: manifest.digests[image], actual });
    }
  }
  return out;
}

/** What the installed system looks like, for {@link assessAutoInstall}. */
export interface InstalledRelease {
  readonly version: string;
  readonly infraContractVersion: number;
}

/**
 * How an upgrader may treat a release:
 *  - `auto`    — may install unattended (if the Owner's policy allows the kind).
 *  - `manual`  — installable only with the operator's own identity
 *                ("Run in Cloud Shell"); never unattended.
 *  - `refused` — not installable onto this install at all.
 */
export type InstallMode = "auto" | "manual" | "refused";

export interface InstallAssessment {
  readonly mode: InstallMode;
  /** `security` only when the manifest says so AND the release is otherwise auto-installable. */
  readonly kind: "security" | "normal";
  readonly reasons: readonly string[];
}

/**
 * Decide whether `manifest` can be installed on `installed`, and how.
 *
 * A security release is NOT exempt: if it carries contract migrations
 * (or skips a release that did) or raises the infra contract, it is `manual` like any other release — the
 * manifest still says `security`, but `kind` drops to `normal` so an
 * "auto-install security fixes" policy never applies it unattended.
 */
export function assessAutoInstall(
  manifest: ReleaseManifest,
  installed: InstalledRelease,
): InstallAssessment {
  const refused: string[] = [];
  if (compareSemver(manifest.version, installed.version) <= 0) {
    refused.push(`v${manifest.version} is not newer than the installed v${installed.version}`);
  }
  if (compareSemver(installed.version, manifest.minFromVersion) < 0) {
    refused.push(
      `v${manifest.version} needs at least v${manifest.minFromVersion} installed first (installed: v${installed.version})`,
    );
  }
  if (refused.length > 0) return { mode: "refused", kind: "normal", reasons: refused };

  const manual: string[] = [];
  if (manifest.infraContractVersion > installed.infraContractVersion) {
    manual.push(
      `the release changes the infrastructure contract (${installed.infraContractVersion} → ${manifest.infraContractVersion}); it must run with the operator's own identity`,
    );
  }
  const lastContract = manifest.migrations.lastContractVersion;
  if (manifest.migrations.contract) {
    manual.push("the release carries contract (destructive) migrations");
  } else if (lastContract !== null && compareSemver(installed.version, lastContract) < 0) {
    manual.push(
      `the upgrade skips v${lastContract}, whose contract (destructive) migrations would run while v${installed.version}'s image still serves`,
    );
  }
  if (manual.length > 0) return { mode: "manual", kind: "normal", reasons: manual };
  return { mode: "auto", kind: manifest.security ? "security" : "normal", reasons: [] };
}

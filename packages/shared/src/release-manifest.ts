// SPDX-License-Identifier: MPL-2.0

/**
 * The release manifest's shape and where it lives (epic #696) — shared by
 * the provisioning CLI / upgrader job, which verify its Sigstore signature
 * with cosign before trusting it (provisioning release-manifest.ts), and
 * the admin's auto-update scheduler, which only *reads* it to decide when
 * to queue an install (the admin image ships no cosign; the job verifies).
 *
 * The artifact is one OCI manifest with two layers — the JSON manifest and
 * its Sigstore bundle — pushed by `release.yml` on the release tag.
 * {@link fetchReleaseArtifact} fetches both blobs and checks each against
 * its content digest; it does NOT check the signature.
 */

import { z } from "zod";

/** Release channels. Pre-release versions name theirs (`0.11.0-rc.1` → `rc`). */
export const RELEASE_CHANNELS = ["stable", "rc", "beta", "alpha"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** The services a release ships images for. */
export const RELEASE_IMAGES = ["admin", "gateway", "ops"] as const;
export type ReleaseImage = (typeof RELEASE_IMAGES)[number];

/** A `sha256:<64 hex>` image / blob digest. */
export const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const GHSA_ID = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

const digest = z.string().regex(IMAGE_DIGEST, "expected sha256:<64 hex>");

/** The longest `ownerAction` a release may declare: one sentence. */
export const OWNER_ACTION_MAX_CHARS = 300;

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
  /**
   * #868 — what the Owner has to do for this release's breaking change, in
   * one sentence (Settings → Updates shows it under "Before you update").
   * Set from the release-cut input; the release checks refuse a release
   * with a breaking commit without it. Absent on releases from before the
   * field and on releases without a breaking change: optional, so
   * manifestVersion stays 1 and older readers ignore it.
   */
  ownerAction: z.string().min(1).max(OWNER_ACTION_MAX_CHARS).optional(),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

/** Registry the manifests are read from — the public AR mirror Cloud Run pulls from. */
export const RELEASE_MANIFEST_REGISTRY = "europe-west1-docker.pkg.dev";
/** Repository path of the manifest artifact inside {@link RELEASE_MANIFEST_REGISTRY}. */
export const RELEASE_MANIFEST_REPOSITORY = "caelo-website/caelo-cms-images/release-manifest";

/** OCI artifact type + layer media types of the pushed manifest. */
export const RELEASE_MANIFEST_ARTIFACT_TYPE = "application/vnd.caelo.release-manifest.v1";
export const RELEASE_MANIFEST_MEDIA_TYPE = "application/vnd.caelo.release-manifest.v1+json";
export const SIGSTORE_BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";

/** Why fetching the artifact failed. */
export type ReleaseArtifactErrorCode = "registry" | "artifact-shape" | "blob-digest";

/** Why {@link fetchReleaseArtifact} failed. */
export interface ReleaseArtifactError {
  readonly code: ReleaseArtifactErrorCode;
  readonly message: string;
  /**
   * Set on `registry` errors a retry may cure: the registry could not be
   * reached, timed out, rate-limited (429) or failed (5xx). Absent when the
   * registry answered that the manifest, tag or blob does not exist (404 and
   * other 4xx) — retrying that changes nothing, so callers that would
   * otherwise "try again later" must treat it as a verdict.
   */
  readonly transient?: true;
}

export type ReleaseArtifactResult =
  | { readonly ok: true; readonly manifestBytes: Uint8Array; readonly bundleBytes: Uint8Array }
  | { readonly ok: false; readonly error: ReleaseArtifactError };

/** Where and how {@link fetchReleaseArtifact} reaches the registry. */
export interface ReleaseArtifactDeps {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Registry host + repository; default to the fixed public mirror. */
  readonly registry?: string;
  readonly repository?: string;
}

const OciManifestSchema = z.object({
  artifactType: z.string().optional(),
  layers: z.array(z.object({ mediaType: z.string(), digest: z.string().regex(IMAGE_DIGEST) })),
});

async function sha256Digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...hash].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const fail = (code: ReleaseArtifactErrorCode, message: string): ReleaseArtifactResult => ({
  ok: false,
  error: { code, message },
});

/** A `registry` failure a retry may cure (see {@link ReleaseArtifactError.transient}). */
const failTransient = (message: string): ReleaseArtifactResult => ({
  ok: false,
  error: { code: "registry", message, transient: true },
});

/** Whether an HTTP status says "try again" rather than "it does not exist". */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/** A non-OK registry response as a failure, transient or not by its status. */
function failStatus(status: number, message: string): ReleaseArtifactResult {
  return isTransientStatus(status) ? failTransient(message) : fail("registry", message);
}

/**
 * Fetch the release manifest artifact of `version` and both its layers,
 * each checked against its content digest. Verifies NO signature: callers
 * that act on the manifest verify the bundle (provisioning
 * fetchVerifiedReleaseManifest); the admin's scheduler only plans with it.
 *
 * @param version - SemVer without a leading `v` (the caller validates it).
 */
export async function fetchReleaseArtifact(
  version: string,
  deps: ReleaseArtifactDeps,
): Promise<ReleaseArtifactResult> {
  const base = `https://${deps.registry ?? RELEASE_MANIFEST_REGISTRY}/v2/${deps.repository ?? RELEASE_MANIFEST_REPOSITORY}`;
  let artifact: z.infer<typeof OciManifestSchema>;
  try {
    const res = await deps.fetch(`${base}/manifests/${version}`, {
      headers: { Accept: "application/vnd.oci.image.manifest.v1+json" },
    });
    if (!res.ok) {
      if (isTransientStatus(res.status)) {
        return failTransient(
          `the registry at ${base} could not serve the release manifest of v${version} (HTTP ${res.status}); try again later.`,
        );
      }
      return fail(
        "registry",
        `no release manifest for v${version} at ${base} (HTTP ${res.status}). Releases before the signed manifest (epic #696) have none; otherwise check the version exists.`,
      );
    }
    const parsed = OciManifestSchema.safeParse(await res.json());
    if (!parsed.success) {
      return fail("artifact-shape", `not an OCI manifest: ${parsed.error.message}`);
    }
    artifact = parsed.data;
  } catch (e) {
    return failTransient(`registry unreachable: ${e instanceof Error ? e.message : String(e)}`);
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

  const blob = async (layerDigest: string): Promise<Uint8Array | ReleaseArtifactResult> => {
    const res = await deps.fetch(`${base}/blobs/${layerDigest}`);
    if (!res.ok) return failStatus(res.status, `blob ${layerDigest}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const actual = await sha256Digest(bytes);
    if (actual !== layerDigest) {
      return fail(
        "blob-digest",
        `blob content does not match its digest (${layerDigest} expected, ${actual} served) — the registry or a proxy altered it`,
      );
    }
    return bytes;
  };
  try {
    const manifestBytes = await blob(manifestLayer.digest);
    if (!(manifestBytes instanceof Uint8Array)) return manifestBytes;
    const bundleBytes = await blob(bundleLayer.digest);
    if (!(bundleBytes instanceof Uint8Array)) return bundleBytes;
    return { ok: true, manifestBytes, bundleBytes };
  } catch (e) {
    return failTransient(`registry unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Parse manifest bytes against {@link ReleaseManifestSchema} and check they
 * describe `version`.
 *
 * @returns the manifest, or a plain-words problem
 */
export function parseReleaseManifest(
  bytes: Uint8Array,
  version: string,
):
  | { readonly ok: true; readonly manifest: ReleaseManifest }
  | { readonly ok: false; readonly code: "schema" | "version-mismatch"; readonly message: string } {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, code: "schema", message: "the manifest is not valid JSON" };
  }
  const parsed = ReleaseManifestSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      code: "schema",
      message: `the manifest does not match manifestVersion 1 — this Caelo may be too old to read it: ${parsed.error.message}`,
    };
  }
  if (parsed.data.version !== version) {
    return {
      ok: false,
      code: "version-mismatch",
      message: `asked for v${version} but the manifest describes v${parsed.data.version}`,
    };
  }
  return { ok: true, manifest: parsed.data };
}

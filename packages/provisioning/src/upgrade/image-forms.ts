// SPDX-License-Identifier: MPL-2.0

/**
 * Every digest a release image is known by (#1025).
 *
 * Caelo's release images are OCI image *indexes*: buildx adds a
 * provenance/SBOM attestation manifest even to a single-platform build. The
 * signed release manifest, install.json and every deploy pin the index
 * digest, but Cloud Run resolves the index to its linux/amd64 *platform
 * manifest* and records that digest — in the revision's `status.imageDigest`
 * AND in its `spec.containers[0].image` (verified on live installs,
 * 2026-10-23: a revision deployed as `admin@sha256:bcda…` (the v0.10.64
 * index) reads back as `admin@sha256:2e75…`, its linux/amd64 manifest). So
 * "does release X serve?" must compare the serving digest with every form of
 * X's images, not just the index.
 *
 * Where the forms come from, in order of trust:
 *   1. the release manifest's signed `platformDigests` (releases cut after
 *      #1025) — no registry round trip;
 *   2. otherwise the index itself, fetched BY DIGEST from the fixed public
 *      mirror and checked against that digest before it is read. Content
 *      addressing makes it as unforgeable as the signature that named the
 *      index: a registry or proxy that altered it fails the check.
 *
 * Only platform manifests count, never the attestation manifests listed next
 * to them (Cloud Run cannot run those). Lookups are cached per instance, so
 * one upgrader run fetches each index at most once.
 */

import { z } from "zod";
import type { ImageDigests } from "../install-state.js";
import type { ReleaseManifest } from "../release-manifest.js";
import type { RollSlug } from "./app-roll.js";
import { fetchRegistryManifest, IMAGE_DIGEST, RELEASE_REGISTRY } from "./release-images.js";

/** The digests one release image is known by. */
export type ImageFormsResult =
  | {
      readonly ok: true;
      /** The index digest first, then each platform manifest it lists. */
      readonly digests: readonly string[];
      /**
       * The linux/amd64 form Cloud Run runs: the signed platform digest, the
       * index's linux/amd64 entry, or the digest itself when it names a plain
       * image manifest. Null when the index lists no linux/amd64 manifest.
       */
      readonly amd64: string | null;
    }
  | {
      readonly ok: false;
      /** A retry may cure it (registry unreachable, 5xx, 429). */
      readonly transient: boolean;
      readonly message: string;
    };

/** Finds every form of a release image; see the file comment. */
export interface ReleaseImageForms {
  /** The forms of release `m`'s image `slug` (signed platform digests win). */
  of(
    m: Pick<ReleaseManifest, "version" | "digests" | "platformDigests">,
    slug: RollSlug,
  ): Promise<ImageFormsResult>;
  /** The forms of the index `indexDigest` of image `slug`, read from the mirror. */
  ofIndex(slug: RollSlug, indexDigest: string): Promise<ImageFormsResult>;
}

const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

const digest = z.string().regex(IMAGE_DIGEST);

/** The fields of an image index (or plain image manifest) the lookup reads. */
const ManifestJsonSchema = z.object({
  mediaType: z.string().optional(),
  manifests: z
    .array(
      z.object({
        digest,
        platform: z.object({ os: z.string(), architecture: z.string() }).optional(),
        annotations: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
});

async function sha256Digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...hash].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Read the forms out of index bytes already checked against `indexDigest`.
 * Exported for tests; production code goes through {@link createReleaseImageForms}.
 */
export function formsFromIndexJson(indexDigest: string, json: unknown): ImageFormsResult {
  const parsed = ManifestJsonSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      transient: false,
      message: `${indexDigest} is not an image index or manifest: ${parsed.error.message}`,
    };
  }
  const { mediaType, manifests } = parsed.data;
  const isIndex = mediaType ? INDEX_MEDIA_TYPES.has(mediaType) : manifests !== undefined;
  // A plain image manifest is its own platform form.
  if (!isIndex) return { ok: true, digests: [indexDigest], amd64: indexDigest };
  const platforms = (manifests ?? []).filter(
    (m) =>
      m.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest" &&
      m.platform !== undefined &&
      m.platform.os !== "unknown",
  );
  const amd64 = platforms.filter(
    (m) => m.platform?.os === "linux" && m.platform.architecture === "amd64",
  );
  return {
    ok: true,
    digests: [indexDigest, ...platforms.map((m) => m.digest).filter((d) => d !== indexDigest)],
    amd64: amd64.length === 1 ? (amd64[0]?.digest ?? null) : null,
  };
}

/**
 * The lookup against the fixed public mirror ({@link RELEASE_REGISTRY}),
 * anonymous, cached per instance.
 *
 * @param fetchImpl - injectable for tests; the real one by default
 */
export function createReleaseImageForms(fetchImpl: typeof fetch = fetch): ReleaseImageForms {
  const cache = new Map<string, Promise<ImageFormsResult>>();
  const { region, project, repo } = RELEASE_REGISTRY;

  async function lookup(slug: RollSlug, indexDigest: string): Promise<ImageFormsResult> {
    const where = `the ${slug} image index ${indexDigest} in the release mirror`;
    const fetched = await fetchRegistryManifest(
      `${region}-docker.pkg.dev`,
      `${project}/${repo}/${slug}`,
      indexDigest,
      fetchImpl,
    );
    if (!fetched.ok) {
      return {
        ok: false,
        transient: fetched.transient,
        message: `${where} could not be read (${fetched.reason})`,
      };
    }
    const actual = await sha256Digest(fetched.bytes);
    if (actual !== indexDigest) {
      return {
        ok: false,
        transient: false,
        message: `${where} does not match its digest (${actual} served): the registry or a proxy altered it`,
      };
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(fetched.bytes));
    } catch {
      return { ok: false, transient: false, message: `${where} is not JSON` };
    }
    return formsFromIndexJson(indexDigest, json);
  }

  const ofIndex = (slug: RollSlug, indexDigest: string): Promise<ImageFormsResult> => {
    const key = `${slug}@${indexDigest}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = lookup(slug, indexDigest);
      cache.set(key, pending);
    }
    return pending;
  };

  return {
    ofIndex,
    of: async (m, slug) => {
      const signed = m.platformDigests?.[slug];
      if (signed) {
        const index = m.digests[slug];
        return { ok: true, digests: [index, ...(signed === index ? [] : [signed])], amd64: signed };
      }
      return ofIndex(slug, m.digests[slug]);
    },
  };
}

/**
 * The linux/amd64 form of each image in `digests`, to record next to them
 * in install.json (#1025). Taken from `manifest`'s signed platform digests
 * when it signs these very indexes, else from the content-checked index.
 *
 * @returns the forms, or why they are not known (the caller records the
 *   index digests without them; the upgrader then reads the index itself)
 */
export async function platformDigestsOf(
  digests: ImageDigests,
  forms: ReleaseImageForms,
  manifest?: Pick<ReleaseManifest, "version" | "digests" | "platformDigests"> | null,
): Promise<
  | { readonly ok: true; readonly platformDigests: ImageDigests }
  | { readonly ok: false; readonly message: string }
> {
  const out: Partial<Record<RollSlug, string>> = {};
  for (const slug of ["admin", "gateway"] as const) {
    const found =
      manifest && manifest.digests[slug] === digests[slug]
        ? await forms.of(manifest, slug)
        : await forms.ofIndex(slug, digests[slug]);
    if (!found.ok) return { ok: false, message: found.message };
    if (!found.amd64) {
      return {
        ok: false,
        message: `the ${slug} image index ${digests[slug]} lists no single linux/amd64 manifest`,
      };
    }
    out[slug] = found.amd64;
  }
  const { admin, gateway } = out;
  return admin && gateway
    ? { ok: true, platformDigests: { admin, gateway } }
    : { ok: false, message: "the platform digests could not be read" };
}

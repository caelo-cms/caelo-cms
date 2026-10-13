// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo release images — where they live, how a tag becomes a digest, and
 * which signer identity cosign must see. Shared by every install path that
 * runs the prebuilt images (CLAUDE.md §11.C "pre-built container images on
 * a public registry"): the GCP `upgrade` (Artifact Registry mirror) and the
 * self-hosted Compose install + upgrade (GHCR, the canonical registry).
 *
 * Both registries carry the SAME digests: release-images.yml pushes to GHCR,
 * signs, then `oras copy -r`s image + signature to the Artifact Registry
 * mirror. So one resolver and one cosign identity serve both.
 */

/** The two Caelo services shipped as release images. */
export type ReleaseService = "admin" | "gateway";

/** The services every install runs, in roll order (admin first, then gateway). */
export const RELEASE_SERVICES: readonly ReleaseService[] = ["admin", "gateway"];

/** GHCR — the canonical registry (release-images.yml), used by self-hosted Compose. */
export const GHCR_REGISTRY = "ghcr.io";
export const GHCR_NAMESPACE = "caelo-cms";

/** `ghcr.io/caelo-cms/<service>` — the repository of a service's release image. */
export function ghcrRepository(service: ReleaseService): string {
  return `${GHCR_REGISTRY}/${GHCR_NAMESPACE}/${service}`;
}

/**
 * The keyless signer cosign must see on every release image: one of the two
 * release workflows of the caelo-cms repo, via GitHub's OIDC issuer. A
 * different identity means a registry compromise, a typosquat, or a fork's
 * image — every caller refuses to run it.
 */
export const RELEASE_SIGNER_IDENTITY_REGEXP =
  "https://github.com/caelo-cms/caelo-cms/.github/workflows/(release-images|release).yml@.*";
export const RELEASE_SIGNER_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/**
 * The `cosign verify` argv for one image reference pinned by digest.
 *
 * @example cosignVerifyArgv("ghcr.io/caelo-cms/admin@sha256:…")
 */
export function cosignVerifyArgv(imageRef: string): string[] {
  return [
    "cosign",
    "verify",
    imageRef,
    "--certificate-identity-regexp",
    RELEASE_SIGNER_IDENTITY_REGEXP,
    "--certificate-oidc-issuer",
    RELEASE_SIGNER_OIDC_ISSUER,
  ];
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Whether `s` is a well-formed `sha256:<64 hex>` digest. */
export function isImageDigest(s: string): boolean {
  return DIGEST.test(s);
}

const HEX_DIGITS = "0123456789abcdef";

/**
 * `s` rebuilt character by character from a constant alphabet when it is a
 * well-formed digest, else null. The digest comes from a registry's HTTP
 * header and ends up in files (release.json, the Compose file); rebuilding
 * it — rather than passing the checked string on — guarantees that nothing
 * but `sha256:` and 64 hex digits from our own constants is ever written.
 */
export function canonicalDigest(s: string): string | null {
  if (!isImageDigest(s)) return null;
  const hex = [...s.slice("sha256:".length)].map((c) => HEX_DIGITS[HEX_DIGITS.indexOf(c)]);
  return `sha256:${hex.join("")}`;
}

const TAG_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-v";
const RELEASE_TAG = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * A semver release tag (`v0.10.43`, `0.11.0-rc.1`) rebuilt from a constant
 * alphabet, else null. The tag comes from the GitHub API and is recorded in
 * release.json, so — like {@link canonicalDigest} — only our own characters
 * reach the file.
 */
export function canonicalReleaseTag(s: string): string | null {
  if (s.length > 64 || !RELEASE_TAG.test(s)) return null;
  return [...s].map((c) => TAG_CHARS[TAG_CHARS.indexOf(c)]).join("");
}

/**
 * The registry tag for an upgrade request: an explicit version (a leading
 * `v` dropped, as release tags are `vX.Y.Z` but image tags `X.Y.Z`), else
 * the channel's moving tag, else `latest`.
 */
export function releaseTag(opts: {
  readonly version?: string;
  readonly channel?: "stable" | "rc" | "beta";
}): string {
  if (opts.version) return opts.version.startsWith("v") ? opts.version.slice(1) : opts.version;
  if (opts.channel === "rc") return "rc";
  if (opts.channel === "beta") return "beta";
  return "latest";
}

export type DigestResult = { ok: true; digest: string } | { ok: false; reason: string };

/** Manifest media types: single-arch manifests and multi-arch indexes, Docker + OCI. */
const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
].join(",");

/**
 * Resolve `<registryHost>/<repository>:<tag>` to the digest a `docker pull`
 * of that tag would fetch, through the Docker Registry V2 API anonymously.
 *
 * The images are public, but registries differ in how they say so: Artifact
 * Registry answers the manifest HEAD directly, GHCR answers 401 with a
 * `WWW-Authenticate: Bearer realm=…,service=…,scope=…` challenge whose realm
 * hands out an anonymous pull token. Both paths are handled here, so callers
 * never need registry credentials (end users have none for Caelo's).
 *
 * @param repository - path below the host, e.g. `caelo-cms/admin`.
 */
export async function resolveRegistryDigest(
  registryHost: string,
  repository: string,
  tag: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DigestResult> {
  const url = `https://${registryHost}/v2/${repository}/manifests/${tag}`;
  try {
    let res = await fetchImpl(url, { method: "HEAD", headers: { Accept: MANIFEST_ACCEPT } });
    if (res.status === 401) {
      const token = await anonymousPullToken(res.headers.get("www-authenticate"), fetchImpl);
      if (!token.ok) return token;
      res = await fetchImpl(url, {
        method: "HEAD",
        headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token.token}` },
      });
    }
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
    const header = res.headers.get("docker-content-digest");
    const digest = header ? canonicalDigest(header) : null;
    if (!digest) {
      return { ok: false, reason: `unexpected digest header: ${header ?? "(missing)"}` };
    }
    return { ok: true, digest };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Follow a registry's Bearer challenge to an anonymous pull token. */
async function anonymousPullToken(
  challenge: string | null,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const params = parseBearerChallenge(challenge);
  if (!params?.realm) {
    return {
      ok: false,
      reason: `registry demanded auth without a Bearer challenge (${challenge})`,
    };
  }
  const tokenUrl = new URL(params.realm);
  if (params.service) tokenUrl.searchParams.set("service", params.service);
  if (params.scope) tokenUrl.searchParams.set("scope", params.scope);
  const res = await fetchImpl(tokenUrl.toString());
  if (!res.ok) return { ok: false, reason: `token endpoint HTTP ${res.status} ${res.statusText}` };
  const body = (await res.json()) as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  return token ? { ok: true, token } : { ok: false, reason: "token endpoint returned no token" };
}

/**
 * The key/value pairs of a `Bearer k="v",k2="v2"` challenge, or null when
 * it is not a Bearer challenge.
 *
 * @example parseBearerChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io"')
 * // → { realm: "https://ghcr.io/token", service: "ghcr.io" }
 */
export function parseBearerChallenge(header: string | null): Record<string, string> | null {
  if (!header || !/^Bearer\s/i.test(header)) return null;
  const out: Record<string, string> = {};
  for (const m of header.slice(header.indexOf(" ") + 1).matchAll(/(\w+)="([^"]*)"/g)) {
    const [, key, value] = m;
    if (key && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The tag of the newest stable Caelo release on GitHub (e.g. `v0.10.43`),
 * or an error reason. Used to turn "upgrade to latest" into an exact
 * version before anything is resolved, so the version an install records is
 * a real release, never the moving `latest` tag.
 */
export async function fetchLatestReleaseTag(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; tag: string } | { ok: false; reason: string }> {
  try {
    const res = await fetchImpl(
      "https://api.github.com/repos/caelo-cms/caelo-cms/releases/latest",
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return { ok: false, reason: `GitHub API HTTP ${res.status} ${res.statusText}` };
    const json = (await res.json()) as { tag_name?: string };
    const tag = json.tag_name ? canonicalReleaseTag(json.tag_name) : null;
    return tag
      ? { ok: true, tag }
      : { ok: false, reason: `GitHub returned no usable release tag (${json.tag_name})` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

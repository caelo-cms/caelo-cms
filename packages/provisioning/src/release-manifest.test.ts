// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { INFRA_CONTRACT_VERSION } from "./infra-contract.js";
import { isInfraContractPath } from "./release-contract.js";
import {
  assessAutoInstall,
  channelForVersion,
  compareImageDigests,
  compareSemver,
  fetchVerifiedReleaseManifest,
  RELEASE_MANIFEST_ARTIFACT_TYPE,
  RELEASE_MANIFEST_MEDIA_TYPE,
  RELEASE_OIDC_ISSUER,
  type ReleaseManifest,
  type ReleaseManifestDeps,
  ReleaseManifestSchema,
  releaseManifestSignerIdentity,
  SIGSTORE_BUNDLE_MEDIA_TYPE,
} from "./release-manifest.js";

const d = (c: string) => `sha256:${c.repeat(64)}`;

const MANIFEST: ReleaseManifest = {
  manifestVersion: 1,
  version: "0.11.0",
  channel: "stable",
  digests: { admin: d("a"), gateway: d("b"), ops: d("c") },
  minFromVersion: "0.10.0",
  infraContractVersion: 1,
  migrations: {
    contract: false,
    head: "0262_tool_approval_branch",
    lastContractVersion: "0.10.42",
  },
  security: false,
  advisories: [],
};

const sha = (b: Uint8Array) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const enc = (s: string) => new TextEncoder().encode(s);

interface Fixture {
  manifestBody?: string;
  bundleBody?: string;
  artifactType?: string;
  /** Serve this instead of the real manifest blob (digest stays the original). */
  tamperManifestBlob?: string;
  manifestStatus?: number;
  cosignExit?: number;
  dropBundleLayer?: boolean;
}

/** An in-memory OCI registry + cosign stub. Records every cosign call. */
function fixture(f: Fixture = {}) {
  const manifestBytes = enc(f.manifestBody ?? JSON.stringify(MANIFEST));
  const bundleBytes = enc(
    f.bundleBody ?? '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}',
  );
  const layers = [
    { mediaType: RELEASE_MANIFEST_MEDIA_TYPE, digest: sha(manifestBytes) },
    ...(f.dropBundleLayer
      ? []
      : [{ mediaType: SIGSTORE_BUNDLE_MEDIA_TYPE, digest: sha(bundleBytes) }]),
  ];
  const blobs = new Map<string, Uint8Array>([
    [sha(manifestBytes), f.tamperManifestBlob ? enc(f.tamperManifestBlob) : manifestBytes],
    [sha(bundleBytes), bundleBytes],
  ]);
  const urls: string[] = [];
  const cosignCalls: (readonly string[])[] = [];
  const deps: ReleaseManifestDeps = {
    registry: "registry.test",
    repository: "caelo/release-manifest",
    fetch: async (url) => {
      urls.push(url);
      const m = /\/v2\/caelo\/release-manifest\/(manifests|blobs)\/(.+)$/.exec(url);
      if (!m) return new Response("", { status: 404 });
      if (m[1] === "manifests") {
        if (f.manifestStatus) return new Response("", { status: f.manifestStatus });
        return Response.json({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          artifactType: f.artifactType ?? RELEASE_MANIFEST_ARTIFACT_TYPE,
          layers,
        });
      }
      const blob = blobs.get(m[2] ?? "");
      return blob ? new Response(blob) : new Response("", { status: 404 });
    },
    cosign: async (args) => {
      cosignCalls.push(args);
      return { exitCode: f.cosignExit ?? 0, stderr: f.cosignExit ? "no matching signatures" : "" };
    },
  };
  return { deps, urls, cosignCalls };
}

describe("fetchVerifiedReleaseManifest", () => {
  it("returns the manifest when signature, schema and version check out", async () => {
    const { deps, urls } = fixture();
    const r = await fetchVerifiedReleaseManifest("0.11.0", deps);
    expect(r).toEqual({ ok: true, manifest: MANIFEST });
    expect(urls[0]).toBe("https://registry.test/v2/caelo/release-manifest/manifests/0.11.0");
  });

  it("pins cosign to release.yml on the exact tag", async () => {
    const { deps, cosignCalls } = fixture();
    await fetchVerifiedReleaseManifest("0.11.0", deps);
    expect(cosignCalls).toHaveLength(1);
    const args = cosignCalls[0] ?? [];
    expect(args[0]).toBe("verify-blob");
    expect(args).toContain("--bundle");
    const id = args[args.indexOf("--certificate-identity") + 1];
    expect(id).toBe(
      "https://github.com/caelo-cms/caelo-cms/.github/workflows/release.yml@refs/tags/v0.11.0",
    );
    expect(args[args.indexOf("--certificate-oidc-issuer") + 1]).toBe(RELEASE_OIDC_ISSUER);
    // An identity regexp would accept other refs; only the exact flag is used.
    expect(args).not.toContain("--certificate-identity-regexp");
  });

  it("refuses when cosign rejects the signature", async () => {
    const { deps } = fixture({ cosignExit: 1 });
    const r = await fetchVerifiedReleaseManifest("0.11.0", deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("signature");
      expect(r.error.message).toContain(releaseManifestSignerIdentity("0.11.0"));
    }
  });

  it("refuses a blob whose bytes do not match its digest, before calling cosign", async () => {
    const tampered = JSON.stringify({ ...MANIFEST, security: true, advisories: [] });
    const { deps, cosignCalls } = fixture({ tamperManifestBlob: tampered });
    const r = await fetchVerifiedReleaseManifest("0.11.0", deps);
    expect(r.ok ? null : r.error.code).toBe("blob-digest");
    expect(cosignCalls).toHaveLength(0);
  });

  it("refuses a signed manifest that describes another version (replay)", async () => {
    const { deps } = fixture({ manifestBody: JSON.stringify({ ...MANIFEST, version: "0.9.0" }) });
    const r = await fetchVerifiedReleaseManifest("0.11.0", deps);
    expect(r.ok ? null : r.error.code).toBe("version-mismatch");
  });

  it("refuses a manifest that fails the schema", async () => {
    const bad = { ...MANIFEST, digests: { admin: "sha256:nope", gateway: d("b"), ops: d("c") } };
    const { deps } = fixture({ manifestBody: JSON.stringify(bad) });
    const r = await fetchVerifiedReleaseManifest("0.11.0", deps);
    expect(r.ok ? null : r.error.code).toBe("schema");
  });

  it("refuses an artifact of the wrong type or without the bundle layer", async () => {
    const wrongType = await fetchVerifiedReleaseManifest(
      "0.11.0",
      fixture({ artifactType: "application/vnd.oci.image.config.v1+json" }).deps,
    );
    expect(wrongType.ok ? null : wrongType.error.code).toBe("artifact-shape");
    const noBundle = await fetchVerifiedReleaseManifest(
      "0.11.0",
      fixture({ dropBundleLayer: true }).deps,
    );
    expect(noBundle.ok ? null : noBundle.error.code).toBe("artifact-shape");
  });

  it("reports a missing manifest as a registry error with a next step", async () => {
    const r = await fetchVerifiedReleaseManifest("0.11.0", fixture({ manifestStatus: 404 }).deps);
    expect(r.ok ? null : r.error.code).toBe("registry");
    expect(r.ok ? "" : r.error.message).toContain("HTTP 404");
  });

  it("rejects a non-SemVer version without touching the network", async () => {
    const { deps, urls } = fixture();
    const r = await fetchVerifiedReleaseManifest("v0.11.0", deps);
    expect(r.ok ? null : r.error.code).toBe("schema");
    expect(urls).toHaveLength(0);
  });
});

describe("ReleaseManifestSchema", () => {
  it("accepts the canonical fixture and rejects a non-GHSA advisory", () => {
    expect(ReleaseManifestSchema.safeParse(MANIFEST).success).toBe(true);
    const cve = { ...MANIFEST, security: true, advisories: ["CVE-2026-1234"] };
    expect(ReleaseManifestSchema.safeParse(cve).success).toBe(false);
    const ghsa = { ...MANIFEST, security: true, advisories: ["GHSA-2c2m-4x8q-wx9f"] };
    expect(ReleaseManifestSchema.safeParse(ghsa).success).toBe(true);
  });
});

describe("compareImageDigests", () => {
  it("is empty when every resolved digest matches", () => {
    expect(compareImageDigests(MANIFEST, { admin: d("a"), gateway: d("b"), ops: d("c") })).toEqual(
      [],
    );
  });

  it("names each mismatching or unresolved image, ignores absent ones", () => {
    expect(compareImageDigests(MANIFEST, { admin: d("f"), gateway: null })).toEqual([
      { image: "admin", expected: d("a"), actual: d("f") },
      { image: "gateway", expected: d("b"), actual: null },
    ]);
  });
});

describe("assessAutoInstall", () => {
  const installed = { version: "0.10.43", infraContractVersion: 1 };

  it("auto-installs an expand-only release with the same infra contract", () => {
    expect(assessAutoInstall(MANIFEST, installed)).toEqual({
      mode: "auto",
      kind: "normal",
      reasons: [],
    });
    const advisories = ["GHSA-abcd-efgh-jkmp"];
    expect(assessAutoInstall({ ...MANIFEST, security: true, advisories }, installed).kind).toBe(
      "security",
    );
  });

  it("counts security only with a published advisory behind it (#696 decision 2)", () => {
    expect(assessAutoInstall({ ...MANIFEST, security: true }, installed).kind).toBe("normal");
  });

  it("downgrades a security release with contract migrations to manual", () => {
    const m = {
      ...MANIFEST,
      security: true,
      migrations: { contract: true, head: "x", lastContractVersion: "0.11.0" },
    };
    const a = assessAutoInstall(m, installed);
    expect(a.mode).toBe("manual");
    expect(a.kind).toBe("normal");
  });

  it("makes skipping a contract release manual, but not upgrading past it from after it", () => {
    const m = {
      ...MANIFEST,
      migrations: { ...MANIFEST.migrations, lastContractVersion: "0.10.50" },
    };
    const skipped = assessAutoInstall(m, installed);
    expect(skipped.mode).toBe("manual");
    expect(skipped.reasons[0]).toContain("skips v0.10.50");
    expect(assessAutoInstall(m, { ...installed, version: "0.10.50" }).mode).toBe("auto");
  });

  it("downgrades an infra contract bump to manual, also when skipped releases carried it", () => {
    const a = assessAutoInstall(
      { ...MANIFEST, security: true, infraContractVersion: 3 },
      installed,
    );
    expect(a.mode).toBe("manual");
    expect(a.reasons[0]).toContain("1 → 3");
  });

  it("refuses downgrades, re-installs and versions below minFromVersion", () => {
    expect(assessAutoInstall(MANIFEST, { ...installed, version: "0.11.0" }).mode).toBe("refused");
    expect(assessAutoInstall(MANIFEST, { ...installed, version: "0.12.0" }).mode).toBe("refused");
    expect(assessAutoInstall(MANIFEST, { ...installed, version: "0.9.9" }).mode).toBe("refused");
  });
});

describe("compareSemver / channelForVersion", () => {
  it("orders releases and pre-releases per SemVer", () => {
    expect(compareSemver("0.10.43", "0.10.9")).toBeGreaterThan(0);
    expect(compareSemver("0.11.0-rc.1", "0.11.0")).toBeLessThan(0);
    expect(compareSemver("0.11.0-rc.2", "0.11.0-rc.10")).toBeLessThan(0);
    expect(compareSemver("0.11.0-beta.1", "0.11.0-rc.1")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(() => compareSemver("v1.0.0", "1.0.0")).toThrow();
  });

  it("maps versions to channels", () => {
    expect(channelForVersion("0.11.0")).toBe("stable");
    expect(channelForVersion("0.11.0-rc.1")).toBe("rc");
    expect(channelForVersion("0.11.0-nightly.1")).toBeNull();
  });
});

describe("release-contract", () => {
  it("watches the stacks and converge sources, not their tests", () => {
    expect(isInfraContractPath("packages/provisioning/stacks/gcp/index.ts")).toBe(true);
    expect(isInfraContractPath("packages/provisioning/src/stack-converge.ts")).toBe(true);
    expect(isInfraContractPath("packages/provisioning/src/upgrade/converge.ts")).toBe(true);
    expect(isInfraContractPath("packages/provisioning/src/stack-converge.test.ts")).toBe(false);
    expect(isInfraContractPath("packages/provisioning/stacks/gcp/README.md")).toBe(false);
    expect(isInfraContractPath("packages/provisioning/src/cli.ts")).toBe(false);
  });

  it("keeps INFRA_CONTRACT_VERSION a literal the release scripts can read from a past tag", () => {
    // scripts/release-manifest.ts reads the previous tag's value with a
    // regex over `git show <tag>:<file>`, so it must stay a plain literal.
    const src = readFileSync(new URL("./infra-contract.ts", import.meta.url), "utf8");
    expect(src).toMatch(
      new RegExp(`export const INFRA_CONTRACT_VERSION = ${INFRA_CONTRACT_VERSION};`),
    );
  });
});

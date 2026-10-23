// SPDX-License-Identifier: MPL-2.0

/**
 * Which signed release serves (#860, #1025), with the shapes recorded on
 * live installs: the serving revisions name the linux/amd64 platform
 * manifests (`2e75…`, `d24f…`), the signed v0.10.64 manifest and
 * install.json the indexes (`bcda…`, `fbb0…`) that list them next to one
 * attestation manifest each.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import type { InstallMetadata } from "./install-state.js";
import type { ReleaseManifest, ReleaseManifestResult } from "./release-manifest.js";
import {
  ADMIN_AMD64,
  ADMIN_ATTESTATION,
  ADMIN_INDEX,
  fakeRegistryFetch,
  GATEWAY_AMD64,
  GATEWAY_INDEX,
} from "./upgrade/__tests__/live-indexes.js";
import { createReleaseImageForms } from "./upgrade/image-forms.js";
import {
  findServingRelease,
  recordMatchesServing,
  type ServingDigests,
  type ServingReleaseDeps,
} from "./upgrader-records.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;
const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });

const V064: ReleaseManifest = {
  manifestVersion: 1,
  version: "0.10.64",
  channel: "stable",
  digests: { admin: ADMIN_INDEX, gateway: GATEWAY_INDEX, ops: D("c") },
  minFromVersion: "0.10.0",
  infraContractVersion: 13,
  migrations: { contract: false, lastContractVersion: null, head: "0338_x" },
  security: false,
  advisories: [],
};

const META: InstallMetadata = {
  installId: "gcp-firebase-acme",
  provider: "gcp-firebase",
  projectId: "acme",
  domain: "acme.com",
  ownerEmail: "owner@acme.com",
  region: "europe-west1",
  createdAt: "2026-01-01T00:00:00Z",
  imageDigests: { admin: ADMIN_INDEX, gateway: GATEWAY_INDEX },
  releaseVersion: "0.10.64",
  infraContractVersion: 13,
};

/** What the serving revisions read back as on searchviu-website (spec = status). */
const LIVE_SERVING: ServingDigests = { admin: [ADMIN_AMD64], gateway: [GATEWAY_AMD64] };

function deps(
  opts: {
    manifests?: Record<string, ReleaseManifest>;
    calls?: string[];
    registry?: Parameters<typeof fakeRegistryFetch>[1];
    /** `gcloud artifacts docker tags list` answers: version → digest, per slug. */
    tags?: Partial<Record<"admin" | "gateway", Record<string, string>>>;
    hints?: ServingDigests;
  } = {},
): ServingReleaseDeps & { fetched: string[] } {
  const fetched: string[] = [];
  const manifests = opts.manifests ?? { "0.10.64": V064 };
  return {
    fetched,
    run: async (args) => {
      const line = args.join(" ");
      const slug = /\/(admin|gateway) /.exec(`${line} `)?.[1] as "admin" | "gateway" | undefined;
      if (line.startsWith("artifacts docker tags list") && slug) {
        const tags = opts.tags?.[slug] ?? {};
        return ok(
          Object.entries(tags)
            .map(
              ([v, d]) => `projects/p/locations/l/repositories/r/packages/${slug}/tags/${v}\t${d}`,
            )
            .join("\n"),
        );
      }
      return ok("");
    },
    fetchManifest: async (version): Promise<ReleaseManifestResult> => {
      fetched.push(version);
      const m = manifests[version];
      return m
        ? { ok: true, manifest: m }
        : {
            ok: false,
            error: { code: "registry", message: `no release manifest for v${version}` },
          };
    },
    imageForms: createReleaseImageForms(fakeRegistryFetch(opts.calls ?? [], opts.registry)),
    ...(opts.hints ? { hintDigests: async () => opts.hints as ServingDigests } : {}),
  };
}

describe("recordMatchesServing", () => {
  it("regression #1025: the index alone does not match what Cloud Run reports", () => {
    expect(recordMatchesServing(META, LIVE_SERVING)).toBe(false);
  });

  it("matches by the recorded platform forms", () => {
    const both = { ...META, platformDigests: { admin: ADMIN_AMD64, gateway: GATEWAY_AMD64 } };
    expect(recordMatchesServing(both, LIVE_SERVING)).toBe(true);
    // Still by the index when a revision names it.
    expect(recordMatchesServing(META, { admin: [ADMIN_INDEX], gateway: [GATEWAY_INDEX] })).toBe(
      true,
    );
  });

  it("both services must match, and no record never matches", () => {
    const both = { ...META, platformDigests: { admin: ADMIN_AMD64, gateway: GATEWAY_AMD64 } };
    expect(recordMatchesServing(both, { admin: [ADMIN_AMD64], gateway: [D("6")] })).toBe(false);
    expect(recordMatchesServing({}, LIVE_SERVING)).toBe(false);
  });
});

describe("findServingRelease", () => {
  it("regression #1025: identifies v0.10.64 from the platform digests inside its signed indexes", async () => {
    const calls: string[] = [];
    const d = deps({ calls });
    const r = await findServingRelease(META, LIVE_SERVING, d);
    expect(r).toEqual({
      ok: true,
      manifest: V064,
      platformDigests: { admin: ADMIN_AMD64, gateway: GATEWAY_AMD64 },
    });
    expect(d.fetched).toEqual(["0.10.64"]);
    expect(calls).toHaveLength(2);
  });

  it("an attestation manifest of the index is not a serving image of the release", async () => {
    const r = await findServingRelease(
      META,
      { admin: [ADMIN_ATTESTATION], gateway: [GATEWAY_AMD64] },
      deps(),
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toContain(
      "The gateway serves v0.10.64's image, the admin does not.",
    );
  });

  it("uses the signed platform digests without reading the index", async () => {
    const calls: string[] = [];
    const signed = {
      ...V064,
      platformDigests: { admin: ADMIN_AMD64, gateway: GATEWAY_AMD64, ops: D("3") },
    };
    const r = await findServingRelease(
      META,
      LIVE_SERVING,
      deps({ calls, manifests: { "0.10.64": signed } }),
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  it("a digest in no signed index is still refused with the current message", async () => {
    const r = await findServingRelease(META, { admin: [D("7")], gateway: [D("6")] }, deps());
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(r.ok ? "" : r.reason).toContain(
      "are not the ones install.json names, and they do not belong to one signed Caelo release",
    );
    expect(r.ok ? "" : r.reason).toContain(`admin ${D("7")}`);
  });

  it("a registry outage reading the index is retryable, a tampered index is not", async () => {
    const down = await findServingRelease(META, LIVE_SERVING, deps({ registry: { status: 503 } }));
    expect(down).toMatchObject({ ok: false, retryable: true });
    expect(down.ok ? "" : down.reason).toContain("could not be reached");

    const tampered = await findServingRelease(
      META,
      LIVE_SERVING,
      deps({ registry: { tampered: new TextEncoder().encode("{}") } }),
    );
    expect(tampered).toMatchObject({ ok: false, retryable: false });
    expect(tampered.ok ? "" : tampered.reason).toContain("could not be verified");
  });

  it("finds the release by the template's index when install.json names none", async () => {
    const { releaseVersion: _none, ...unversioned } = META;
    const meta = { ...unversioned, imageDigests: { admin: D("9"), gateway: D("8") } };
    const d = deps({
      tags: { admin: { "0.10.64": ADMIN_INDEX } },
      hints: { admin: [ADMIN_INDEX], gateway: [GATEWAY_INDEX] },
    });
    const r = await findServingRelease(meta, LIVE_SERVING, d);
    expect(r.ok && r.manifest.version).toBe("0.10.64");
    expect(d.fetched).toEqual(["0.10.64"]);
  });
});

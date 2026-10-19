// SPDX-License-Identifier: MPL-2.0

/**
 * findServingImage against a fake gcloud: the digest a revision was deployed
 * with is the release's index digest, Cloud Run's `status.imageDigest` the
 * platform manifest inside it (#860). Both must come back, so a recorded
 * index digest matches what serves.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "../gcloud.js";
import type { GcloudRunner } from "../gcloud-retry.js";
import { findServingImage, servingImageDigests } from "./gcp-lookup.js";

const INDEX = `sha256:${"a".repeat(64)}`;
const PLATFORM = `sha256:${"b".repeat(64)}`;
const REPO = "europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/admin";

const ok = (stdout: string): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });

function gcloud(revision: GcloudResult): GcloudRunner {
  return async (args) => {
    if (args.includes("services")) return ok("caelo-production-admin-x-00042-abc\n");
    return revision;
  };
}

const revision = (image: string, imageDigest?: string) =>
  ok(JSON.stringify({ spec: { containers: [{ image }] }, status: { imageDigest } }));

describe("findServingImage", () => {
  it("returns the deployed index digest and the platform digest Cloud Run resolved", async () => {
    const image = await findServingImage(
      gcloud(revision(`${REPO}@${INDEX}`, `${REPO}@${PLATFORM}`)),
      "acme",
      "europe-west1",
      "caelo-production-admin-x",
    );
    expect(image).toEqual({ deployedDigest: INDEX, resolvedDigest: PLATFORM });
    expect(servingImageDigests(image ?? { deployedDigest: null, resolvedDigest: null })).toEqual([
      INDEX,
      PLATFORM,
    ]);
  });

  it("a revision deployed by tag is known by its resolved digest only", async () => {
    const image = await findServingImage(
      gcloud(revision(`${REPO}:0.10.52`, `${REPO}@${PLATFORM}`)),
      "acme",
      "europe-west1",
      "svc",
    );
    expect(image).toEqual({ deployedDigest: null, resolvedDigest: PLATFORM });
  });

  it("one digest when both name the same image", () => {
    expect(servingImageDigests({ deployedDigest: INDEX, resolvedDigest: INDEX })).toEqual([INDEX]);
  });

  it("null when no digest can be read or the output is not JSON", async () => {
    expect(
      await findServingImage(gcloud(revision(`${REPO}:latest`)), "acme", "europe-west1", "svc"),
    ).toBeNull();
    expect(
      await findServingImage(gcloud(ok("not json")), "acme", "europe-west1", "svc"),
    ).toBeNull();
    // JSON of an unexpected shape reads as unknown instead of throwing.
    for (const odd of ["null", "[]", '{"spec":{"containers":{"image":1}}}', '{"status":"x"}']) {
      expect(await findServingImage(gcloud(ok(odd)), "acme", "europe-west1", "svc")).toBeNull();
    }
    expect(
      await findServingImage(
        gcloud({ ok: false, stdout: "", stderr: "denied", exitCode: 1 }),
        "acme",
        "europe-west1",
        "svc",
      ),
    ).toBeNull();
  });
});

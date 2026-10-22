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
import {
  findServingImage,
  lookupFailure,
  resolveGcpResourceName,
  servingImageDigests,
} from "./gcp-lookup.js";

const INDEX = `sha256:${"a".repeat(64)}`;
const PLATFORM = `sha256:${"b".repeat(64)}`;
const REPO = "europe-west1-docker.pkg.dev/caelo-website/caelo-cms-images/admin";

const ok = (stdout: string): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });
const REAUTH =
  "ERROR: (gcloud.run.services.list) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.";

describe("resolveGcpResourceName (#630)", () => {
  const lookup = (r: GcloudResult) =>
    resolveGcpResourceName(async () => r, "run-service", "caelo-production-admin", "acme", "eu");

  it("finds the first listed name", async () => {
    expect(await lookup(ok("\ncaelo-production-admin-3efcfea\nother\n"))).toEqual({
      status: "found",
      name: "caelo-production-admin-3efcfea",
    });
  });

  it("an empty listing is not-found", async () => {
    expect(await lookup(ok("\n"))).toEqual({ status: "not-found" });
  });

  it("a failed listing is an error with gcloud's stderr, never not-found", async () => {
    expect(await lookup(fail(REAUTH))).toEqual({
      status: "error",
      stderr: REAUTH,
      authExpired: true,
    });
    expect(await lookup(fail("ERROR: PERMISSION_DENIED: run.services.list"))).toEqual({
      status: "error",
      stderr: "ERROR: PERMISSION_DENIED: run.services.list",
      authExpired: false,
    });
  });
});

describe("lookupFailure", () => {
  const what = "caelo-production-admin* Cloud Run service";

  it("not-found reads as before", () => {
    expect(lookupFailure({ status: "not-found" }, what, "operator")).toBe(
      "Could not find the caelo-production-admin* Cloud Run service",
    );
  });

  it("expired operator credentials name gcloud auth login and what gcloud said", () => {
    const m = lookupFailure(
      { status: "error", stderr: REAUTH, authExpired: true },
      what,
      "operator",
    );
    expect(m).toContain("gcloud credentials expired");
    expect(m).toContain("gcloud auth login");
    expect(m).toContain("gcloud auth application-default login");
    expect(m).toContain("Reauthentication failed");
    expect(m).not.toContain("Could not find");
  });

  it("a job never tells anyone to run gcloud auth login", () => {
    const m = lookupFailure({ status: "error", stderr: REAUTH, authExpired: true }, what, "job");
    expect(m).not.toContain("gcloud auth login");
    expect(m).toContain("Nothing was changed");
    expect(m).toContain("Cloud Shell");
  });

  it("any other failure surfaces gcloud's first error line", () => {
    expect(
      lookupFailure(
        { status: "error", stderr: "ERROR: PERMISSION_DENIED: nope\nmore", authExpired: false },
        what,
        "operator",
      ),
    ).toBe(
      "Could not list the caelo-production-admin* Cloud Run service: gcloud failed (PERMISSION_DENIED: nope)",
    );
  });
});

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

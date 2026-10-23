// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #696 contract over the ops image + the signed release manifest
 * wiring. Each assertion is a load-bearing piece that would silently
 * weaken the upgrade trust chain if removed:
 *
 *   O1 Dockerfile.ops verifies every download it makes (sha256sum -c).
 *   O2 Bun never runs under QEMU: the builder is pinned to $BUILDPLATFORM.
 *   O3 The image runs as a non-root user with `caelo-ops` as entry point.
 *   O4 release-images builds ops multi-arch and boot-smokes it on PRs too.
 *   M1 release.yml signs the manifest with sign-blob under its own tag
 *      identity and verifies it before publishing.
 *   M2 npm + the GitHub Release wait for the manifest; the Release
 *      carries the manifest + bundle.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const ROOT = resolve(import.meta.dir, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

interface Step {
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly needs?: string | readonly string[];
  readonly steps?: readonly Step[];
  readonly strategy?: { matrix?: { include?: readonly Record<string, string>[] } };
}
interface Workflow {
  readonly jobs: Record<string, Job>;
}

describe("packages/provisioning/Dockerfile.ops", () => {
  const src = read("packages/provisioning/Dockerfile.ops");

  it("O1: every curl download is checked with sha256sum -c", () => {
    const downloads = src.match(/curl -fsSLo (\S+)/g) ?? [];
    expect(downloads.length).toBe(3);
    for (const d of downloads) {
      const file = d.split(" ").at(-1);
      expect(src).toContain(`  ${file}" | sha256sum -c -`);
    }
  });

  it("O2: the Bun builder stage runs on the build platform", () => {
    expect(src).toMatch(/FROM --platform=\$BUILDPLATFORM oven\/bun:\$\{BUN_VERSION\} AS builder/);
  });

  it("O3: non-root user, caelo-ops entry point", () => {
    expect(src).toMatch(/\nUSER caelo\n/);
    expect(src).toContain('ENTRYPOINT ["caelo-ops"]');
  });
});

describe("release-images.yml — ops image", () => {
  const wf = yaml.load(read(".github/workflows/release-images.yml")) as Workflow;
  const build = wf.jobs.build;
  const steps = build?.steps ?? [];

  it("O4: ops is in the matrix, multi-arch, and boot-smoked on every event", () => {
    const ops = build?.strategy?.matrix?.include?.find((e) => e.service === "ops");
    expect(ops?.dockerfile).toBe("packages/provisioning/Dockerfile.ops");
    expect(ops?.platforms).toBe("linux/amd64,linux/arm64");
    const smoke = steps.find((s) => s.name?.startsWith("Boot smoke (caelo-ops"));
    expect(smoke?.if).toBe("matrix.service == 'ops'");
    expect(smoke?.run).toContain("--version");
    const push = steps.find((s) => s.name === "Build + push");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
    expect(push?.with?.platforms).toBe("${{ matrix.platforms }}");
  });
});

describe("release.yml — signed release manifest", () => {
  const wf = yaml.load(read(".github/workflows/release.yml")) as Workflow;
  const job = wf.jobs["release-manifest"];
  const runs = (job?.steps ?? []).map((s) => s.run ?? "").join("\n");

  it("M1: generated after the images, signed keyless on the tag identity, verified", () => {
    expect(job?.needs).toEqual(["gate", "docker"]);
    expect(runs).toContain("bun scripts/release-manifest.ts generate");
    expect(runs).toContain("cosign sign-blob --yes --bundle release-manifest.json.sigstore.json");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variable in the workflow
    expect(runs).toContain("/.github/workflows/release.yml@refs/tags/v${V}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variable in the workflow
    expect(runs).toContain('"refs/tags/v${V}"');
    expect(runs).toContain("bun scripts/release-manifest.ts verify");
    expect(runs).toContain("oras copy -r");
  });

  it("M2: npm + GitHub Release depend on it; the Release attaches manifest + bundle", () => {
    expect(wf.jobs["publish-npm"]?.needs).toContain("release-manifest");
    const gh = wf.jobs["github-release"];
    expect(gh?.needs).toContain("release-manifest");
    const create = gh?.steps?.find((s) => s.name === "Create GitHub Release");
    expect(String(create?.with?.files)).toContain("release-manifest.json.sigstore.json");
  });

  it("M3 (#1025): signs each image's linux/amd64 platform digest, read from the index by digest", () => {
    const resolve = job?.steps?.find((s) => s.name === "Resolve the released image digests");
    const run = resolve?.run ?? "";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variable in the workflow
    expect(run).toContain('oras manifest fetch "ghcr.io/caelo-cms/${svc}@${digest}"');
    expect(run).toContain('.platform.os == "linux" and .platform.architecture == "amd64"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variable in the workflow
    expect(run).toContain("--platform-digest ${svc}=${platform}");
  });
});

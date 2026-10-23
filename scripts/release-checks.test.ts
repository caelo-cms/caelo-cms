// SPDX-License-Identifier: MPL-2.0

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BREAKING_SUBJECT,
  breakingCommitsSince,
  changedPathsSince,
  checkInfraContract,
  checkOwnerAction,
  expectedLastContractVersion,
  infraContractVersionAt,
  LAST_CONTRACT_BEFORE_MANIFESTS,
  lastContractVersionAt,
  parseAdvisoryList,
  previousStableTag,
  type ReleaseMeta,
  ReleaseMetaSchema,
  setJsonVersionField,
  validateReleaseMetaShape,
  verifyAdvisoriesPublished,
} from "./release-checks.ts";
import { buildReleaseManifest, parseDigestFlags } from "./release-manifest.ts";

const META: ReleaseMeta = {
  version: "0.11.0",
  security: false,
  advisories: [],
  acknowledgeContractMigrations: false,
  acknowledgeInfraNeutral: false,
  lastContractVersion: "0.10.42",
  ownerAction: null,
};
const GHSA = "GHSA-2c2m-4x8q-wx9f";
const d = (c: string) => `sha256:${c.repeat(64)}`;

describe("release-meta.json", () => {
  it("the committed declaration parses and matches the current version", () => {
    const root = resolve(import.meta.dir, "..");
    const meta = ReleaseMetaSchema.parse(
      JSON.parse(readFileSync(join(root, "release-meta.json"), "utf8")),
    );
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    expect(meta.version).toBe(pkg.version);
  });
});

describe("validateReleaseMetaShape", () => {
  it("accepts a normal release and a security release with a GHSA id", () => {
    expect(validateReleaseMetaShape(META)).toEqual([]);
    expect(validateReleaseMetaShape({ ...META, security: true, advisories: [GHSA] })).toEqual([]);
  });

  it("refuses security without advisories, advisories without security, and non-GHSA ids", () => {
    expect(validateReleaseMetaShape({ ...META, security: true })).toHaveLength(1);
    expect(validateReleaseMetaShape({ ...META, advisories: [GHSA] })).toHaveLength(1);
    expect(
      validateReleaseMetaShape({ ...META, security: true, advisories: ["CVE-2026-1"] }),
    ).toHaveLength(1);
  });

  it("#868: accepts one line of owner action, refuses blank, multi-line or overlong text", () => {
    expect(
      validateReleaseMetaShape({ ...META, ownerAction: "Re-enter the SMTP password." }),
    ).toEqual([]);
    for (const ownerAction of ["", " padded ", "two\nlines", "x".repeat(301)]) {
      expect(validateReleaseMetaShape({ ...META, ownerAction })).toHaveLength(1);
    }
  });

  it("parses the comma-list input", () => {
    expect(parseAdvisoryList(` ${GHSA} , ,${GHSA},GHSA-x `)).toEqual([GHSA, "GHSA-x"]);
    expect(parseAdvisoryList("")).toEqual([]);
  });
});

describe("verifyAdvisoriesPublished", () => {
  const api =
    (byId: Record<string, { status: number; body?: unknown }>) =>
    async (url: string, init?: RequestInit) => {
      expect(url).toStartWith(
        "https://api.github.com/repos/caelo-cms/caelo-cms/security-advisories/",
      );
      expect((init?.headers ?? {}) as Record<string, string>).toMatchObject({
        Authorization: "Bearer tkn",
      });
      const hit = byId[url.split("/").at(-1) ?? ""];
      return hit
        ? Response.json(hit.body ?? {}, { status: hit.status })
        : new Response("", { status: 404 });
    };

  it("passes only published advisories of this repo", async () => {
    const errors = await verifyAdvisoriesPublished(
      [GHSA, "GHSA-3c3c-3c3c-3c3c", "GHSA-4c4c-4c4c-4c4c"],
      {
        repo: "caelo-cms/caelo-cms",
        token: "tkn",
        fetch: api({
          [GHSA]: { status: 200, body: { ghsa_id: GHSA, state: "published" } },
          "GHSA-3c3c-3c3c-3c3c": {
            status: 200,
            body: { ghsa_id: "GHSA-3c3c-3c3c-3c3c", state: "draft" },
          },
        }),
      },
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('"draft"');
    expect(errors[1]).toContain("HTTP 404");
  });
});

describe("previousStableTag", () => {
  const tags = ["0.10.42", "0.10.43", "0.11.0-rc.1", "0.9.0", "0.11.0"];
  it("picks the newest stable tag below the release", () => {
    expect(previousStableTag(tags, "0.11.1")).toBe("v0.11.0");
    expect(previousStableTag(tags, "0.11.0")).toBe("v0.10.43");
    expect(previousStableTag(tags, "0.11.0-rc.2")).toBe("v0.10.43");
    expect(previousStableTag(tags, "0.9.0")).toBeNull();
    expect(previousStableTag(tags, null)).toBe("v0.11.0");
  });
});

describe("checkInfraContract", () => {
  const stack = "packages/provisioning/stacks/gcp/index.ts";
  const base = { previous: 2, current: 2, acknowledgeInfraNeutral: false };

  it("fails when infra files changed without a bump, and names them", () => {
    const r = checkInfraContract({ ...base, changedPaths: [stack, "apps/admin/x.ts"] });
    expect(r.ok).toBe(false);
    expect(r.changedPaths).toEqual([stack]);
    expect(r.message).toContain("INFRA_CONTRACT_VERSION");
  });

  it("passes on a bump, on an infra-neutral acknowledgement, and when nothing relevant changed", () => {
    expect(checkInfraContract({ ...base, current: 3, changedPaths: [stack] }).ok).toBe(true);
    expect(
      checkInfraContract({ ...base, acknowledgeInfraNeutral: true, changedPaths: [stack] }).ok,
    ).toBe(true);
    expect(
      checkInfraContract({
        ...base,
        changedPaths: ["packages/provisioning/src/stack-converge.test.ts"],
      }).ok,
    ).toBe(true);
  });

  it("never allows the version to go down; a missing baseline passes", () => {
    expect(checkInfraContract({ ...base, current: 1, changedPaths: [] }).ok).toBe(false);
    expect(checkInfraContract({ ...base, previous: null, changedPaths: [stack] }).ok).toBe(true);
  });
});

describe("expectedLastContractVersion", () => {
  const base = { version: "0.11.0", contractMigrations: false, previousTag: "v0.10.50" };
  it("is the release itself when it carries contract migrations", () => {
    expect(
      expectedLastContractVersion({ ...base, contractMigrations: true, previous: "0.10.42" }),
    ).toBe("0.11.0");
  });

  it("carries the previous release's value forward, seeded for pre-manifest tags", () => {
    expect(expectedLastContractVersion({ ...base, previous: "0.10.48" })).toBe("0.10.48");
    expect(expectedLastContractVersion({ ...base, previous: null })).toBeNull();
    expect(expectedLastContractVersion({ ...base, previous: undefined })).toBe(
      LAST_CONTRACT_BEFORE_MANIFESTS,
    );
    expect(
      expectedLastContractVersion({ ...base, previousTag: null, previous: undefined }),
    ).toBeNull();
  });
});

describe("infra contract against a real previous tag (git)", () => {
  const repo = mkdtempSync(join(tmpdir(), "caelo-infra-contract-"));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
  };
  const write = (rel: string, body: string) => {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), body);
  };
  const contract = "packages/provisioning/src/infra-contract.ts";
  const stack = "packages/provisioning/stacks/gcp/index.ts";

  it("detects a stack change since the tag that did not bump the constant", () => {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    write(contract, "export const INFRA_CONTRACT_VERSION = 4;\n");
    write(stack, "// v1\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("tag", "v0.1.0");
    write(stack, "// v2: new IAM binding\n");
    git("commit", "-qam", "stack change");

    const previous = infraContractVersionAt("v0.1.0", repo);
    expect(previous).toBe(4);
    const changed = changedPathsSince("v0.1.0", repo);
    expect(
      checkInfraContract({
        changedPaths: changed,
        previous,
        current: 4,
        acknowledgeInfraNeutral: false,
      }).ok,
    ).toBe(false);
    expect(
      checkInfraContract({
        changedPaths: changed,
        previous,
        current: 5,
        acknowledgeInfraNeutral: false,
      }).ok,
    ).toBe(true);
    expect(infraContractVersionAt("HEAD~1:does-not-exist", repo)).toBeNull();
    // No release-meta.json at the tag → undefined (seeded by the caller).
    expect(lastContractVersionAt("v0.1.0", repo)).toBeUndefined();
    write("release-meta.json", JSON.stringify({ lastContractVersion: "0.0.9" }));
    git("add", ".");
    git("commit", "-qm", "meta");
    git("tag", "v0.1.1");
    expect(lastContractVersionAt("v0.1.1", repo)).toBe("0.0.9");
  });
});

describe("ownerAction rule (#868)", () => {
  it("recognises breaking conventional-commit subjects only", () => {
    expect(BREAKING_SUBJECT.test("feat(updates)!: drop the old step-up")).toBe(true);
    expect(BREAKING_SUBJECT.test("fix!: x")).toBe(true);
    expect(BREAKING_SUBJECT.test("feat(updates): add skip")).toBe(false);
    expect(BREAKING_SUBJECT.test("chore: bump! deps")).toBe(false);
  });

  it("requires an owner action for a breaking release and refuses one without", () => {
    const breaking = ["feat(x)!: remove y"];
    expect(checkOwnerAction({ breakingSubjects: breaking, ownerAction: null })).toContain(
      "feat(x)!: remove y",
    );
    expect(checkOwnerAction({ breakingSubjects: breaking, ownerAction: "Do z." })).toBeNull();
    expect(checkOwnerAction({ breakingSubjects: [], ownerAction: null })).toBeNull();
    expect(checkOwnerAction({ breakingSubjects: [], ownerAction: "Do z." })).toContain(
      "never show it",
    );
  });

  it("finds the breaking commits since a tag (git)", () => {
    const repo = mkdtempSync(join(tmpdir(), "caelo-owner-action-"));
    try {
      const git = (...args: string[]) => {
        const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
        if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
      };
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      git("commit", "-q", "--allow-empty", "-m", "feat!: before the tag");
      git("tag", "v0.1.0");
      git("commit", "-q", "--allow-empty", "-m", "fix: harmless");
      git("commit", "-q", "--allow-empty", "-m", "feat(updates)!: breaks something");
      expect(breakingCommitsSince("v0.1.0", repo)).toEqual(["feat(updates)!: breaks something"]);
      expect(breakingCommitsSince(null, repo)).toHaveLength(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("buildReleaseManifest / parseDigestFlags", () => {
  const digests = { admin: d("a"), gateway: d("b"), ops: d("c") };
  const platformDigests = { admin: d("1"), gateway: d("2"), ops: d("3") };

  it("builds a schema-valid manifest carrying the declaration", () => {
    const m = buildReleaseManifest({
      meta: { ...META, version: "0.11.0-rc.1", security: true, advisories: [GHSA] },
      digests,
      platformDigests,
      contractMigrations: true,
      migrationHead: "0262_x",
    });
    expect(m.channel).toBe("rc");
    expect(m.security).toBe(true);
    expect(m.advisories).toEqual([GHSA]);
    expect(m.migrations).toEqual({
      contract: true,
      head: "0262_x",
      lastContractVersion: "0.10.42",
    });
    expect(m.manifestVersion).toBe(1);
    // No breaking change declared: no ownerAction key at all.
    expect("ownerAction" in m).toBe(false);
  });

  it("#868: signs the owner action into the manifest when declared", () => {
    const m = buildReleaseManifest({
      meta: { ...META, ownerAction: "Re-enter the SMTP password in Settings → Email." },
      digests,
      platformDigests,
      contractMigrations: false,
      migrationHead: "0332_x",
    });
    expect(m.ownerAction).toBe("Re-enter the SMTP password in Settings → Email.");
  });

  it("refuses a version without a known channel and a bad digest", () => {
    expect(() =>
      buildReleaseManifest({
        meta: { ...META, version: "0.11.0-nightly.1" },
        digests,
        platformDigests,
        contractMigrations: false,
        migrationHead: "h",
      }),
    ).toThrow(/channel/);
    expect(() =>
      buildReleaseManifest({
        meta: META,
        digests: { ...digests, ops: "latest" },
        platformDigests,
        contractMigrations: false,
        migrationHead: "h",
      }),
    ).toThrow();
  });

  it("parses --digest flags and rejects unknown images", () => {
    expect(parseDigestFlags(["--digest", `admin=${d("a")}`, "--digest", `ops=${d("c")}`])).toEqual({
      admin: d("a"),
      ops: d("c"),
    });
    expect(() => parseDigestFlags(["--digest", `edge=${d("a")}`])).toThrow(/bad --digest/);
  });

  it("#1025: signs each index's linux/amd64 digest and parses --platform-digest", () => {
    const m = buildReleaseManifest({
      meta: META,
      digests,
      platformDigests,
      contractMigrations: false,
      migrationHead: "h",
    });
    expect(m.platformDigests).toEqual(platformDigests);
    const argv = ["--digest", `admin=${d("a")}`, "--platform-digest", `admin=${d("1")}`];
    expect(parseDigestFlags(argv)).toEqual({ admin: d("a") });
    expect(parseDigestFlags(argv, "--platform-digest")).toEqual({ admin: d("1") });
    expect(() => parseDigestFlags(["--platform-digest", "admin"], "--platform-digest")).toThrow(
      /bad --platform-digest/,
    );
  });
});

describe("setJsonVersionField", () => {
  const manifest = `{
  "name": "caelo",
  "version": "0.10.64",
  "keywords": ["cms", "mcp"],
  "author": { "name": "Caelo", "version": "keep" }
}
`;

  it("bumps the top-level version and leaves the rest byte-identical (v0.10.65 gate lint)", () => {
    expect(setJsonVersionField(manifest, "0.10.65")).toBe(
      manifest.replace('"version": "0.10.64"', '"version": "0.10.65"'),
    );
  });

  it("refuses a manifest without a version field", () => {
    expect(() => setJsonVersionField('{ "name": "x" }\n', "1.0.0")).toThrow(/no "version" field/);
  });
});

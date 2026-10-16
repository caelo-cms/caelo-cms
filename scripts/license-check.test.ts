// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the dependency licence gate (`scripts/license-check.ts`,
 * issue #794): SPDX evaluation, the empty-scan guard, the pinned exception
 * list, the libvips-only LGPL pattern, and lockstep with
 * `.github/workflows/dependency-review.yml`. The real scan runs in CI as
 * `bun run license:check`; these tests use synthetic package lists.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dependencyReviewExemptions } from "./license-check.test-helpers.ts";
import {
  ALLOWED_LICENSES,
  evaluateLicenses,
  LICENSE_EXCEPTIONS,
  type LicenseException,
  MIN_PACKAGES,
  type ScannedPackage,
  SHARP_LIBVIPS_PACKAGE,
  satisfiesAllowList,
  toScannedPackages,
} from "./license-check.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

const POLICY = { allowed: ALLOWED_LICENSES, exceptions: LICENSE_EXCEPTIONS, minPackages: 3 };

/** A scan that uses every exception once, plus filler, so the baseline passes. */
function baseline(): ScannedPackage[] {
  return [
    { name: "@img/sharp-libvips-linux-x64", version: "1.3.4", license: "LGPL-3.0-or-later" },
    { name: "@fontsource-variable/schibsted-grotesk", version: "5.3.0", license: "OFL-1.1" },
    { name: "@fontsource/ibm-plex-mono", version: "5.3.0", license: "OFL-1.1" },
    { name: "spdx-exceptions", version: "2.5.0", license: "CC-BY-3.0" },
    { name: "spdx-ranges", version: "2.1.1", license: "(MIT AND CC-BY-3.0)" },
    { name: "pako", version: "1.0.11", license: "(MIT AND Zlib)" },
    { name: "@logdna/tail-file", version: "2.2.0", license: "Custom: LICENSE" },
    { name: "left-pad", version: "1.3.0", license: "MIT" },
  ];
}

describe("satisfiesAllowList", () => {
  const allowed = ALLOWED_LICENSES;

  it.each([
    "MIT",
    "MIT*",
    "Apache-2.0",
    "(MIT OR CC0-1.0)",
    "(MPL-2.0 OR Apache-2.0)",
    "(AFL-2.1 OR BSD-3-Clause)",
    "(BSD-2-Clause OR MIT OR Apache-2.0)",
    "(BSD-3-Clause AND Apache-2.0)",
    "MIT OR (GPL-3.0-only AND ISC)",
  ])("accepts %s", (expression) => {
    expect(satisfiesAllowList(expression, allowed)).toBe(true);
  });

  it.each([
    "LGPL-3.0-or-later",
    "GPL-3.0-only",
    "OFL-1.1",
    "(MIT AND CC-BY-3.0)",
    "(MIT AND Zlib)",
    "GPL-2.0-only WITH Classpath-exception-2.0",
    "Custom: LICENSE",
    "UNKNOWN",
    "UNLICENSED",
    "(MIT",
    "MIT AND",
    "",
  ])("rejects %s", (expression) => {
    expect(satisfiesAllowList(expression, allowed)).toBe(false);
  });
});

describe("evaluateLicenses", () => {
  it("passes a scan where every package is allowed or excepted", () => {
    expect(evaluateLicenses(baseline(), POLICY).failures).toEqual([]);
  });

  it("fails an empty or near-empty scan", () => {
    const report = evaluateLicenses([], { ...POLICY, exceptions: [] });
    expect(report.examined).toBe(0);
    expect(report.failures.join("\n")).toMatch(/Only 0 packages were examined/);
  });

  it("guards real scans with a minimum of at least 500 packages", () => {
    expect(MIN_PACKAGES).toBeGreaterThanOrEqual(500);
  });

  it("fails any other LGPL package", () => {
    const report = evaluateLicenses(
      [...baseline(), { name: "some-lgpl-lib", version: "1.0.0", license: "LGPL-3.0-or-later" }],
      POLICY,
    );
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain("some-lgpl-lib@1.0.0");
  });

  it("fails a new non-allow-listed licence", () => {
    const report = evaluateLicenses(
      [...baseline(), { name: "copyleft", version: "2.0.0", license: "AGPL-3.0-only" }],
      POLICY,
    );
    expect(report.failures).toHaveLength(1);
  });

  it("fails an excepted package whose licence changed", () => {
    const pkgs = baseline().map((p) =>
      p.name === "@img/sharp-libvips-linux-x64" ? { ...p, license: "GPL-3.0-or-later" } : p,
    );
    const failures = evaluateLicenses(pkgs, POLICY).failures.join("\n");
    expect(failures).toContain("@img/sharp-libvips-linux-x64@1.3.4");
    expect(failures).toMatch(/matched no installed package/);
  });

  it("fails a version-pinned exception on an unverified version", () => {
    const pkgs = baseline().map((p) =>
      p.name === "@logdna/tail-file" ? { ...p, version: "3.0.0" } : p,
    );
    expect(evaluateLicenses(pkgs, POLICY).failures.join("\n")).toContain("@logdna/tail-file@3.0.0");
  });

  it("fails a stale exception that no package uses", () => {
    const stale: LicenseException = { name: "gone", license: "WTFPL", reason: "test" };
    const report = evaluateLicenses(baseline(), {
      ...POLICY,
      exceptions: [...LICENSE_EXCEPTIONS, stale],
    });
    expect(report.failures).toEqual([
      expect.stringContaining("Licence exception for gone (WTFPL) matched no installed package"),
    ]);
  });
});

describe("toScannedPackages", () => {
  it("splits scoped name@version keys and joins licence arrays as AND", () => {
    expect(
      toScannedPackages({
        "@img/sharp-libvips-linux-x64@1.3.4": { licenses: "LGPL-3.0-or-later" },
        "dual@1.0.0": { licenses: ["MIT", "Apache-2.0"] },
      }),
    ).toEqual([
      { name: "@img/sharp-libvips-linux-x64", version: "1.3.4", license: "LGPL-3.0-or-later" },
      { name: "dual", version: "1.0.0", license: "MIT AND Apache-2.0" },
    ]);
  });

  it("throws on a package without a licence field", () => {
    expect(() => toScannedPackages({ "x@1.0.0": {} })).toThrow(/no licence field for x@1.0.0/);
  });
});

describe("pinned exception list", () => {
  it("is exactly the reviewed set (widening it needs a change here too)", () => {
    expect(
      LICENSE_EXCEPTIONS.map((e) => ({
        name: String(e.name),
        license: e.license,
        versions: e.versions ?? null,
      })),
    ).toEqual([
      { name: String(SHARP_LIBVIPS_PACKAGE), license: "LGPL-3.0-or-later", versions: null },
      { name: "@fontsource-variable/schibsted-grotesk", license: "OFL-1.1", versions: null },
      { name: "@fontsource/ibm-plex-mono", license: "OFL-1.1", versions: null },
      { name: "spdx-exceptions", license: "CC-BY-3.0", versions: null },
      { name: "spdx-ranges", license: "(MIT AND CC-BY-3.0)", versions: null },
      { name: "pako", license: "(MIT AND Zlib)", versions: null },
      { name: "@logdna/tail-file", license: "Custom: LICENSE", versions: ["2.2.0"] },
    ]);
  });

  it("every exception carries a reason", () => {
    for (const e of LICENSE_EXCEPTIONS) expect(e.reason.length).toBeGreaterThan(40);
  });

  it("no global allow-list entry is copyleft or attribution-only", () => {
    expect(ALLOWED_LICENSES.join(";")).not.toMatch(/GPL|OFL|CC-BY|SSPL|Zlib/i);
  });
});

describe("LGPL exception covers only @img/sharp-libvips-*", () => {
  const libvipsInLockfile = [
    ...new Set(read("bun.lock").match(/"@img\/sharp-libvips-[a-z0-9-]+(?=")/g) ?? []),
  ].map((s) => s.slice(1));

  it("the only pattern-based exception is the libvips one", () => {
    const patterns = LICENSE_EXCEPTIONS.filter((e) => typeof e.name !== "string");
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.name).toBe(SHARP_LIBVIPS_PACKAGE);
    const lgpl = LICENSE_EXCEPTIONS.filter((e) => /GPL/i.test(e.license));
    expect(lgpl).toEqual(patterns);
  });

  it("matches every libvips platform package in bun.lock", () => {
    expect(libvipsInLockfile.length).toBeGreaterThanOrEqual(2);
    for (const name of libvipsInLockfile) expect(name).toMatch(SHARP_LIBVIPS_PACKAGE);
  });

  it.each([
    "@img/sharp-linux-x64",
    "@img/sharp-darwin-arm64",
    "@img/sharp-wasm32",
    "@img/colour",
    "@img/sharp-libvips",
    "@img/sharp-libvips-",
    "sharp",
    "sharp-libvips-linux-x64",
    "@evil/sharp-libvips-linux-x64",
    "@img/sharp-libvips-linux-x64/../evil",
  ])("does not match %s", (name) => {
    expect(name).not.toMatch(SHARP_LIBVIPS_PACKAGE);
  });

  it("dependency-review exempts every libvips platform package", () => {
    const exempted = dependencyReviewExemptions(read(".github/workflows/dependency-review.yml"));
    for (const name of libvipsInLockfile) expect(exempted).toContain(name);
  });
});

describe("dependency-review lockstep", () => {
  const exempted = dependencyReviewExemptions(read(".github/workflows/dependency-review.yml"));

  it("every exempted purl is covered by a LICENSE_EXCEPTIONS entry (no wider than the policy)", () => {
    for (const name of exempted) {
      const covered = LICENSE_EXCEPTIONS.some((e) =>
        typeof e.name === "string" ? e.name === name : e.name.test(name),
      );
      expect({ name, covered }).toEqual({ name, covered: true });
    }
  });

  it("package.json runs this gate", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["license:check"]).toBe("bun scripts/license-check.ts");
  });
});

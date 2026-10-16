// SPDX-License-Identifier: MPL-2.0

/**
 * Dependency licence gate (CLAUDE.md §3, issue #794) — `bun run license:check`.
 *
 * Every installed third-party package, across all workspaces and including
 * dev dependencies, must carry a licence from {@link ALLOWED_LICENSES}, or be
 * covered by one of the narrow, reasoned entries in {@link LICENSE_EXCEPTIONS}.
 *
 * Why a wrapper instead of `license-checker-rseidelsohn --onlyAllow`:
 * - Under bun workspaces `--production` resolves 0 packages, so the old gate
 *   passed without looking at anything. {@link MIN_PACKAGES} turns an empty or
 *   near-empty scan into a failure (CLAUDE.md §2: fail loudly).
 * - `--onlyAllow` matches by substring, so `(MIT AND CC-BY-3.0)` passed because
 *   it contains "MIT". {@link satisfiesAllowList} evaluates the SPDX expression:
 *   every `AND` operand must be allowed, one `OR` operand suffices.
 * - Exceptions are per package and pin the exact licence string, so another
 *   licence appearing on an excepted package still fails.
 *
 * `scripts/license-check.test.ts` pins the exception list; the pure helpers are
 * exported for it and the scan only runs under `import.meta.main`.
 */

import { resolve } from "node:path";
import { init, type ModuleInfos } from "license-checker-rseidelsohn";

/**
 * MPL-2.0-compatible licences accepted for any package. Mirrors
 * `allow-licenses` in `.github/workflows/dependency-review.yml` (the test
 * keeps the two in lockstep).
 */
export const ALLOWED_LICENSES: readonly string[] = [
  "MPL-2.0",
  "Apache-2.0",
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
  "BlueOak-1.0.0",
];

/** A per-package licence exception. Each one is a reviewed decision with a reason. */
export interface LicenseException {
  /** Exact package name, or a pattern for a family of per-platform packages. */
  readonly name: string | RegExp;
  /** The licence string exactly as the checker reports it. Anything else still fails. */
  readonly license: string;
  /** Restricts the exception to versions whose licence text was checked by hand. */
  readonly versions?: readonly string[];
  readonly reason: string;
}

/** Matches the prebuilt libvips packages for every platform, and nothing else under `@img/`. */
export const SHARP_LIBVIPS_PACKAGE = /^@img\/sharp-libvips-[a-z0-9]+(-[a-z0-9]+)*$/;

export const LICENSE_EXCEPTIONS: readonly LicenseException[] = [
  {
    name: SHARP_LIBVIPS_PACKAGE,
    license: "LGPL-3.0-or-later",
    reason:
      "Prebuilt libvips for sharp, which the requirements mandate. libvips is a separate shared library loaded at runtime, so the LGPL does not reach Caelo's code; the images that redistribute it ship THIRD_PARTY_NOTICES.txt with the LGPL/GPL texts and the source link (scripts/libvips-notice.ts).",
  },
  {
    name: "@fontsource-variable/schibsted-grotesk",
    license: "OFL-1.1",
    reason: "Admin brand font, self-hosted. OFL-1.1 is accepted for fonts only (issue #778).",
  },
  {
    name: "@fontsource/ibm-plex-mono",
    license: "OFL-1.1",
    reason: "Admin brand font, self-hosted. OFL-1.1 is accepted for fonts only (issue #778).",
  },
  {
    name: "spdx-exceptions",
    license: "CC-BY-3.0",
    reason:
      "Licence-metadata data file (list of SPDX exception ids), dev-only via the licence checker itself; never shipped.",
  },
  {
    name: "spdx-ranges",
    license: "(MIT AND CC-BY-3.0)",
    reason:
      "Licence-metadata data file (SPDX licence ranges), dev-only via the licence checker itself; never shipped.",
  },
  {
    name: "pako",
    license: "(MIT AND Zlib)",
    reason:
      "zlib port used by the font tooling (@pdf-lib/fontkit, woff2sfnt-sfnt2woff). The Zlib licence is permissive and MPL-2.0-compatible.",
  },
  {
    name: "@logdna/tail-file",
    license: "Custom: LICENSE",
    versions: ["2.2.0"],
    reason:
      'Transitive Pulumi dependency. package.json says "SEE LICENSE IN LICENSE"; the LICENSE file of 2.2.0 is the MIT text verbatim (checked 2026-10-16). Re-check the text on a version bump.',
  },
];

/** A scan that sees fewer packages than this is broken, not clean (the bun `--production` trap saw 0). */
export const MIN_PACKAGES = 500;

/** One installed package as the checker reports it. */
export interface ScannedPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

export interface LicenseReport {
  readonly examined: number;
  /** Human-readable failures; empty means the gate passes. */
  readonly failures: readonly string[];
}

type Token = "(" | ")" | "AND" | "OR" | "WITH" | { readonly id: string };

function tokenize(expression: string): Token[] {
  const words = expression
    .replace(/([()])/g, " $1 ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((w) => {
    if (w === "(" || w === ")" || w === "AND" || w === "OR" || w === "WITH") return w;
    return { id: w };
  });
}

/**
 * True when the SPDX expression is satisfiable from `allowed`: all operands of
 * an `AND`, any operand of an `OR`. A trailing `*` (the checker's marker for a
 * licence guessed from the LICENSE file, e.g. `MIT*`) is ignored. `WITH`
 * exceptions and anything unparseable are not allowed.
 */
export function satisfiesAllowList(expression: string, allowed: readonly string[]): boolean {
  const tokens = tokenize(expression);
  let pos = 0;

  const parseOr = (): boolean => {
    let result = parseAnd();
    while (tokens[pos] === "OR") {
      pos++;
      result = parseAnd() || result;
    }
    return result;
  };
  const parseAnd = (): boolean => {
    let result = parseAtom();
    while (tokens[pos] === "AND") {
      pos++;
      result = parseAtom() && result;
    }
    return result;
  };
  const parseAtom = (): boolean => {
    const token = tokens[pos++];
    if (token === "(") {
      const inner = parseOr();
      if (tokens[pos++] !== ")") throw new Error("unbalanced parentheses");
      return inner;
    }
    if (token === undefined || typeof token === "string") throw new Error("expected a licence id");
    if (tokens[pos] === "WITH") {
      pos += 2;
      return false;
    }
    return allowed.includes(token.id.replace(/\*$/, ""));
  };

  try {
    const result = parseOr();
    return pos === tokens.length && result;
  } catch {
    return false;
  }
}

function exceptionMatches(exception: LicenseException, pkg: ScannedPackage): boolean {
  const nameMatches =
    typeof exception.name === "string"
      ? exception.name === pkg.name
      : exception.name.test(pkg.name);
  return (
    nameMatches &&
    exception.license === pkg.license &&
    (exception.versions === undefined || exception.versions.includes(pkg.version))
  );
}

/**
 * Applies the policy to a scan. Fails on any package outside the allow-list
 * and its exceptions, on a scan below `minPackages`, and on an exception that
 * no installed package uses (a stale entry would silently widen the gate the
 * next time a package by that name appears).
 */
export function evaluateLicenses(
  packages: readonly ScannedPackage[],
  policy: {
    readonly allowed: readonly string[];
    readonly exceptions: readonly LicenseException[];
    readonly minPackages: number;
  },
): LicenseReport {
  const failures: string[] = [];
  if (packages.length < policy.minPackages) {
    failures.push(
      `Only ${packages.length} packages were examined (minimum ${policy.minPackages}). The scan is broken (missing \`bun install\`, or a flag such as --production that resolves nothing under bun workspaces), not clean.`,
    );
  }

  const used = new Set<LicenseException>();
  for (const pkg of packages) {
    if (satisfiesAllowList(pkg.license, policy.allowed)) continue;
    const exception = policy.exceptions.find((e) => exceptionMatches(e, pkg));
    if (exception) {
      used.add(exception);
      continue;
    }
    failures.push(
      `${pkg.name}@${pkg.version} is licensed "${pkg.license}", which is not MPL-2.0-compatible per CLAUDE.md §3. Replace the dependency, or add a reviewed exception with a reason to LICENSE_EXCEPTIONS in scripts/license-check.ts.`,
    );
  }

  for (const exception of policy.exceptions) {
    if (!used.has(exception)) {
      failures.push(
        `Licence exception for ${String(exception.name)} (${exception.license}) matched no installed package. Remove it from LICENSE_EXCEPTIONS, or re-verify it if the package's version or licence changed.`,
      );
    }
  }

  return { examined: packages.length, failures };
}

/** Converts the checker's `name@version` map into {@link ScannedPackage}s. */
export function toScannedPackages(infos: ModuleInfos): ScannedPackage[] {
  return Object.entries(infos).map(([key, info]) => {
    const at = key.lastIndexOf("@");
    const licenses = info.licenses;
    if (licenses === undefined)
      throw new Error(`license checker returned no licence field for ${key}`);
    return {
      name: key.slice(0, at),
      version: key.slice(at + 1),
      // A `licenses` array in package.json is ambiguous; treat it as a conjunction.
      license: Array.isArray(licenses) ? licenses.join(" AND ") : licenses,
    };
  });
}

function scan(start: string): Promise<ModuleInfos> {
  return new Promise((resolvePromise, reject) => {
    init({ start, excludePrivatePackages: true }, (err, infos) =>
      err ? reject(err) : resolvePromise(infos),
    );
  });
}

if (import.meta.main) {
  const packages = toScannedPackages(await scan(resolve(import.meta.dir, "..")));
  const report = evaluateLicenses(packages, {
    allowed: ALLOWED_LICENSES,
    exceptions: LICENSE_EXCEPTIONS,
    minPackages: MIN_PACKAGES,
  });
  if (report.failures.length > 0) {
    for (const failure of report.failures) console.error(`license:check: ${failure}`);
    process.exit(1);
  }
  console.log(
    `license:check: ${report.examined} packages examined, all MPL-2.0-compatible or covered by one of ${LICENSE_EXCEPTIONS.length} reviewed exceptions.`,
  );
}

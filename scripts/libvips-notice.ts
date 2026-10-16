// SPDX-License-Identifier: MPL-2.0

/**
 * Generates THIRD_PARTY_NOTICES.txt for a container image that redistributes
 * the prebuilt libvips from `@img/sharp-libvips-<platform>` (issue #794).
 *
 * libvips and several libraries bundled with it (glib, pango, librsvg, …) are
 * used under LGPL-3.0-or-later. Redistributing them in `ghcr.io/caelo-cms/*`
 * triggers the LGPL-3.0 §4 duties: say the library is used and under what
 * licence, ship the LGPL and GPL texts, and point at the corresponding source.
 * The npm package carries no LICENSE file, so the image would otherwise carry
 * no notice at all. Replaceability (§4(d)) is met by the separate shared
 * object, which sharp loads at runtime.
 *
 * The notice is built from what is actually installed: each package's
 * `package.json`, `versions.json` (bundled library versions) and the
 * "Licensing" table of its README. Finding no libvips package, or a package
 * without that data, is an error (CLAUDE.md §2: no silent fallbacks). The
 * licence texts come from `licenses/` in the repo, not from the network.
 *
 * Self-contained (node builtins and Bun only): the Dockerfiles copy this one
 * file into the runtime stage and run it against the final `/app` tree.
 *
 * Usage: `bun scripts/libvips-notice.ts --root /app --out /app/THIRD_PARTY_NOTICES.txt [--licenses <dir>]`
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

/** One installed libvips package, deduplicated by name and version. */
export interface LibvipsPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** Library name → version, from versions.json. */
  readonly bundled: Readonly<Record<string, string>>;
  /** Library name → licence terms, from the README's Licensing table. */
  readonly licensing: Readonly<Record<string, string>>;
  /** Absolute install directories. */
  readonly locations: readonly string[];
}

/** Licence texts the notice must carry: LGPL-3.0 incorporates the GPL-3.0 by reference. */
export interface LicenseTexts {
  readonly lgpl3: string;
  readonly gpl3: string;
}

const PACKAGE_GLOB = "**/node_modules/@img/sharp-libvips-*/package.json";

/**
 * Parses the `| Library | Used under the terms of |` table under the README's
 * "## Licensing" heading. Throws when the section or table is missing.
 */
export function parseLicensingTable(readme: string, packageName: string): Record<string, string> {
  const section = readme.split(/^## Licensing\s*$/m)[1];
  if (section === undefined)
    throw new Error(`${packageName}: README has no "## Licensing" section`);
  const rows: Record<string, string> = {};
  for (const line of section.split("\n")) {
    const cells = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (!cells || /^-+$/.test(cells[1]!) || cells[1] === "Library") continue;
    // `[text](url)` → `text (url)`: the notice is plain text.
    rows[cells[1]!] = cells[2]!.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  }
  if (Object.keys(rows).length === 0)
    throw new Error(`${packageName}: README Licensing table is empty`);
  return rows;
}

/**
 * Maps a README library name to its versions.json key (`libvips` → `vips`).
 * Throws for an LGPL library whose version is not recorded, since the notice
 * must state it.
 */
function bundledVersion(pkg: LibvipsPackage, library: string): string {
  const version = pkg.bundled[library] ?? pkg.bundled[library.replace(/^lib/, "")];
  if (version === undefined) {
    throw new Error(
      `${pkg.name}@${pkg.version}: versions.json has no entry for LGPL library "${library}"`,
    );
  }
  return version;
}

/** Finds and reads every `@img/sharp-libvips-*` package below `root`. */
export function findLibvipsPackages(root: string): LibvipsPackage[] {
  const byId = new Map<string, LibvipsPackage & { locations: string[] }>();
  const glob = new Bun.Glob(PACKAGE_GLOB);
  for (const manifestPath of glob.scanSync({ cwd: root, dot: true, absolute: true })) {
    const dir = dirname(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      version?: string;
      license?: string;
    };
    const { name, version, license } = manifest;
    if (!name || !version || !license)
      throw new Error(`${manifestPath}: missing name, version or license`);
    const id = `${name}@${version}`;
    const existing = byId.get(id);
    if (existing) {
      existing.locations.push(dir);
      continue;
    }
    byId.set(id, {
      name,
      version,
      license,
      bundled: JSON.parse(readFileSync(join(dir, "versions.json"), "utf8")) as Record<
        string,
        string
      >,
      licensing: parseLicensingTable(readFileSync(join(dir, "README.md"), "utf8"), id),
      locations: [dir],
    });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function describePackage(pkg: LibvipsPackage): string {
  const vips = pkg.bundled.vips;
  if (vips === undefined)
    throw new Error(`${pkg.name}@${pkg.version}: versions.json has no "vips" entry`);
  const lgpl = Object.entries(pkg.licensing).filter(([, terms]) => /LGPL/i.test(terms));
  if (lgpl.length === 0)
    throw new Error(`${pkg.name}@${pkg.version}: README lists no LGPL library`);
  const tag = `v${pkg.version}`;
  const width = Math.max(
    ...[...Object.keys(pkg.licensing), ...Object.keys(pkg.bundled)].map((l) => l.length),
  );
  return [
    `${pkg.name}@${pkg.version} (${pkg.license})`,
    `  libvips ${vips}, prebuilt by the sharp-libvips project for sharp.`,
    `  Installed at: ${pkg.locations.join(", ")}`,
    "",
    '  Libraries used under the GNU LGPL v3 (via the "any later version" clause',
    "  of LGPL-2.0/2.1 where upstream licenses them that way):",
    ...lgpl.map(([library]) => `    ${library.padEnd(width)}  ${bundledVersion(pkg, library)}`),
    "",
    "  Corresponding source: the sharp-libvips build scripts, which pin and fetch",
    "  the exact upstream source of every bundled library, are at",
    `    https://github.com/lovell/sharp-libvips/tree/${tag}`,
    `    https://github.com/lovell/sharp-libvips/releases/tag/${tag}`,
    "",
    "  Replacing the library: the shared object under <install location>/lib/",
    "  is loaded by sharp at runtime and can be replaced with a compatible,",
    "  modified build of libvips.",
    "",
    "  Licences of all bundled libraries (from the package README):",
    ...Object.entries(pkg.licensing).map(
      ([library, terms]) => `    ${library.padEnd(width)}  ${terms}`,
    ),
    "",
    "  Bundled library versions (from the package's versions.json):",
    ...Object.entries(pkg.bundled).map(
      ([library, version]) => `    ${library.padEnd(width)}  ${version}`,
    ),
  ].join("\n");
}

/** Renders the full notice: one block per package, then the LGPL-3.0 and GPL-3.0 texts. */
export function renderNotice(packages: readonly LibvipsPackage[], texts: LicenseTexts): string {
  if (packages.length === 0) {
    throw new Error(
      "No @img/sharp-libvips-* package found. If the image no longer ships sharp, remove the notice step from its Dockerfile.",
    );
  }
  const rule = "=".repeat(78);
  return [
    "THIRD-PARTY NOTICES",
    "",
    "Caelo CMS is licensed under the MPL-2.0. This image also redistributes the",
    "following prebuilt libvips packages, which sharp loads at runtime as separate",
    "shared libraries. They are not part of Caelo and keep their own licences.",
    "",
    ...packages.flatMap((pkg) => [describePackage(pkg), ""]),
    rule,
    "GNU LESSER GENERAL PUBLIC LICENSE, Version 3",
    rule,
    "",
    texts.lgpl3.trimEnd(),
    "",
    rule,
    "GNU GENERAL PUBLIC LICENSE, Version 3 (incorporated by reference by the LGPL-3.0)",
    rule,
    "",
    texts.gpl3.trimEnd(),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      out: { type: "string" },
      licenses: { type: "string", default: resolve(import.meta.dir, "..", "licenses") },
    },
  });
  if (!values.root || !values.out) {
    console.error(
      "usage: bun scripts/libvips-notice.ts --root <dir> --out <file> [--licenses <dir>]",
    );
    process.exit(2);
  }
  const notice = renderNotice(findLibvipsPackages(values.root), {
    lgpl3: readFileSync(join(values.licenses, "LGPL-3.0.txt"), "utf8"),
    gpl3: readFileSync(join(values.licenses, "GPL-3.0.txt"), "utf8"),
  });
  writeFileSync(values.out, notice);
  console.log(`libvips-notice: wrote ${values.out}`);
}

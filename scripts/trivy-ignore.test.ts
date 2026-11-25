// SPDX-License-Identifier: MPL-2.0

/**
 * Contract for `.trivyignore.yaml`, the exceptions to the Trivy gate of the
 * minimal service images (docs/dev/service-images.md, release-images.yml).
 *
 * The gate blocks every fixable high or critical finding. An exception exists
 * only for the gap between a fix upstream and a rebuilt digest-pinned base, so
 * each entry must stay narrow and short-lived:
 *   - one advisory id, and purls that name the exact vulnerable version, so a
 *     different (or newer, still vulnerable) package is not waved through;
 *   - a statement that says why the finding cannot be reached in our images;
 *   - an `expired_at` at most 14 days ahead. Trivy blocks again after that
 *     date, and this test fails on an expired entry, so it gets deleted.
 * The workflow must pass the file to both Trivy scans, or the entries would
 * silently stop applying to one of them.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const MAX_DAYS_AHEAD = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

interface IgnoreEntry {
  id?: unknown;
  purls?: unknown;
  paths?: unknown;
  statement?: unknown;
  expired_at?: unknown;
}

/** Problems of one entry, empty when it meets the contract on `today`. */
function entryProblems(entry: IgnoreEntry, today: Date): string[] {
  const problems: string[] = [];
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!/^(CVE-\d{4}-\d+|GHSA(-[0-9a-z]{4}){3})$/.test(id)) {
    problems.push(`id ${JSON.stringify(entry.id)} is not one CVE or GHSA id`);
  }
  if (entry.paths !== undefined) {
    problems.push(`${id}: use purls with a version, not paths`);
  }
  const purls = Array.isArray(entry.purls) ? entry.purls : [];
  if (purls.length === 0) problems.push(`${id}: no purls`);
  for (const purl of purls) {
    if (typeof purl !== "string" || !/^pkg:[a-z]+\/.+@[^@?#]+$/.test(purl)) {
      problems.push(`${id}: purl ${JSON.stringify(purl)} names no exact version`);
    }
  }
  const statement = typeof entry.statement === "string" ? entry.statement.trim() : "";
  if (statement.length < 40) problems.push(`${id}: the statement must say why it is unreachable`);
  const raw =
    entry.expired_at instanceof Date
      ? entry.expired_at.toISOString().slice(0, 10)
      : entry.expired_at;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    problems.push(`${id}: expired_at must be a YYYY-MM-DD date`);
    return problems;
  }
  const expires = Date.parse(`${raw}T00:00:00Z`);
  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (expires <= startOfToday) {
    problems.push(`${id}: expired on ${raw}; bump the base digest and delete the entry`);
  } else if (expires - startOfToday > MAX_DAYS_AHEAD * DAY_MS) {
    problems.push(`${id}: expired_at ${raw} is more than ${MAX_DAYS_AHEAD} days ahead`);
  }
  return problems;
}

function readEntries(): IgnoreEntry[] {
  const parsed = Bun.YAML.parse(readFileSync(join(ROOT, ".trivyignore.yaml"), "utf8")) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(parsed)) {
    if (key !== "vulnerabilities")
      throw new Error(`.trivyignore.yaml: only vulnerabilities may be ignored, found ${key}`);
  }
  const list = parsed.vulnerabilities ?? [];
  if (!Array.isArray(list)) throw new Error(".trivyignore.yaml: vulnerabilities must be a list");
  return list as IgnoreEntry[];
}

describe(".trivyignore.yaml", () => {
  it("every entry is version-pinned, reasoned and expires within 14 days", () => {
    const problems = readEntries().flatMap((entry) => entryProblems(entry, new Date()));
    expect(problems).toEqual([]);
  });

  it("both Trivy scans of the service images read it", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/release-images.yml"), "utf8");
    expect(workflow).toContain('-v "${GITHUB_WORKSPACE}/.trivyignore.yaml:/trivyignore.yaml:ro"');
    const scans = workflow.split("\n").filter((line) => /^\s*trivy (image|sbom) /.test(line));
    expect(scans.length).toBe(2);
    for (const scan of scans) expect(scan).toContain("--ignorefile /trivyignore.yaml");
  });
});

describe("entryProblems", () => {
  const today = new Date("2026-11-25T12:00:00Z");
  const valid: IgnoreEntry = {
    id: "CVE-2026-124851",
    purls: ["pkg:deb/debian/libzstd1@1.5.7%2Bdfsg-1"],
    statement: "Not reachable: the image runs only bun, which never loads the library.",
    expired_at: "2026-12-02",
  };

  it("accepts a narrow, reasoned, short-lived entry", () => {
    expect(entryProblems(valid, today)).toEqual([]);
  });

  it("refuses a purl without a version and a paths entry", () => {
    expect(entryProblems({ ...valid, purls: ["pkg:deb/debian/libzstd1"] }, today).join()).toContain(
      "no exact version",
    );
    expect(entryProblems({ ...valid, paths: ["usr/lib"] }, today).join()).toContain("not paths");
  });

  it("refuses a missing reason and a malformed id", () => {
    expect(entryProblems({ ...valid, statement: "temp" }, today).join()).toContain("unreachable");
    expect(entryProblems({ ...valid, id: "CVE-*" }, today).join()).toContain("not one CVE");
  });

  it("fails an expired entry and one that expires too far ahead", () => {
    expect(entryProblems({ ...valid, expired_at: "2026-11-25" }, today).join()).toContain(
      "expired on",
    );
    expect(entryProblems({ ...valid, expired_at: "2026-12-10" }, today).join()).toContain(
      "more than 14 days",
    );
    expect(entryProblems({ ...valid, expired_at: undefined }, today).join()).toContain(
      "YYYY-MM-DD",
    );
  });
});

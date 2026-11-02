// SPDX-License-Identifier: MPL-2.0

/**
 * Repo-wide GitHub Actions pinning contract (issue #104).
 *
 * A tag such as `@v7` is mutable: whoever controls the action's repository can
 * re-point it at any commit, and every workflow runs that commit on its next
 * run. That is exactly how the `aquasecurity/trivy-action` tags were hijacked
 * in March 2026 (and `tj-actions/changed-files` in March 2025). A full commit
 * SHA cannot be re-pointed, so every `uses:` in `.github/workflows/` and
 * `.github/actions/` — GitHub's own `actions/*` and `github/*` included — names
 * one, with a trailing `# vX.Y.Z` comment. Dependabot's `github-actions`
 * ecosystem reads that comment and bumps SHA and comment together
 * (`.github/dependabot.yml`).
 *
 * Accepted shapes, nothing else:
 *   uses: owner/repo[/path]@<40-hex sha> # vX.Y.Z
 *   uses: owner/repo@<40-hex sha> # main (pinned YYYY-MM-DD)   (TAGLESS only)
 *   uses: ./local/path                                         (repo-local)
 *   uses: docker://image@sha256:<64-hex>                       (digest only)
 *
 * Two readers, cross-checked. The line reader sees the trailing comment (a YAML
 * parser drops comments) and reads plain, "double"- and 'single'-quoted
 * scalars. Bun's built-in YAML parser (`Bun.YAML`, no dependency) finds every
 * `uses` node however it is written, flow mappings included. Every file must
 * yield the same refs from both, so a form the line reader misses fails the
 * test instead of slipping past it.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GITHUB_DIR = join(REPO_ROOT, ".github");

/**
 * Actions that publish no tags, so there is no version for the comment to
 * name. Each entry says why it is used anyway; the pin carries the date it was
 * taken from the default branch instead of a version.
 */
const TAGLESS: Record<string, string> = {
  // The AI security review (#24). Upstream has never cut a release.
  "anthropics/claude-code-security-review": "no releases upstream",
};

/**
 * Actions the repo must never use, at any ref: their release tags were
 * hijacked and pointed at credential-stealing commits. A SHA pin taken from a
 * hijacked tag would pin the malicious commit, so the action is refused
 * outright rather than trusted to have been pinned before the incident.
 */
const FORBIDDEN: Record<string, string> = {
  "aquasecurity/trivy-action": "tags hijacked March 2026",
  "aquasecurity/setup-trivy": "tags hijacked March 2026",
  "tj-actions/changed-files": "tags hijacked March 2025",
};

/** Every workflow file and composite-action manifest under `.github/`. */
function actionFiles(): string[] {
  const files: string[] = [];
  const workflows = join(GITHUB_DIR, "workflows");
  for (const f of readdirSync(workflows)) {
    if (/\.ya?ml$/.test(f)) files.push(join(workflows, f));
  }
  const actions = join(GITHUB_DIR, "actions");
  for (const dir of readdirSync(actions)) {
    if (!statSync(join(actions, dir)).isDirectory()) continue;
    for (const f of readdirSync(join(actions, dir))) {
      if (/^action\.ya?ml$/.test(f)) files.push(join(actions, dir, f));
    }
  }
  return files;
}

/** One `uses:` occurrence in YAML key position, with the rest of its line. */
type UsesRef = { file: string; line: number; ref: string; comment: string };

/** A `uses:` line: optional `- `, optionally quoted key, plain or quoted value, comment. */
const USES_LINE =
  /^\s*(?:-\s+)?(["']?)uses\1:\s*(?:"([^"]*)"|'([^']*)'|([^\s#"']+))\s*(?:#\s*(.*))?$/;

/**
 * Every `uses:` in YAML block position (step `- uses:` and job-level `uses:`),
 * with its trailing comment. Comment lines never match, so prose that mentions
 * `uses:` is not mistaken for a reference.
 */
function extractUses(body: string, file: string): UsesRef[] {
  const out: UsesRef[] = [];
  body.split("\n").forEach((text, i) => {
    const m = USES_LINE.exec(text);
    if (!m) return;
    const ref = m[2] ?? m[3] ?? m[4] ?? "";
    out.push({ file, line: i + 1, ref, comment: (m[5] ?? "").trim() });
  });
  return out;
}

/** Every string value of a `uses` key anywhere in the parsed YAML document. */
function yamlUses(body: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "uses" && typeof value === "string") out.push(value);
        else walk(value);
      }
    }
  };
  walk(Bun.YAML.parse(body));
  return out;
}

/** `owner/repo` of an action ref (drops a sub-path and the `@ref`). */
function actionRepo(ref: string): string {
  const [path] = ref.split("@");
  return (path ?? "").split("/").slice(0, 2).join("/");
}

/**
 * Why `u` violates the pinning contract, or `null` when it is pinned
 * correctly. Kept pure so the rule can be unit-tested on
 * synthetic lines as well as on the real tree.
 */
function pinViolation(u: UsesRef): string | null {
  if (u.ref.startsWith("./")) return null;
  if (u.ref.startsWith("docker://")) {
    return /@sha256:[0-9a-f]{64}$/.test(u.ref) ? null : "docker image is not pinned by digest";
  }
  const repo = actionRepo(u.ref);
  if (FORBIDDEN[repo]) return `${repo} is forbidden (${FORBIDDEN[repo]})`;
  if (!/^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/.test(u.ref)) {
    return "not pinned to a full 40-character commit SHA";
  }
  if (TAGLESS[repo]) {
    return /^main \(pinned \d{4}-\d{2}-\d{2}\)$/.test(u.comment)
      ? null
      : "tag-less action needs a trailing `# main (pinned YYYY-MM-DD)` comment";
  }
  return /^v\d+\.\d+\.\d+$/.test(u.comment)
    ? null
    : "needs a trailing `# vX.Y.Z` comment naming the exact release tag";
}

const FILES = actionFiles().map((f) => ({
  name: relative(REPO_ROOT, f),
  body: readFileSync(f, "utf8"),
}));
const ALL_USES = FILES.flatMap((f) => extractUses(f.body, f.name));

describe("GitHub Actions pinning (issue #104)", () => {
  it("finds the repo's action references (guards a silent zero-match)", () => {
    expect(ALL_USES.length).toBeGreaterThanOrEqual(100);
    expect(ALL_USES.some((u) => u.file.startsWith(".github/actions/"))).toBe(true);
  });

  it("the line reader finds exactly the uses nodes the YAML parser finds, per file", () => {
    const mismatches = FILES.flatMap((f) => {
      const byLine = extractUses(f.body, f.name)
        .map((u) => u.ref)
        .sort();
      const byYaml = yamlUses(f.body).sort();
      return JSON.stringify(byLine) === JSON.stringify(byYaml)
        ? []
        : [`${f.name}: line reader ${JSON.stringify(byLine)} vs YAML ${JSON.stringify(byYaml)}`];
    });
    expect(mismatches).toEqual([]);
  });

  it("every uses: is pinned to a commit SHA with an exact version comment", () => {
    const bad = ALL_USES.flatMap((u) => {
      const why = pinViolation(u);
      return why ? [`${u.file}:${u.line} ${u.ref} — ${why}`] : [];
    });
    expect(bad).toEqual([]);
  });

  it("one action at one version always resolves to one SHA", () => {
    // Two different SHAs under the same `# vX.Y.Z` mean one of them was not
    // resolved from the tag (or a tag moved between pins) — both are worth a
    // look, never a silent mix.
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const u of ALL_USES) {
      if (u.ref.startsWith("./") || u.ref.startsWith("docker://")) continue;
      const [path, sha] = u.ref.split("@");
      const key = `${actionRepo(path ?? "")} ${u.comment}`;
      const prev = seen.get(key);
      if (prev && prev !== sha) conflicts.push(`${key}: ${prev} vs ${sha} (${u.file}:${u.line})`);
      seen.set(key, sha ?? "");
    }
    expect(conflicts).toEqual([]);
  });

  it("the TAGLESS and FORBIDDEN lists carry a reason per entry", () => {
    for (const reason of [...Object.values(TAGLESS), ...Object.values(FORBIDDEN)]) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

describe("pinViolation rule", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const at = (ref: string, comment = "") => ({ file: "x.yml", line: 1, ref, comment });

  it("accepts a SHA with an exact version comment", () => {
    expect(pinViolation(at(`actions/checkout@${sha}`, "v7.0.1"))).toBeNull();
    expect(pinViolation(at(`github/codeql-action/init@${sha}`, "v4.31.2"))).toBeNull();
  });

  it("rejects floating tags and branches, first-party included", () => {
    expect(pinViolation(at("actions/checkout@v7"))).not.toBeNull();
    expect(pinViolation(at("github/codeql-action/init@v4"))).not.toBeNull();
    expect(pinViolation(at("oven-sh/setup-bun@main"))).not.toBeNull();
    expect(pinViolation(at(`actions/checkout@${sha.slice(0, 12)}`, "v7.0.1"))).not.toBeNull();
  });

  it("rejects a SHA whose comment names only a major tag", () => {
    expect(pinViolation(at(`oven-sh/setup-bun@${sha}`, "v2"))).not.toBeNull();
    expect(pinViolation(at(`oven-sh/setup-bun@${sha}`))).not.toBeNull();
  });

  it("refuses hijacked actions even when SHA-pinned", () => {
    expect(pinViolation(at(`aquasecurity/trivy-action@${sha}`, "v0.33.1"))).toMatch(/forbidden/);
  });

  it("accepts repo-local refs and digest-pinned docker images only", () => {
    expect(pinViolation(at("./.github/workflows/release-images.yml"))).toBeNull();
    expect(pinViolation(at(`docker://alpine@sha256:${"a".repeat(64)}`))).toBeNull();
    expect(pinViolation(at("docker://alpine:3.22"))).not.toBeNull();
  });

  it("extractUses reads double- and single-quoted refs and quoted keys", () => {
    const body = [
      '      - uses: "evil/action@main"',
      `      - uses: 'actions/checkout@${sha}' # v7.0.1`,
      `      - "uses": "actions/checkout@${sha}" # v7.0.1`,
    ].join("\n");
    const refs = extractUses(body, "x.yml");
    expect(refs.map((u) => [u.ref, u.comment])).toEqual([
      ["evil/action@main", ""],
      [`actions/checkout@${sha}`, "v7.0.1"],
      [`actions/checkout@${sha}`, "v7.0.1"],
    ]);
    expect(pinViolation(refs[0]!)).not.toBeNull();
  });

  it("the YAML cross-check catches a uses the line reader cannot see", () => {
    const body = "jobs:\n  a:\n    steps:\n      - { uses: evil/action@main }\n";
    expect(extractUses(body, "x.yml")).toEqual([]);
    expect(yamlUses(body)).toEqual(["evil/action@main"]);
  });

  it("extractUses ignores comment lines and reads the trailing comment", () => {
    const body = [
      "# uses: actions/checkout@v7 in prose",
      `      - uses: actions/checkout@${sha} # v7.0.1`,
      "    uses: ./.github/workflows/x.yml",
    ].join("\n");
    expect(extractUses(body, "x.yml").map((u) => [u.ref, u.comment])).toEqual([
      [`actions/checkout@${sha}`, "v7.0.1"],
      ["./.github/workflows/x.yml", ""],
    ]);
  });
});

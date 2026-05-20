#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * Apply repository rulesets from `.github/rulesets/*.json` to the live GitHub
 * repo. Idempotent: looks up an existing ruleset by name and PATCHes it if
 * present, POSTs a new one otherwise. This is the source-of-truth for branch
 * protection on `main` — editing the ruleset in the GitHub UI bypasses review;
 * editing the JSON in a PR is the supported path.
 *
 *   bun run rulesets:apply              # write changes to the live repo
 *   bun run rulesets:apply --dry-run    # show the diff, don't call PATCH/POST
 *   bun run rulesets:check              # exit 1 if live state drifts from JSON
 *
 * Auth: reuses the `gh` CLI's token (`gh auth token`). Requires the `repo`
 * scope. Owner + repo are read from the `origin` remote unless overridden via
 * `--owner` / `--repo`.
 *
 * Tracked under issue #23 (protect `main` branch). When new CI gates land
 * (#12 knip, #13 madge, #14 coverage, #26 CodeQL, etc.), add their job names
 * to the required_status_checks list in the JSON spec and run this script.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const RULESETS_DIR = resolve(REPO_ROOT, ".github/rulesets");

const FLAGS = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const DRY_RUN = FLAGS.has("--dry-run");
const CHECK = FLAGS.has("--check");

function flagValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

/** Spec keys starting with `_` or `$` are documentation-only — strip before PUT. */
function stripMeta<T>(input: T): T {
  if (Array.isArray(input)) return input.map(stripMeta) as unknown as T;
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (k.startsWith("_") || k.startsWith("$")) continue;
      out[k] = stripMeta(v);
    }
    return out as unknown as T;
  }
  return input;
}

async function ghToken(): Promise<string> {
  const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    throw new Error("`gh auth token` failed — run `gh auth login` first.");
  }
  return out.trim();
}

function originSlug(): { owner: string; repo: string } {
  const owner = flagValue("owner");
  const repo = flagValue("repo");
  if (owner && repo) return { owner, repo };

  const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
  });
  const url = new TextDecoder().decode(proc.stdout).trim();
  // Match git@github.com:owner/repo(.git)? and https://github.com/owner/repo(.git)?
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
  if (!m) throw new Error(`Cannot parse owner/repo from origin URL: ${url}`);
  return { owner: m[1]!, repo: m[2]! };
}

type Ruleset = { id: number; name: string };

async function api<T>(
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${method} ${path} → ${res.status}\n${text}`);
  }
  return (await res.json()) as T;
}

/**
 * Normalise a ruleset payload for comparison: drop server-managed fields,
 * sort keys, etc. Used by --check to detect drift.
 */
function normaliseForCompare(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(normaliseForCompare);
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(input as Record<string, unknown>).sort();
    const drop = new Set([
      "id",
      "source",
      "source_type",
      "node_id",
      "created_at",
      "updated_at",
      "_links",
      "current_user_can_bypass",
      "links_self",
    ]);
    for (const k of keys) {
      if (drop.has(k)) continue;
      out[k] = normaliseForCompare((input as Record<string, unknown>)[k]);
    }
    return out;
  }
  return input;
}

function loadSpecs(): { file: string; spec: Record<string, unknown> }[] {
  const files = readdirSync(RULESETS_DIR).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const raw = readFileSync(resolve(RULESETS_DIR, file), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { file, spec: stripMeta(parsed) };
  });
}

async function main(): Promise<void> {
  const { owner, repo } = originSlug();
  const token = await ghToken();
  const specs = loadSpecs();
  if (specs.length === 0) {
    console.log("No rulesets found in .github/rulesets/; nothing to do.");
    return;
  }

  const live = await api<Ruleset[]>(token, "GET", `/repos/${owner}/${repo}/rulesets`);
  let driftFound = false;

  for (const { file, spec } of specs) {
    const name = spec.name as string;
    if (!name) throw new Error(`${file}: ruleset is missing a top-level "name"`);
    const existing = live.find((r) => r.name === name);

    if (CHECK) {
      if (!existing) {
        console.error(`drift: ${name} (from ${file}) is not present on ${owner}/${repo}`);
        driftFound = true;
        continue;
      }
      const liveFull = await api<Record<string, unknown>>(
        token,
        "GET",
        `/repos/${owner}/${repo}/rulesets/${existing.id}`,
      );
      const a = JSON.stringify(normaliseForCompare(spec));
      const b = JSON.stringify(normaliseForCompare(liveFull));
      if (a !== b) {
        console.error(`drift: ${name} differs between ${file} and live state`);
        driftFound = true;
      } else {
        console.log(`ok:    ${name} matches ${file}`);
      }
      continue;
    }

    if (DRY_RUN) {
      console.log(`[dry-run] would ${existing ? "update" : "create"} ${name} from ${file}`);
      continue;
    }

    if (existing) {
      await api(token, "PUT", `/repos/${owner}/${repo}/rulesets/${existing.id}`, spec);
      console.log(`updated: ${name} (id=${existing.id}) from ${file}`);
    } else {
      const created = await api<Ruleset>(token, "POST", `/repos/${owner}/${repo}/rulesets`, spec);
      console.log(`created: ${name} (id=${created.id}) from ${file}`);
    }
  }

  if (CHECK && driftFound) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * Build and verify the signed release manifest (epic #696). Driven by
 * `release.yml`; see RELEASING.md ("Release manifest").
 *
 *   bun scripts/release-manifest.ts generate --version 0.11.0 \
 *     --digest admin=sha256:… --digest gateway=sha256:… --digest ops=sha256:… \
 *     --out release-manifest.json
 *       Re-runs the release-cut checks against `release-meta.json` and
 *       writes the manifest. Signing happens in the workflow (cosign).
 *
 *   bun scripts/release-manifest.ts verify --version 0.11.0 \
 *     [--registry <host> --repository <path>] [--digest admin=sha256:… …]
 *       Fetches the pushed manifest through the same library the upgrader
 *       uses, verifies the signature for the exact tag identity, and
 *       compares digests. The release's end-to-end self-test.
 */

import { readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INFRA_CONTRACT_VERSION,
  RELEASE_MIN_FROM_VERSION,
} from "../packages/provisioning/src/release-contract.ts";
import {
  channelForVersion,
  compareImageDigests,
  fetchVerifiedReleaseManifest,
  RELEASE_IMAGES,
  type ReleaseImage,
  type ReleaseManifest,
  ReleaseManifestSchema,
} from "../packages/provisioning/src/release-manifest.ts";
import { MIGRATIONS_DIR, migrationHead } from "./migration-lint.ts";
import { type ReleaseMeta, readReleaseMeta, runReleaseChecks } from "./release-checks.ts";

/**
 * Assemble the manifest from the checked declaration + build facts.
 *
 * @throws Error when the version names no known channel or the result
 *   fails the schema (both are pipeline bugs, not operator input).
 */
export function buildReleaseManifest(input: {
  meta: ReleaseMeta;
  digests: Record<ReleaseImage, string>;
  contractMigrations: boolean;
  migrationHead: string;
}): ReleaseManifest {
  const channel = channelForVersion(input.meta.version);
  if (!channel) {
    throw new Error(
      `version ${input.meta.version} names no release channel (stable, rc, beta, alpha)`,
    );
  }
  return ReleaseManifestSchema.parse({
    manifestVersion: 1,
    version: input.meta.version,
    channel,
    digests: input.digests,
    minFromVersion: RELEASE_MIN_FROM_VERSION,
    infraContractVersion: INFRA_CONTRACT_VERSION,
    migrations: {
      contract: input.contractMigrations,
      head: input.migrationHead,
      lastContractVersion: input.meta.lastContractVersion,
    },
    security: input.meta.security,
    advisories: input.meta.advisories,
  });
}

/** Parse repeated `--digest image=sha256:…` flags. */
export function parseDigestFlags(argv: readonly string[]): Partial<Record<ReleaseImage, string>> {
  const out: Partial<Record<ReleaseImage, string>> = {};
  argv.forEach((a, i) => {
    if (a !== "--digest") return;
    const [image, digest] = (argv[i + 1] ?? "").split("=");
    if (!image || !digest || !(RELEASE_IMAGES as readonly string[]).includes(image)) {
      throw new Error(
        `bad --digest "${argv[i + 1] ?? ""}" — expected <admin|gateway|ops>=sha256:…`,
      );
    }
    out[image as ReleaseImage] = digest;
  });
  return out;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function generate(argv: readonly string[], repoRoot: string): Promise<void> {
  const version = flag(argv, "version");
  const outPath = flag(argv, "out") ?? "release-manifest.json";
  if (!version) throw new Error("--version is required");
  const meta = readReleaseMeta(repoRoot);
  if (meta.version !== version) {
    throw new Error(
      `release-meta.json declares v${meta.version} but this is v${version} — the release commit must come from scripts/release.ts.`,
    );
  }
  const digests = parseDigestFlags(argv);
  const missing = RELEASE_IMAGES.filter((i) => !digests[i]);
  if (missing.length > 0) throw new Error(`missing --digest for: ${missing.join(", ")}`);

  const checks = await runReleaseChecks(meta, {
    repoRoot,
    repo: process.env.GITHUB_REPOSITORY ?? "caelo-cms/caelo-cms",
    token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  });
  const errors = [...checks.errors];
  if (meta.lastContractVersion !== checks.lastContractVersion) {
    errors.push(
      `release-meta.json declares lastContractVersion ${meta.lastContractVersion ?? "null"}, the release history says ${checks.lastContractVersion ?? "null"} — the release commit must come from scripts/release.ts.`,
    );
  }
  for (const w of checks.warnings) console.log(`::warning::${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::${e.replace(/\n/g, "%0A")}`);
    process.exit(1);
  }
  const manifest = buildReleaseManifest({
    meta,
    digests: digests as Record<ReleaseImage, string>,
    contractMigrations: checks.contractMigrations,
    migrationHead: migrationHead(readdirSync(resolve(repoRoot, MIGRATIONS_DIR, "cms_admin"))),
  });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}

async function verify(argv: readonly string[]): Promise<void> {
  const version = flag(argv, "version");
  if (!version) throw new Error("--version is required");
  const registry = flag(argv, "registry");
  const repository = flag(argv, "repository");
  const r = await fetchVerifiedReleaseManifest(version, {
    fetch: (url, init) => fetch(url, init),
    cosign: async (args) => {
      const proc = Bun.spawn(["cosign", ...args], { stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      return { exitCode: await proc.exited, stderr };
    },
    ...(registry ? { registry } : {}),
    ...(repository ? { repository } : {}),
  });
  if (!r.ok) {
    console.error(`::error::[${r.error.code}] ${r.error.message}`);
    process.exit(1);
  }
  const mismatches = compareImageDigests(r.manifest, parseDigestFlags(argv));
  if (mismatches.length > 0) {
    for (const m of mismatches) {
      console.error(
        `::error::${m.image}: manifest ${m.expected}, registry ${m.actual ?? "(none)"}`,
      );
    }
    process.exit(1);
  }
  console.log(`release manifest v${version} verified (signature, schema, digests)`);
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..");
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "generate") await generate(rest, repoRoot);
    else if (cmd === "verify") await verify(rest);
    else {
      console.error("usage: bun scripts/release-manifest.ts <generate|verify> --version X …");
      process.exit(2);
    }
  } catch (e) {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

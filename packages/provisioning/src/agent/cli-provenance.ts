// SPDX-License-Identifier: MPL-2.0

/**
 * The target release's provisioning CLI, installed and VERIFIED before the
 * update agent runs it (#696 Phase 4c, maintainer decision on #721). The
 * signed release manifest proves a release exists and is installable; this
 * proves the code that installs it is that release's: the same checks the
 * Cloud Shell runner (`run.sh` in caelo-cms/install) makes.
 *
 *   1. `npm install` of exactly `@caelo-cms/provisioning@<v>` (with
 *      `@caelo-cms/shared` pinned to the same version, lifecycle scripts
 *      off) into a private folder under `.caelo/agent/cli/`;
 *   2. `npm audit signatures` — the registry signatures and Sigstore
 *      provenance attestations of every installed package;
 *   3. both Caelo packages are the asked-for version, and their SLSA
 *      provenance names caelo-cms/caelo-cms at `refs/tags/v<v>`.
 *
 * Any failure is a structured {@link CliProvenanceError}; there is no
 * fallback to an unverified `bunx` run.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostRunner } from "../self-hosted-release.js";

/** Where Caelo's packages are built (the provenance's workflow repository). */
export const SOURCE_REPOSITORY = "https://github.com/caelo-cms/caelo-cms";

/** The Caelo packages the CLI runs; both must carry the release's provenance. */
export const CAELO_CLI_PACKAGES = ["@caelo-cms/provisioning", "@caelo-cms/shared"] as const;

/** Why the CLI of a release was not trusted. */
export interface CliProvenanceError {
  readonly code: "npm-missing" | "npm-install" | "audit-signatures" | "version" | "provenance";
  readonly message: string;
}

export type VerifiedCli =
  | { readonly ok: true; readonly cliPath: string; readonly dir: string }
  | { readonly ok: false; readonly error: CliProvenanceError };

/** `.caelo/agent/cli/` — the verified CLI installs, one folder per release. */
export function verifiedCliRoot(caeloDir: string): string {
  return join(caeloDir, "agent", "cli");
}

/** The folder of release `version`'s verified CLI. */
export function verifiedCliDir(caeloDir: string, version: string): string {
  return join(verifiedCliRoot(caeloDir), `caelo-${version}`);
}

/** The CLI entry point inside {@link verifiedCliDir}. */
export function verifiedCliPath(dir: string): string {
  return join(dir, "node_modules", "@caelo-cms", "provisioning", "dist", "cli.js");
}

const fail = (code: CliProvenanceError["code"], message: string): VerifiedCli => ({
  ok: false,
  error: { code, message },
});

const tail = (s: string) => s.trim().split("\n").slice(-6).join("\n").slice(0, 800);

/**
 * Check one package's npm provenance attestation: SLSA v1, built from
 * {@link SOURCE_REPOSITORY} at `refs/tags/v<version>`, for this exact
 * package version.
 *
 * @returns null when it checks out, else why not
 */
export async function provenanceProblem(
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const url = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`;
  let body: { attestations?: { predicateType?: string; bundle?: unknown }[] };
  try {
    const res = await fetchImpl(url);
    if (!res.ok)
      return `${name}@${version}: no provenance attestation (${url}: HTTP ${res.status})`;
    body = (await res.json()) as typeof body;
  } catch (e) {
    return `${name}@${version}: the attestations could not be fetched (${e instanceof Error ? e.message : String(e)})`;
  }
  const slsa = body.attestations?.find((a) => a.predicateType === "https://slsa.dev/provenance/v1");
  const payload = (slsa?.bundle as { dsseEnvelope?: { payload?: string } } | undefined)
    ?.dsseEnvelope?.payload;
  if (!payload) return `${name}@${version}: no SLSA provenance`;
  let statement: {
    subject?: { name?: string }[];
    predicate?: {
      buildDefinition?: {
        externalParameters?: { workflow?: { repository?: string; ref?: string } };
      };
    };
  };
  try {
    statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return `${name}@${version}: the provenance statement is not JSON`;
  }
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  const subjects = (statement.subject ?? []).map((s) => s.name);
  const wantSubject = `pkg:npm/${name.replace("@", "%40")}@${version}`;
  if (
    workflow.repository !== SOURCE_REPOSITORY ||
    workflow.ref !== `refs/tags/v${version}` ||
    !subjects.includes(wantSubject)
  ) {
    return `${name}@${version} was not built by ${SOURCE_REPOSITORY} at refs/tags/v${version} (provenance: ${workflow.repository ?? "?"} ${workflow.ref ?? "?"}, ${subjects.join(",")})`;
  }
  return null;
}

/**
 * Install release `version`'s CLI into `dir` (replacing what is there) and
 * verify it. Nothing in it runs before the checks passed: npm's lifecycle
 * scripts are off.
 */
export async function installVerifiedCli(
  version: string,
  dir: string,
  deps: { readonly runner: HostRunner; readonly fetchImpl?: typeof fetch },
): Promise<VerifiedCli> {
  const probe = await deps.runner.run(["npm", "--version"]);
  if (probe.exitCode !== 0) {
    return fail(
      "npm-missing",
      "npm is not installed on the server (or not on the agent's PATH); the update agent needs it to verify the provenance of the Caelo release it installs. Install Node.js + npm, then run `agent install` again.",
    );
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Exact versions for both Caelo packages: provisioning depends on
  // ^<version> of shared, which could otherwise resolve to a newer one.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "caelo-agent-cli",
        private: true,
        dependencies: { "@caelo-cms/provisioning": version },
        overrides: { "@caelo-cms/shared": version },
      },
      null,
      2,
    ),
  );
  const install = await deps.runner.run([
    "npm",
    "install",
    "--prefix",
    dir,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ]);
  if (install.exitCode !== 0) {
    return fail(
      "npm-install",
      `npm could not install @caelo-cms/provisioning@${version}: ${tail(install.stderr || install.stdout)}`,
    );
  }
  const audit = await deps.runner.run(["npm", "audit", "signatures", "--prefix", dir]);
  if (audit.exitCode !== 0) {
    return fail(
      "audit-signatures",
      `npm audit signatures rejected the packages of Caelo ${version}: ${tail(audit.stderr || audit.stdout)}`,
    );
  }
  for (const name of CAELO_CLI_PACKAGES) {
    let installed: string | undefined;
    try {
      installed = (
        JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8")) as {
          version?: string;
        }
      ).version;
    } catch {
      installed = undefined;
    }
    if (installed !== version) {
      return fail("version", `${name}: installed ${installed ?? "nothing"}, expected ${version}`);
    }
    const problem = await provenanceProblem(name, version, deps.fetchImpl);
    if (problem) return fail("provenance", problem);
  }
  return { ok: true, cliPath: verifiedCliPath(dir), dir };
}

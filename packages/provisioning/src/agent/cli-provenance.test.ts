// SPDX-License-Identifier: MPL-2.0

/**
 * The target release's CLI is installed and verified before the agent runs
 * it (#721 maintainer decision): npm signatures + Sigstore provenance from
 * caelo-cms/caelo-cms at the release tag. Every reject path is a structured
 * error; nothing falls back to an unverified run.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, HostRunner } from "../self-hosted-release.js";
import { installVerifiedCli, provenanceProblem, SOURCE_REPOSITORY } from "./cli-provenance.js";

const V = "0.11.0";

/** An npm attestations response whose SLSA statement says `workflow` built `name@version`. */
function attestation(
  name: string,
  version: string,
  workflow: { repository: string; ref: string },
): Response {
  const statement = {
    subject: [{ name: `pkg:npm/${name.replaceAll("@", "%40")}@${version}` }],
    predicate: { buildDefinition: { externalParameters: { workflow } } },
  };
  return Response.json({
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") },
        },
      },
    ],
  });
}

const genuine = (async (url: string | URL | Request) => {
  const m = /attestations\/(.+)@([^@]+)$/.exec(decodeURIComponent(String(url)));
  return attestation(m?.[1] ?? "", m?.[2] ?? "", {
    repository: SOURCE_REPOSITORY,
    ref: `refs/tags/v${m?.[2]}`,
  });
}) as typeof fetch;

type Rule = (line: string) => Partial<CommandResult> | undefined;

/** npm fake: `install` writes the packages at `installed` versions. */
function npm(dir: string, rules: Rule[] = [], installed = V): HostRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(argv) {
      const line = argv.join(" ");
      calls.push(line);
      const hit = rules.map((r) => r(line)).find((r) => r !== undefined);
      if (hit) return { exitCode: 0, stdout: "", stderr: "", ...hit };
      if (argv[1] === "install") {
        for (const name of ["@caelo-cms/provisioning", "@caelo-cms/shared"]) {
          const pkg = join(dir, "node_modules", name);
          mkdirSync(pkg, { recursive: true });
          writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version: installed }));
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

describe("installVerifiedCli", () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "caelo-cli-"));
    dir = join(root, `caelo-${V}`);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("installs exactly the release with scripts off, audits it, and returns its CLI", async () => {
    const runner = npm(dir);
    const r = await installVerifiedCli(V, dir, { runner, fetchImpl: genuine });
    expect(r).toEqual({
      ok: true,
      dir,
      cliPath: join(dir, "node_modules", "@caelo-cms", "provisioning", "dist", "cli.js"),
    });
    expect(runner.calls).toEqual([
      "npm --version",
      `npm install --prefix ${dir} --ignore-scripts --no-audit --no-fund --loglevel=error`,
      `npm audit signatures --prefix ${dir}`,
    ]);
  });

  it.each([
    [
      "no npm",
      [(l: string) => (l === "npm --version" ? { exitCode: 127 } : undefined)],
      genuine,
      V,
      "npm-missing",
    ],
    [
      "registry signatures rejected",
      [
        (l: string) =>
          l.startsWith("npm audit") ? { exitCode: 1, stderr: "1 invalid signature" } : undefined,
      ],
      genuine,
      V,
      "audit-signatures",
    ],
    ["another version installed", [], genuine, "0.11.1", "version"],
    [
      "built from a fork",
      [],
      (async () =>
        attestation("@caelo-cms/provisioning", V, {
          repository: "https://github.com/evil/caelo-cms",
          ref: `refs/tags/v${V}`,
        })) as unknown as typeof fetch,
      V,
      "provenance",
    ],
    [
      "built from a branch, not the release tag",
      [],
      (async () =>
        attestation("@caelo-cms/provisioning", V, {
          repository: SOURCE_REPOSITORY,
          ref: "refs/heads/main",
        })) as unknown as typeof fetch,
      V,
      "provenance",
    ],
    [
      "no attestation at all",
      [],
      (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
      V,
      "provenance",
    ],
  ] as const)("rejects: %s", async (_name, rules, fetchImpl, installed, code) => {
    const r = await installVerifiedCli(V, dir, {
      runner: npm(dir, [...rules], installed),
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(code);
  });
});

describe("provenanceProblem", () => {
  it("accepts the release workflow's build of that exact version", async () => {
    expect(await provenanceProblem("@caelo-cms/shared", V, genuine)).toBeNull();
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * #883 review — the converge job runs as caelo-provisioner, so an
 * execution override must be useless even if someone held
 * run.jobs.runWithOverrides:
 *
 *   - the job's entry point (ops/caelo-converge-job) refuses every argument
 *     but `converge-job` before any code runs;
 *   - it starts the job with an empty environment plus a fixed allowlist,
 *     so CLOUDSDK_*, PULUMI_*, BUN_*, LD_* overrides never reach gcloud,
 *     Pulumi or Bun;
 *   - and nobody is granted a role that carries runWithOverrides: not the
 *     upgrader (anywhere), not the admin (on the converge or upgrader job).
 *
 * The script runs here under /bin/sh with its final `bun …` target swapped
 * for `env`, so the test sees exactly the environment the job would get.
 */

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONVERGE_ADMIN_ROLES, convergeJobDeployArgs } from "./converge-job-setup.js";
import type { GcloudResult } from "./gcloud.js";
import {
  ensureUpgraderJob,
  RUN_WITH_OVERRIDES_ROLES,
  UPGRADER_FORBIDDEN_ROLES,
  UPGRADER_PROJECT_ROLES,
  UPGRADER_RUN_ROLE,
} from "./upgrader-setup.js";

const SCRIPT = resolve(import.meta.dir, "..", "ops", "caelo-converge-job");
const TARGET_LINE = "bun /opt/caelo-ops/packages/platform-updater/src/converge-main.ts";

/** The entry point with its final target replaced by `env` (prints the environment). */
function scriptPrintingEnv(dir: string): string {
  const text = readFileSync(SCRIPT, "utf8");
  expect(text.split(TARGET_LINE).length).toBe(2);
  const path = join(dir, "caelo-converge-job");
  writeFileSync(path, text.replace(TARGET_LINE, "env"));
  chmodSync(path, 0o755);
  return path;
}

function runScript(path: string, args: string[], env: Record<string, string>) {
  const r = Bun.spawnSync(["/bin/sh", path, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("ops/caelo-converge-job (the converge job's entry point)", () => {
  it("refuses every argument list but exactly `converge-job`, before any code runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "caelo-entry-"));
    try {
      const path = scriptPrintingEnv(dir);
      for (const args of [
        [],
        ["destroy"],
        ["owner-reset", "--email", "evil@example.com"],
        ["rotate-secret"],
        ["converge-job", "--extra"],
        ["upgrader"],
      ]) {
        const r = runScript(path, args, { PATH: "/usr/bin:/bin" });
        expect(r.code).toBe(64);
        expect(r.err).toContain("refused");
        expect(r.out).toBe("");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts the job with a scrubbed environment: overrides never reach gcloud, Pulumi or Bun", () => {
    const dir = mkdtempSync(join(tmpdir(), "caelo-entry-"));
    try {
      const r = runScript(scriptPrintingEnv(dir), ["converge-job"], {
        PATH: "/usr/bin:/bin",
        CLOUDSDK_API_ENDPOINT_OVERRIDES_RUN: "https://evil.example/",
        CLOUDSDK_AUTH_ACCESS_TOKEN: "stolen",
        PULUMI_BACKEND_URL: "gs://evil",
        PULUMI_CONFIG_PASSPHRASE: "x",
        BUN_OPTIONS: "--preload=/tmp/x.ts",
        LD_PRELOAD: "/tmp/x.so",
        NODE_OPTIONS: "--require=/tmp/x.js",
        CLOUD_RUN_EXECUTION: "caelo-production-converge-abc12",
        CLOUD_RUN_JOB: "caelo-production-converge",
      });
      expect(r.code).toBe(0);
      const env = Object.fromEntries(
        r.out
          .trim()
          .split("\n")
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
      expect(Object.keys(env).sort()).toEqual(
        [
          "CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK",
          "CLOUDSDK_CORE_DISABLE_PROMPTS",
          "CLOUD_RUN_EXECUTION",
          "CLOUD_RUN_JOB",
          "CLOUD_RUN_TASK_ATTEMPT",
          "CLOUD_RUN_TASK_COUNT",
          "CLOUD_RUN_TASK_INDEX",
          "HOME",
          "PATH",
          "PULUMI_SKIP_UPDATE_CHECK",
        ].sort(),
      );
      expect(env.CLOUD_RUN_EXECUTION).toBe("caelo-production-converge-abc12");
      expect(env.PATH).toBe("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the deployed job runs exactly that entry point with that one argument", () => {
    const args = convergeJobDeployArgs({
      projectId: "acme",
      region: "europe-west1",
      env: "production",
      opsImageRef: `x/ops@sha256:${"c".repeat(64)}`,
      network: "n",
      subnet: "s",
    });
    expect(args).toContain("--command=caelo-converge-job");
    expect(args).toContain("--args=converge-job");
    expect(args).toContain("--clear-env-vars");
  });
});

describe("no upgrader or admin role carries run.jobs.runWithOverrides (#883 review)", () => {
  it("the forbidden list covers every predefined role that does", () => {
    for (const role of [
      "roles/run.developer",
      "roles/run.admin",
      "roles/run.invoker",
      "roles/run.jobsExecutorWithOverrides",
      "roles/editor",
      "roles/owner",
    ]) {
      expect(RUN_WITH_OVERRIDES_ROLES).toContain(role as (typeof RUN_WITH_OVERRIDES_ROLES)[number]);
      expect(UPGRADER_FORBIDDEN_ROLES.some((f) => role.startsWith(f))).toBe(true);
    }
  });

  it("the upgrader's own Cloud Run role leaves it out", () => {
    expect(UPGRADER_RUN_ROLE.permissions).not.toContain("run.jobs.runWithOverrides");
    expect(UPGRADER_RUN_ROLE.permissions.some((p) => /setIamPolicy|actAs/.test(p))).toBe(false);
    for (const role of UPGRADER_PROJECT_ROLES) {
      expect(RUN_WITH_OVERRIDES_ROLES as readonly string[]).not.toContain(role);
    }
  });

  it("setup grants the upgrader no such role, and removes the run.developer an earlier setup gave it", async () => {
    const calls: string[][] = [];
    const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
    const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });
    const upgrader = "serviceAccount:caelo-production-upgrader@acme.iam.gserviceaccount.com";
    const rules: [RegExp, GcloudResult][] = [
      [/^iam roles describe/, fail("NOT_FOUND")],
      [/^iam service-accounts describe/, ok("x")],
      [
        /^projects get-iam-policy/,
        ok(JSON.stringify({ bindings: [{ role: "roles/run.developer", members: [upgrader] }] })),
      ],
      [/^sql instances list/, ok("caelo-production-pg-abc\n")],
      [/^sql instances describe/, ok('{"settings":{"databaseFlags":[]}}')],
      [/^sql users list/, ok("")],
    ];
    const run = async (args: string[]) => {
      calls.push(args);
      return rules.find(([re]) => re.test(args.join(" ")))?.[1] ?? ok("");
    };
    const r = await ensureUpgraderJob(
      {
        projectId: "acme",
        region: "europe-west1",
        env: "production",
        opsImageRef: `x/ops@sha256:${"c".repeat(64)}`,
        network: "n",
        subnet: "s",
      },
      { run, sleep: async () => {} },
    );
    expect(r.ok).toBe(true);
    const roleOf = (c: string[]) => c.find((a) => a.startsWith("--role="))?.slice(7) ?? "";
    const granted = calls.filter((c) => c.includes("add-iam-policy-binding")).map(roleOf);
    for (const role of granted) {
      expect(RUN_WITH_OVERRIDES_ROLES as readonly string[]).not.toContain(role);
    }
    const removed = calls.filter((c) => c.includes("remove-iam-policy-binding"));
    expect(removed.map((c) => `${roleOf(c)} ${c.find((a) => a.startsWith("--member="))}`)).toEqual([
      `roles/run.developer --member=${upgrader}`,
    ]);
    // The custom role is bound before the old one is removed.
    const bindRun = calls.findIndex((c) => roleOf(c) === "projects/acme/roles/caeloUpgraderRun");
    const removeDev = calls.findIndex((c) => c.includes("remove-iam-policy-binding"));
    expect(bindRun).toBeGreaterThan(-1);
    expect(bindRun).toBeLessThan(removeDev);
  });

  it("the admin's roles on the converge job carry none", () => {
    for (const role of CONVERGE_ADMIN_ROLES) {
      expect(RUN_WITH_OVERRIDES_ROLES as readonly string[]).not.toContain(role);
    }
  });
});

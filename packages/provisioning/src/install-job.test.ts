// SPDX-License-Identifier: MPL-2.0

/**
 * The install job (#696, Phase 3) against a fake gcloud: the job
 * definition, the bucket status document, the attach decision, starting an
 * execution, log tailing and the setup-link secret.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import {
  acquireLaunchLock,
  claimInstallJobStatus,
  decideInstallJob,
  describeExecution,
  INSTALL_CLOUDFLARE_TOKEN_SECRET,
  INSTALL_JOB_NAME,
  INSTALL_SETUP_LINK_SECRET,
  type InstallJobStatus,
  installJobDeployArgs,
  installJobStatusUrl,
  OPS_IMAGE_REPOSITORY,
  opsImageRef,
  readExecutionLogs,
  readInstallJobStatus,
  readSetupLink,
  startInstallJob,
  storeInstallSecretValue,
  storeSetupLink,
  writeInstallJobStatus,
} from "./install-job.js";
import { failureDetail, installJobProject } from "./install-job-runner.js";
import { chooseRunMode, inCloudShell } from "./run-mode.js";
import type { SyncGcloud } from "./state-store.js";
import { tailInstallJob } from "./wizards/gcp-install-job.js";

const ok = (stdout = "", stderr = ""): GcloudResult => ({ ok: true, stdout, stderr, exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const DIGEST = `sha256:${"a".repeat(64)}`;
const BUCKET = "acme-site-caelo-ops";

const STATUS: InstallJobStatus = {
  statusVersion: 1,
  installId: "gcp-acme-site",
  execution: "caelo-install-abc12",
  state: "running",
  phase: "Provisioning the infrastructure (pulumi up, 8-15 min)",
  caeloVersion: "0.10.46",
  startedAt: "2026-10-13T10:00:00.000Z",
  updatedAt: "2026-10-13T10:05:00.000Z",
};

/**
 * An in-memory ops bucket behind `gcloud storage cat|cp|objects describe`,
 * with object generations and `--if-generation-match`.
 */
function fakeBucket(
  objects: Map<string, string> = new Map(),
  generations: Map<string, number> = new Map(),
): SyncGcloud {
  return (args, input) => {
    if (args[0] === "storage" && args[1] === "cat") {
      const v = objects.get(args[2] ?? "");
      return v === undefined ? fail("One or more URLs matched no objects.") : ok(v);
    }
    if (args[0] === "storage" && args[1] === "objects" && args[2] === "describe") {
      const g = generations.get(args[3] ?? "");
      return g === undefined ? fail("NotFound: 404") : ok(`${g}\n`);
    }
    if (args[0] === "storage" && args[1] === "cp" && args[2] === "-") {
      const url = args[3] ?? "";
      const match = args.find((a) => a.startsWith("--if-generation-match="));
      if (match && Number(match.split("=")[1]) !== (generations.get(url) ?? 0)) {
        return fail("PreconditionFailed: 412 At least one of the pre-conditions did not hold.");
      }
      objects.set(url, input ?? "");
      generations.set(url, (generations.get(url) ?? 0) + 1);
      return ok();
    }
    return fail(`unexpected: ${args.join(" ")}`);
  };
}

/** A scripted async gcloud: `respond` gets every argv; calls are recorded. */
function fakeRun(respond: (args: string[], stdin?: string) => GcloudResult): {
  run: GcloudRunner;
  calls: { args: string[]; stdin?: string }[];
} {
  const calls: { args: string[]; stdin?: string }[] = [];
  return {
    calls,
    run: async (args, opts) => {
      calls.push(opts?.stdin === undefined ? { args } : { args, stdin: opts.stdin });
      return respond(args, opts?.stdin);
    },
  };
}

describe("the job definition", () => {
  it("pins the ops image by digest on the public mirror", () => {
    expect(opsImageRef(DIGEST)).toBe(`${OPS_IMAGE_REPOSITORY}@${DIGEST}`);
    expect(() => opsImageRef("latest")).toThrow(/not an image digest/);
  });

  it("runs as the provisioner, with the project as its only argument and no retries", () => {
    const args = installJobDeployArgs({
      projectId: "acme-site",
      region: "europe-west3",
      serviceAccount: "caelo-provisioner@acme-site.iam.gserviceaccount.com",
      image: opsImageRef(DIGEST),
      cloudflareToken: false,
    });
    expect(args.slice(0, 4)).toEqual(["run", "jobs", "deploy", INSTALL_JOB_NAME]);
    expect(args).toContain("--service-account=caelo-provisioner@acme-site.iam.gserviceaccount.com");
    expect(args).toContain("--args=install-job,--project,acme-site");
    expect(args).toContain("--max-retries=0");
    expect(args).toContain(`--image=${OPS_IMAGE_REPOSITORY}@${DIGEST}`);
    // No key, no secret, no credential of any kind in the definition.
    expect(args).toContain("--clear-secrets");
    expect(args.filter((a) => a !== "--clear-secrets").join(" ")).not.toMatch(
      /key|secret|password|token/i,
    );
  });

  it("mounts the Cloudflare token from Secret Manager when the operator has one", () => {
    const args = installJobDeployArgs({
      projectId: "acme-site",
      region: "europe-west3",
      serviceAccount: "caelo-provisioner@acme-site.iam.gserviceaccount.com",
      image: opsImageRef(DIGEST),
      cloudflareToken: true,
    });
    expect(args).toContain(
      `--set-secrets=CLOUDFLARE_API_TOKEN=${INSTALL_CLOUDFLARE_TOKEN_SECRET}:latest`,
    );
    expect(args).not.toContain("--clear-secrets");
  });
});

describe("the status document", () => {
  it("round-trips through the bucket and is null before the first run", () => {
    const objects = new Map<string, string>();
    const run = fakeBucket(objects);
    expect(readInstallJobStatus(BUCKET, run)).toBeNull();
    writeInstallJobStatus(BUCKET, STATUS, run);
    expect(objects.has(installJobStatusUrl(BUCKET))).toBe(true);
    expect(readInstallJobStatus(BUCKET, run)).toEqual(STATUS);
  });

  it("refuses to write secret material", () => {
    const run = fakeBucket();
    expect(() =>
      writeInstallJobStatus(
        BUCKET,
        { ...STATUS, detail: "postgres://admin_role:hunter2hunter2@10.0.0.3/cms_admin" },
        run,
      ),
    ).toThrow();
  });

  it("fails loudly on a malformed document and on an unreadable bucket", () => {
    const objects = new Map([[installJobStatusUrl(BUCKET), '{"statusVersion":9}']]);
    expect(() => readInstallJobStatus(BUCKET, fakeBucket(objects))).toThrow(/not an install-job/);
    expect(() => readInstallJobStatus(BUCKET, () => fail("403 Forbidden"))).toThrow(/403/);
  });
});

describe("claimInstallJobStatus", () => {
  it("records a just-started execution when the document doesn't name it yet", () => {
    const run = fakeBucket();
    writeInstallJobStatus(BUCKET, { ...STATUS, execution: "old", state: "failed" }, run);
    expect(claimInstallJobStatus(BUCKET, STATUS, run)).toBe(true);
    expect(readInstallJobStatus(BUCKET, run)).toEqual(STATUS);
  });

  it("never overwrites what the execution itself already recorded", () => {
    const run = fakeBucket();
    const own = { ...STATUS, phase: "Waiting for DNS", detail: "A admin.acme.com → 1.2.3.4" };
    writeInstallJobStatus(BUCKET, own, run);
    expect(claimInstallJobStatus(BUCKET, { ...STATUS, phase: "Starting" }, run)).toBe(false);
    expect(readInstallJobStatus(BUCKET, run)).toEqual(own);
  });

  it("loses the race against a write that lands after its read", () => {
    const inner = fakeBucket();
    let raced = false;
    // The execution writes between the launcher's generation read and its write.
    const run: SyncGcloud = (args, input) => {
      const r = inner(args, input);
      if (!raced && args[1] === "objects") {
        raced = true;
        writeInstallJobStatus(BUCKET, { ...STATUS, phase: "Choosing the release images" }, inner);
      }
      return r;
    };
    expect(claimInstallJobStatus(BUCKET, { ...STATUS, execution: "launcher" }, run)).toBe(false);
    expect(readInstallJobStatus(BUCKET, inner)?.phase).toBe("Choosing the release images");
  });
});

describe("acquireLaunchLock", () => {
  it("lets one launcher in at a time and releases", () => {
    const objects = new Map<string, string>();
    const generations = new Map<string, number>();
    const bucket = fakeBucket(objects, generations);
    const run: SyncGcloud = (args, input) => {
      if (args[1] === "rm") {
        objects.delete(args[2] ?? "");
        generations.delete(args[2] ?? "");
        return ok();
      }
      return bucket(args, input);
    };
    const release = acquireLaunchLock(BUCKET, run);
    expect(() => acquireLaunchLock(BUCKET, run)).toThrow(/Another terminal is starting/);
    release();
    expect(() => acquireLaunchLock(BUCKET, run)()).not.toThrow();
  });
});

describe("decideInstallJob", () => {
  it("starts when nothing ran yet", () => {
    expect(decideInstallJob(null, null).kind).toBe("start");
  });
  it("attaches to a running execution", () => {
    expect(decideInstallJob(STATUS, "running")).toEqual({ kind: "attach", status: STATUS });
  });
  it("shows a finished install", () => {
    const done = { ...STATUS, state: "succeeded" as const, phase: "Done" };
    expect(decideInstallJob(done, null)).toEqual({ kind: "done", status: done });
  });
  it("restarts after a recorded failure, naming where it stopped", () => {
    const failed = { ...STATUS, state: "failed" as const, phase: "Waiting for DNS", detail: "x" };
    const d = decideInstallJob(failed, null);
    expect(d.kind).toBe("start");
    if (d.kind === "start") expect(d.why).toContain("Waiting for DNS");
  });
  it("restarts when the execution died without recording a result", () => {
    for (const live of ["failed", "missing", "succeeded"] as const) {
      const d = decideInstallJob(STATUS, live);
      expect(d.kind).toBe("start");
      if (d.kind === "start") expect(d.previous).toEqual(STATUS);
    }
  });
});

describe("describeExecution", () => {
  const target = { projectId: "acme-site", region: "europe-west3", execution: "e1" };
  it("reads running / succeeded / failed / missing", async () => {
    const states: [GcloudResult, string][] = [
      [ok(JSON.stringify({ status: { runningCount: 1 } })), "running"],
      [ok(JSON.stringify({ status: { completionTime: "t", succeededCount: 1 } })), "succeeded"],
      [ok(JSON.stringify({ status: { completionTime: "t", failedCount: 1 } })), "failed"],
      [ok(JSON.stringify({ status: { completionTime: "t", cancelledCount: 1 } })), "failed"],
      [fail("ERROR: (gcloud.run.jobs.executions.describe) NOT_FOUND"), "missing"],
    ];
    for (const [r, want] of states) {
      expect(await describeExecution(fakeRun(() => r).run, target)).toBe(want as never);
    }
  });
  it("throws on any other error", async () => {
    await expect(
      describeExecution(fakeRun(() => fail("PERMISSION_DENIED")).run, target),
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

describe("startInstallJob", () => {
  const spec = {
    projectId: "acme-site",
    region: "europe-west3",
    serviceAccount: "caelo-provisioner@acme-site.iam.gserviceaccount.com",
    image: opsImageRef(DIGEST),
    cloudflareToken: false,
  };
  it("deploys the job, then executes it asynchronously", async () => {
    const { run, calls } = fakeRun((args) =>
      args[2] === "execute" ? ok("caelo-install-x7k2p\n") : ok(),
    );
    expect(await startInstallJob(run, spec)).toEqual({
      ok: true,
      execution: "caelo-install-x7k2p",
    });
    expect(calls.map((c) => c.args[2])).toEqual(["deploy", "execute"]);
    expect(calls[1]?.args).toContain("--async");
  });
  it("takes the execution name from gcloud's stderr announcement", async () => {
    const { run } = fakeRun((args) =>
      args[2] === "execute"
        ? ok("", "Execution [caelo-install-q9] has successfully started running.")
        : ok(),
    );
    expect(await startInstallJob(run, spec)).toEqual({ ok: true, execution: "caelo-install-q9" });
  });
  it("reports a failed deploy without executing", async () => {
    const { run, calls } = fakeRun(() => fail("PERMISSION_DENIED: iam.serviceAccounts.actAs"));
    const r = await startInstallJob(run, spec);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("readExecutionLogs", () => {
  it("returns new lines in order, skipping entries already seen", async () => {
    const entries = [
      { insertId: "a", timestamp: "2026-10-13T10:00:00Z", textPayload: "first\n" },
      { insertId: "b", timestamp: "2026-10-13T10:00:01Z", textPayload: "second" },
    ];
    const { run, calls } = fakeRun(() => ok(JSON.stringify(entries)));
    const seen = new Set<string>();
    const target = { projectId: "acme-site", execution: "e1" };
    const one = await readExecutionLogs(run, target, null, seen);
    expect(one).toEqual({ lines: ["first", "second"], cursor: "2026-10-13T10:00:01Z" });
    const two = await readExecutionLogs(run, target, one.cursor, seen);
    expect(two.lines).toEqual([]);
    expect(calls[1]?.args[2]).toContain('timestamp>="2026-10-13T10:00:01Z"');
    expect(calls[0]?.args[2]).toContain(`labels."run.googleapis.com/execution_name"="e1"`);
  });
});

describe("the setup-link secret", () => {
  it("creates the secret with the install's replication, adds the link on stdin and disables older versions", async () => {
    const { run, calls } = fakeRun((args) => {
      if (args[1] === "describe" && args[2] === INSTALL_SETUP_LINK_SECRET) return fail("NOT_FOUND");
      if (args[1] === "describe")
        return ok(
          JSON.stringify({
            replication: { userManaged: { replicas: [{ location: "europe-west3" }] } },
          }),
        );
      if (args[1] === "versions" && args[2] === "add")
        return ok(`projects/1/secrets/${INSTALL_SETUP_LINK_SECRET}/versions/3\n`);
      if (args[1] === "versions" && args[2] === "list")
        return ok(
          [1, 2, 3]
            .map((v) => `projects/1/secrets/${INSTALL_SETUP_LINK_SECRET}/versions/${v}`)
            .join("\n"),
        );
      return ok();
    });
    const link = "https://admin.acme.com/setup?token=abc";
    expect(
      await storeSetupLink(run, { projectId: "acme-site", region: "europe-west3" }, link),
    ).toEqual({
      ok: true,
    });
    const create = calls.find((c) => c.args[1] === "create");
    expect(create?.args).toContain("--locations=europe-west3");
    const add = calls.find((c) => c.args[2] === "add");
    expect(add?.stdin).toBe(link);
    // The link never appears on a command line.
    expect(calls.some((c) => c.args.join(" ").includes("token=abc"))).toBe(false);
    const disabled = calls.filter((c) => c.args[2] === "disable").map((c) => c.args[3]);
    expect(disabled).toEqual(["1", "2"]);
  });

  it("reads the link back, null when there is none", async () => {
    expect(await readSetupLink(fakeRun(() => ok("https://x/setup?token=1\n")).run, "p")).toBe(
      "https://x/setup?token=1",
    );
    expect(await readSetupLink(fakeRun(() => fail("NOT_FOUND")).run, "p")).toBeNull();
    expect(
      await readSetupLink(
        fakeRun(() => fail("FAILED_PRECONDITION: version is in DISABLED state")).run,
        "p",
      ),
    ).toBeNull();
  });

  it("says what access is missing instead of treating a denial as 'no link'", async () => {
    await expect(
      readSetupLink(
        fakeRun(() => fail("PERMISSION_DENIED: secretmanager.versions.access")).run,
        "p",
      ),
    ).rejects.toThrow(/secretmanager.versions.access/);
  });

  it("creates a secret regionally before the stack's secrets exist", async () => {
    const { run, calls } = fakeRun((args) => {
      if (args[1] === "describe") return fail("NOT_FOUND: Secret not found");
      if (args[1] === "versions" && args[2] === "add") return ok("projects/1/secrets/x/versions/1");
      return ok();
    });
    const r = await storeInstallSecretValue(
      run,
      { projectId: "acme-site", region: "europe-west3" },
      INSTALL_CLOUDFLARE_TOKEN_SECRET,
      "cf-token-value",
    );
    expect(r).toEqual({ ok: true });
    const create = calls.find((c) => c.args[1] === "create");
    expect(create?.args).toContain("--replication-policy=user-managed");
    expect(create?.args).toContain("--locations=europe-west3");
    expect(calls.some((c) => c.args.join(" ").includes("cf-token-value"))).toBe(false);
  });
});

describe("tailInstallJob", () => {
  const target = { projectId: "acme-site", region: "europe-west3", execution: STATUS.execution };

  it("prints log lines and phases until the job records success", async () => {
    const objects = new Map<string, string>();
    const syncRun = fakeBucket(objects);
    writeInstallJobStatus(BUCKET, STATUS, syncRun);
    let poll = 0;
    const printed: string[] = [];
    const { run } = fakeRun((args) => {
      if (args[0] === "logging") {
        poll++;
        // Lines 4 and 5 arrive after the job recorded success (late ingestion).
        if (poll > 5) return ok("[]");
        return ok(
          JSON.stringify([
            { insertId: `i${poll}`, timestamp: `t${poll}`, textPayload: `line ${poll}` },
          ]),
        );
      }
      return ok(JSON.stringify({ status: {} }));
    });
    const outcome = await tailInstallJob(target, {
      run,
      syncRun,
      print: (l) => printed.push(l),
      intervalMs: 0,
      sleep: async () => {
        if (poll === 2)
          writeInstallJobStatus(BUCKET, { ...STATUS, state: "succeeded", phase: "Done" }, syncRun);
      },
    });
    expect(outcome).toEqual({ kind: "succeeded" });
    expect(printed.filter((l) => l.startsWith("line"))).toEqual([
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
    ]);
    expect(printed.some((l) => l.includes(STATUS.phase))).toBe(true);
  });

  it("reports an execution that ended without recording a result", async () => {
    const syncRun = fakeBucket();
    writeInstallJobStatus(BUCKET, STATUS, syncRun);
    const { run } = fakeRun((args) =>
      args[0] === "logging"
        ? ok("[]")
        : ok(JSON.stringify({ status: { completionTime: "t", failedCount: 1 } })),
    );
    const outcome = await tailInstallJob(target, {
      run,
      syncRun,
      print: () => {},
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.why).toContain("without recording a result");
  });

  it("returns the recorded failure", async () => {
    const syncRun = fakeBucket();
    writeInstallJobStatus(
      BUCKET,
      { ...STATUS, state: "failed", phase: "Waiting for DNS", detail: "exit 1: unresolved" },
      syncRun,
    );
    const outcome = await tailInstallJob(target, {
      run: fakeRun(() => ok("[]")).run,
      syncRun,
      print: () => {},
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(outcome).toMatchObject({ kind: "failed", why: "exit 1: unresolved" });
  });
});

describe("the job's entry point", () => {
  it("takes a valid --project and nothing else", () => {
    expect(installJobProject(["bun", "cli", "install-job", "--project", "acme-site"])).toBe(
      "acme-site",
    );
    expect(() => installJobProject(["bun", "cli", "install-job"])).toThrow(/--project/);
    expect(() => installJobProject(["bun", "cli", "install-job", "--project", "x;rm"])).toThrow();
  });

  it("records the last output lines as the failure detail, credentials masked", () => {
    const d = failureDetail(
      [
        "\u001b[31m│\u001b[39m",
        "Migrations failed: connect postgres://u:pw1234567890@h/db",
        "■  Aborted.",
      ],
      1,
    );
    expect(d).toStartWith("exit 1: ");
    expect(d).not.toContain("pw1234567890");
    expect(d).toContain("Aborted.");
  });
});

describe("run mode", () => {
  it("defaults to the install job in Cloud Shell and to local elsewhere", () => {
    expect(inCloudShell({ CLOUD_SHELL: "true" })).toBe(true);
    expect(chooseRunMode([], { CLOUD_SHELL: "true" })).toBe("job");
    expect(chooseRunMode([], {})).toBe("local");
  });
  it("honours --local and --install-job, and refuses both", () => {
    expect(chooseRunMode(["--local"], { CLOUD_SHELL: "true" })).toBe("local");
    expect(chooseRunMode(["--install-job"], {})).toBe("job");
    expect(() => chooseRunMode(["--local", "--install-job"], {})).toThrow(/either/);
  });
});

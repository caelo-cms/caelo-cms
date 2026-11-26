// SPDX-License-Identifier: MPL-2.0

/**
 * The launcher's decision for an install that has a job (gcp-install-job.ts
 * decideInstallRun): a finished install whose Owner email was corrected on a
 * re-run runs the job again, which applies it, against fake gcloud runners.
 * Before, a finished install was shown as done with the address it was
 * installed with, and a wrong one could not be corrected in job mode at all.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GcloudResult } from "../gcloud.js";
import type { GcloudRunner } from "../gcloud-retry.js";
import { INSTALL_SETUP_LINK_SECRET, type InstallJobStatus } from "../install-job.js";
import { opsBucketName } from "../state-backend.js";
import type { SyncGcloud } from "../state-store.js";
import { decideInstallRun } from "./gcp-install-job.js";

const PROJECT = "acme-site";
const REGION = "europe-west1";
const JOB = "caelo-production-operator-access-sync";
const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const status = (state: InstallJobStatus["state"]): InstallJobStatus => ({
  statusVersion: 1,
  installId: "gcp-acme-site",
  execution: "caelo-install-x7k2p",
  state,
  phase: state === "succeeded" ? "Done" : "Provisioning the infrastructure (pulumi up, 8-15 min)",
  caeloVersion: "0.12.16",
  startedAt: "2026-11-26T10:00:00.000Z",
  updatedAt: "2026-11-26T11:00:00.000Z",
});

/** The operator-access job as `gcloud run jobs describe --format=json` shows it. */
const accessJob = (members: string) =>
  JSON.stringify({
    spec: {
      template: {
        spec: {
          template: {
            spec: {
              containers: [
                { env: [{ name: "CAELO_OPERATOR_ACCESS_STATIC_MEMBERS", value: members }] },
              ],
            },
          },
        },
      },
    },
  });

/**
 * The bucket's install-job.json, and gcloud for a project whose setup link
 * is stored and whose operator-access job admits `admits` (or answers
 * `accessJob` when given); every gcloud call recorded.
 */
function fakeProject(opts: {
  readonly job: InstallJobStatus;
  readonly admits?: string;
  readonly accessJob?: GcloudResult;
  readonly execution?: "running" | "finished";
}) {
  const calls: string[][] = [];
  const syncRun: SyncGcloud = (args) =>
    args.join(" ") === `storage cat gs://${opsBucketName(PROJECT)}/install/install-job.json`
      ? ok(JSON.stringify(opts.job))
      : fail(`unexpected gcloud ${args.join(" ")}`);
  const run: GcloudRunner = async (args) => {
    calls.push(args);
    const line = args.join(" ");
    if (line.startsWith(`secrets versions access latest --secret=${INSTALL_SETUP_LINK_SECRET}`)) {
      return ok("https://caelo-production-admin-abc-ew.a.run.app/setup?token=t0k3n");
    }
    if (line.startsWith(`run jobs describe ${JOB} --region=${REGION} --project=${PROJECT}`)) {
      return opts.accessJob ?? ok(accessJob(opts.admits ?? ""));
    }
    if (line.startsWith("run jobs executions describe")) {
      return ok(
        JSON.stringify({ status: opts.execution === "finished" ? { completionTime: "x" } : {} }),
      );
    }
    return fail(`unexpected gcloud ${line}`);
  };
  return { run, syncRun, calls };
}

const target = (ownerEmail: string) => ({ projectId: PROJECT, region: REGION, ownerEmail });

describe("decideInstallRun — the Owner email of a finished install", () => {
  it("a finished install runs again when its corrected Owner email is not applied yet", async () => {
    const p = fakeProject({ job: status("succeeded"), admits: "user:owner@acme.exmaple" });
    const decision = await decideInstallRun(p.run, p.syncRun, target("owner@acme.example"));
    expect(decision.kind).toBe("start");
    if (decision.kind !== "start") throw new Error("unreachable");
    expect(decision.previous?.state).toBe("succeeded");
    expect(decision.why).toBe(
      "the Owner email owner@acme.example is not applied yet (the admin admits user:owner@acme.exmaple, the records would make it user:owner@acme.example); a new run applies it",
    );
  });

  it("a finished install whose operator-access job admits the recorded address is done", async () => {
    const p = fakeProject({ job: status("succeeded"), admits: "user:owner@acme.example" });
    const decision = await decideInstallRun(p.run, p.syncRun, target("Owner@Acme.example"));
    expect(decision.kind).toBe("done");
  });

  it("a finished install without its operator-access job runs again", async () => {
    const p = fakeProject({
      job: status("succeeded"),
      accessJob: fail(`ERROR: (gcloud.run.jobs.describe) Cannot find job [${JOB}].`),
    });
    const decision = await decideInstallRun(p.run, p.syncRun, target("owner@acme.example"));
    expect(decision.kind).toBe("start");
    if (decision.kind === "start") expect(decision.why).toContain(`${JOB} does not exist`);
  });

  it("an operator-access job that cannot be read stops the launcher with the next step", async () => {
    const p = fakeProject({
      job: status("succeeded"),
      accessJob: fail("ERROR: (gcloud.run.jobs.describe) PERMISSION_DENIED: run.jobs.get"),
    });
    await expect(decideInstallRun(p.run, p.syncRun, target("owner@acme.example"))).rejects.toThrow(
      `Could not read the operator-access job ${JOB} in ${PROJECT}: ERROR: (gcloud.run.jobs.describe) PERMISSION_DENIED: run.jobs.get. Check that gcloud is signed in as an Owner of the project`,
    );
  });

  it("a running job is followed: its Owner email is not looked at", async () => {
    const p = fakeProject({ job: status("running"), execution: "running" });
    const decision = await decideInstallRun(p.run, p.syncRun, target("someone@else.example"));
    expect(decision.kind).toBe("attach");
    expect(p.calls.some((a) => a.includes(JOB))).toBe(false);
  });

  it("an unfinished install starts again without asking about access", async () => {
    const p = fakeProject({ job: status("failed") });
    const decision = await decideInstallRun(p.run, p.syncRun, target("owner@acme.example"));
    expect(decision.kind).toBe("start");
    expect(p.calls).toEqual([]);
  });
});

describe("prepareJobModeInstall — a resumed install's Owner email", () => {
  // The function runs gcloud and prompts, so its order is pinned on the
  // source, like the billing check's (gcp-billing.test.ts).
  const source = readFileSync(join(import.meta.dir, "gcp-install-job.ts"), "utf8");
  const prep = source.slice(
    source.indexOf("export async function prepareJobModeInstall("),
    source.indexOf("function refuseOwnerChangeDuringRun("),
  );

  it("asks for it, and records a change, before it shows a finished install", () => {
    const afterAttach = prep.indexOf('if (decision.kind === "attach") {');
    const ask = prep.indexOf("await resolveResumedOwnerEmail(meta, owner)", afterAttach);
    expect(afterAttach).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(afterAttach);
    expect(ask).toBeLessThan(prep.indexOf("await recordOwnerEmailForJob("));
    expect(prep.indexOf("await recordOwnerEmailForJob(")).toBeLessThan(
      prep.indexOf("await showResult("),
    );
  });

  it("refuses a change before it follows a running job", () => {
    expect(prep.indexOf("refuseOwnerChangeDuringRun(")).toBeGreaterThan(-1);
    expect(prep.indexOf("refuseOwnerChangeDuringRun(")).toBeLessThan(
      prep.indexOf("await followToTheEnd("),
    );
  });

  it("hands the flag and the run mode's interactivity over from the wizard", () => {
    const wizard = readFileSync(join(import.meta.dir, "..", "wizard.ts"), "utf8");
    const call = wizard.slice(wizard.indexOf("await prepareJobModeInstall({"));
    const args = call.slice(0, call.indexOf("});"));
    expect(args).toContain("ownerEmail: opts.ownerEmail");
    expect(args).toContain("nonInteractive: opts.nonInteractive");
  });
});

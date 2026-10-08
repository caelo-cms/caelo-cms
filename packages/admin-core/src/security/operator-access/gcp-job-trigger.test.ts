// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { gcpJobTriggerFromEnv, OperatorAccessError, UPGRADE_HINT } from "./gcp-job-trigger.js";
import type { GoogleDeps } from "./google-iam.js";

const JOB = "projects/p/locations/europe-west1/jobs/caelo-production-operator-access-sync";
const API = `https://run.googleapis.com/v2/${JOB}`;
const EXEC = `${JOB.replace("/jobs/caelo-production-operator-access-sync", "")}/jobs/caelo-production-operator-access-sync/executions/caelo-production-operator-access-sync-abc12`;

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeRun(...answers: { status: number; body: unknown }[]) {
  const calls: Call[] = [];
  const deps: GoogleDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const a = answers.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(a.body), { status: a.status });
    }) as typeof fetch,
    accessToken: async () => "tok",
    metadata: async () => "",
  };
  return { deps, calls };
}

const env = { CAELO_PROVIDER: "gcp-firebase", CAELO_OPERATOR_ACCESS_JOB: JOB };
const noSleep = async () => {};

describe("gcpJobTriggerFromEnv", () => {
  it("is null (nothing to sync) on installs without Google IAP", () => {
    for (const provider of [undefined, "self-hosted", "aws", "azure"]) {
      expect(gcpJobTriggerFromEnv({ CAELO_PROVIDER: provider })).toBeNull();
    }
  });

  it("starts the job with an EMPTY body — no overrides — and returns the execution", async () => {
    const { deps, calls } = fakeRun({ status: 200, body: { metadata: { name: EXEC } } });
    const trigger = gcpJobTriggerFromEnv(env, deps, noSleep);
    expect(await trigger?.start()).toBe("caelo-production-operator-access-sync-abc12");
    expect(calls).toEqual([{ url: `${API}:run`, method: "POST", body: {} }]);
  });

  it("waits until the job's latest execution (ours) completes", async () => {
    const { deps } = fakeRun(
      { status: 200, body: { latestCreatedExecution: { name: EXEC } } },
      {
        status: 200,
        body: {
          latestCreatedExecution: {
            name: EXEC,
            completionStatus: "EXECUTION_FAILED",
            completionTime: "2026-10-08T10:00:00Z",
          },
        },
      },
    );
    const s = await gcpJobTriggerFromEnv(env, deps, noSleep)?.wait(
      "caelo-production-operator-access-sync-abc12",
      60_000,
    );
    expect(s).toEqual({
      execution: "caelo-production-operator-access-sync-abc12",
      state: "failed",
      completedAt: "2026-10-08T10:00:00Z",
      logsUrl:
        "https://console.cloud.google.com/run/jobs/executions/details/europe-west1/caelo-production-operator-access-sync-abc12/logs?project=p",
    });
  });

  it("reports running when a newer run superseded ours or the wait timed out", async () => {
    const { deps } = fakeRun({
      status: 200,
      body: { latestCreatedExecution: { name: `${EXEC}-newer` } },
    });
    const s = await gcpJobTriggerFromEnv(env, deps, noSleep)?.wait(
      "caelo-production-operator-access-sync-abc12",
      60_000,
    );
    expect(s?.state).toBe("running");
  });

  it("a 403 (admin may not start the job) points at cms-provision upgrade", async () => {
    const { deps } = fakeRun({ status: 403, body: { error: "run.jobs.run denied" } });
    const e = await gcpJobTriggerFromEnv(env, deps, noSleep)
      ?.start()
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OperatorAccessError);
    expect((e as OperatorAccessError).nextStep).toBe(UPGRADE_HINT);
  });

  it("fails loudly, without calling Google, when the admin has no job configured", async () => {
    const { deps, calls } = fakeRun();
    const trigger = gcpJobTriggerFromEnv({ CAELO_PROVIDER: "gcp" }, deps, noSleep);
    const e = await trigger?.start().catch((x: unknown) => x);
    expect((e as Error).message).toContain("CAELO_OPERATOR_ACCESS_JOB is not set");
    expect(calls).toEqual([]);
  });
});

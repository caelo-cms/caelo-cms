// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GoogleDeps } from "../operator-access/google-iam.js";
import {
  CONVERGE_SETUP_HINT,
  convergeTriggerFromEnv,
  UPGRADER_SETUP_HINT,
  UpgraderTriggerError,
  upgraderTriggerFromEnv,
} from "./job-trigger.js";

const JOB = "projects/acme/locations/europe-west1/jobs/caelo-production-upgrader";
const API = `https://run.googleapis.com/v2/${JOB}`;

function fakeGoogle(...answers: { status: number; body: unknown }[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
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

const env = { CAELO_PROVIDER: "gcp", CAELO_UPGRADER_JOB: JOB };

describe("upgraderTriggerFromEnv", () => {
  it("has no trigger off Google Cloud or before the job was set up (the page shows the command)", () => {
    for (const e of [
      { CAELO_PROVIDER: "self-hosted", CAELO_UPGRADER_JOB: JOB },
      { CAELO_PROVIDER: "aws" },
      { CAELO_PROVIDER: "gcp" },
      { CAELO_PROVIDER: "gcp-firebase", CAELO_UPGRADER_JOB: "  " },
    ]) {
      expect(upgraderTriggerFromEnv(e)).toBeNull();
    }
  });

  it("refuses a malformed job name loudly", () => {
    expect(() =>
      upgraderTriggerFromEnv({ CAELO_PROVIDER: "gcp", CAELO_UPGRADER_JOB: "caelo-upgrader" }),
    ).toThrow(UpgraderTriggerError);
  });

  it("starts the job with an EMPTY body — no overrides — and returns the execution", async () => {
    const { deps, calls } = fakeGoogle({
      status: 200,
      body: { metadata: { name: `${JOB}/executions/caelo-production-upgrader-x7k2p` } },
    });
    const trigger = upgraderTriggerFromEnv(env, deps);
    expect(await trigger?.start()).toBe("caelo-production-upgrader-x7k2p");
    expect(calls).toEqual([{ url: `${API}:run`, method: "POST", body: {} }]);
  });

  it("a 403 (the admin may not start it) says how to set the upgrader up", async () => {
    const { deps } = fakeGoogle({ status: 403, body: { error: "denied" } });
    const err = await upgraderTriggerFromEnv(env, deps)
      ?.start()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpgraderTriggerError);
    expect((err as UpgraderTriggerError).nextStep).toBe(UPGRADER_SETUP_HINT);
  });

  it("reads the latest run's state and its log link", async () => {
    const { deps } = fakeGoogle({
      status: 200,
      body: {
        latestCreatedExecution: {
          name: `${JOB}/executions/caelo-production-upgrader-x7k2p`,
          completionStatus: "EXECUTION_FAILED",
          completionTime: "2026-10-13T12:00:00Z",
        },
      },
    });
    expect(await upgraderTriggerFromEnv(env, deps)?.latest()).toEqual({
      execution: "caelo-production-upgrader-x7k2p",
      state: "failed",
      completedAt: "2026-10-13T12:00:00Z",
      logsUrl:
        "https://console.cloud.google.com/run/jobs/executions/details/europe-west1/caelo-production-upgrader-x7k2p/logs?project=acme",
    });
  });
});

describe("convergeTriggerFromEnv (#819)", () => {
  const CONVERGE = "projects/acme/locations/europe-west1/jobs/caelo-production-converge";

  it("has no trigger off Google Cloud or on an install without the converge job", () => {
    for (const e of [
      { CAELO_PROVIDER: "self-hosted", CAELO_CONVERGE_JOB: CONVERGE },
      { CAELO_PROVIDER: "aws", CAELO_CONVERGE_JOB: CONVERGE },
      { CAELO_PROVIDER: "azure", CAELO_CONVERGE_JOB: CONVERGE },
      { CAELO_PROVIDER: "gcp" },
    ]) {
      expect(convergeTriggerFromEnv(e)).toBeNull();
    }
  });

  it("starts the converge job with an EMPTY body — no overrides — never the upgrader", async () => {
    const { deps, calls } = fakeGoogle({
      status: 200,
      body: { metadata: { name: `${CONVERGE}/executions/caelo-production-converge-q1w2e` } },
    });
    const trigger = convergeTriggerFromEnv(
      { CAELO_PROVIDER: "gcp-firebase", CAELO_CONVERGE_JOB: CONVERGE },
      deps,
    );
    expect(await trigger?.start()).toBe("caelo-production-converge-q1w2e");
    expect(calls).toEqual([
      { url: `https://run.googleapis.com/v2/${CONVERGE}:run`, method: "POST", body: {} },
    ]);
  });

  it("a 403 says how to set the converge job up; a malformed name is refused", async () => {
    const { deps } = fakeGoogle({ status: 403, body: { error: "denied" } });
    const err = await convergeTriggerFromEnv(
      { CAELO_PROVIDER: "gcp", CAELO_CONVERGE_JOB: CONVERGE },
      deps,
    )
      ?.start()
      .catch((e: unknown) => e);
    expect((err as UpgraderTriggerError).nextStep).toBe(CONVERGE_SETUP_HINT);
    expect((err as UpgraderTriggerError).message).toContain(
      "the converge job could not be reached",
    );
    expect(() =>
      convergeTriggerFromEnv({ CAELO_PROVIDER: "gcp", CAELO_CONVERGE_JOB: "converge" }),
    ).toThrow(/CAELO_CONVERGE_JOB is not a Cloud Run job name/);
  });
});

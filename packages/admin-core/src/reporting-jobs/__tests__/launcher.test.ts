// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — where an install runs its reporting jobs: a Cloud Run job
 * execution on Google Cloud (its order as an env override), the admin's own
 * process on self-hosted and development installs, nowhere on aws / azure
 * — refused with the tracking issue, never run in the admin instead.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { GoogleDeps } from "../../security/operator-access/google-iam.js";
import { reportingJobKind } from "../kinds.js";
import { gcpReportingJobLauncher, launcherFor, setInProcessJobLauncher } from "../launcher.js";
import { JOB_ORDER_ENV_VAR, type JobOrder, jobOrderSchema } from "../protocol.js";

const def = reportingJobKind("quality_audit");
const JOB = "projects/acme/locations/europe-west1/jobs/caelo-production-audit-run";
const ORDER: JobOrder = {
  version: "0.12.0",
  kind: "quality_audit",
  subjectId: "00000000-0000-4000-8000-000000001359",
  attempt: 1,
  token: "t".repeat(43),
};

afterEach(() => setInProcessJobLauncher(null));

describe("launcherFor", () => {
  it("self-hosted and development run in the admin's process, once the admin registered it", () => {
    expect(launcherFor(def, { CAELO_PROVIDER: "self-hosted" }).kind).toBe("none");
    expect(launcherFor(def, {}).kind).toBe("none");
    setInProcessJobLauncher((kind) => ({ label: `in-process ${kind}`, launch: async () => "x" }));
    const chosen = launcherFor(def, { CAELO_PROVIDER: "self-hosted" });
    expect(chosen.kind).toBe("launcher");
    if (chosen.kind === "launcher") expect(chosen.launcher.label).toBe("in-process quality_audit");
  });

  it("a cloud install never runs a job in the admin, even when in-process is registered", () => {
    setInProcessJobLauncher(() => ({ label: "in-process", launch: async () => "x" }));
    const chosen = launcherFor(def, {
      CAELO_PROVIDER: "gcp",
      CAELO_AUDIT_RUNNER_JOB: JOB,
      CAELO_ADMIN_URL: "https://admin.acme.com",
    });
    expect(chosen.kind).toBe("launcher");
    if (chosen.kind === "launcher") {
      expect(chosen.launcher.label).toBe("Cloud Run job caelo-production-audit-run");
    }
  });

  it("a Google Cloud admin without the job's env says to converge", () => {
    for (const env of [
      { CAELO_PROVIDER: "gcp-firebase", CAELO_ADMIN_URL: "https://a.run.app" },
      { CAELO_PROVIDER: "gcp", CAELO_AUDIT_RUNNER_JOB: JOB },
    ]) {
      const chosen = launcherFor(def, env);
      expect(chosen.kind).toBe("unavailable");
      if (chosen.kind === "unavailable") {
        expect(chosen.message).toContain("CAELO_AUDIT_RUNNER_JOB");
        expect(chosen.message).toContain("cms-provision upgrade");
      }
    }
  });

  it("aws and azure refuse with their tracking issue", () => {
    for (const [provider, issue] of [
      ["aws", "#749"],
      ["azure", "#750"],
    ] as const) {
      const chosen = launcherFor(def, { CAELO_PROVIDER: provider });
      expect(chosen.kind).toBe("unavailable");
      if (chosen.kind === "unavailable") {
        expect(chosen.message).toContain(issue);
        expect(chosen.message).toContain("never run inside the admin");
      }
    }
  });
});

describe("gcpReportingJobLauncher", () => {
  function google(answer: unknown): GoogleDeps & { calls: { url: string; body: unknown }[] } {
    const calls: { url: string; body: unknown }[] = [];
    return {
      calls,
      metadata: async () => "",
      accessToken: async () => "token",
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify(answer));
      }) as unknown as typeof fetch,
    };
  }

  it("starts one execution with the order and the admin's origin as its env, under the kind's timeout", async () => {
    const g = google({ metadata: { name: `${JOB}/executions/caelo-production-audit-run-x1` } });
    const launcher = gcpReportingJobLauncher("quality_audit", JOB, "https://admin.acme.com/", g);
    expect(await launcher.launch(ORDER)).toBe(`${JOB}/executions/caelo-production-audit-run-x1`);
    const call = g.calls[0] as { url: string; body: { overrides: Record<string, unknown> } };
    expect(call.url).toBe(`https://run.googleapis.com/v2/${JOB}:run`);
    const overrides = call.body.overrides;
    expect(overrides.taskCount).toBe(1);
    expect(overrides.timeout).toBe("3600s");
    const env = (overrides.containerOverrides as { env: { name: string; value: string }[] }[])[0]
      ?.env;
    expect(env?.map((e) => e.name)).toEqual([JOB_ORDER_ENV_VAR]);
    const sent = jobOrderSchema.parse(JSON.parse(env?.[0]?.value ?? "{}"));
    expect(sent).toEqual({ ...ORDER, adminUrl: "https://admin.acme.com" });
  });

  it("fails loudly when Cloud Run names no execution, or the job name is not one", async () => {
    const launcher = gcpReportingJobLauncher(
      "quality_audit",
      JOB,
      "https://admin.acme.com",
      google({}),
    );
    await expect(launcher.launch(ORDER)).rejects.toThrow(/no execution name/);
    expect(() =>
      gcpReportingJobLauncher(
        "quality_audit",
        "caelo-production-audit-run",
        "https://admin.acme.com",
      ),
    ).toThrow();
    expect(() => gcpReportingJobLauncher("quality_audit", JOB, "http://admin.acme.com")).toThrow();
  });
});

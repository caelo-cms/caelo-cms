// SPDX-License-Identifier: MPL-2.0

/**
 * preview-plan.ts against an engine event stream in the shape
 * `stack.preview({ onEvent })` delivers (#737): one planned step per
 * resource, replace sub-steps folded in, bookkeeping dropped, and every
 * data-bearing replace or delete named.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, OpType } from "@pulumi/pulumi/automation";
import {
  collectPreviewSteps,
  formatPlan,
  hasReplaceOrDelete,
  losesData,
  type PlannedStep,
  planGate,
  writePlanFile,
} from "./preview-plan.js";

const URN = "urn:pulumi:production::caelo-gcp-firebase::";
let sequence = 0;

/** A `resourcePreEvent` as the engine sends it. */
function pre(
  op: OpType,
  type: string,
  name: string,
  extra: { diffs?: string[]; keys?: string[] } = {},
): EngineEvent {
  return {
    sequence: sequence++,
    timestamp: 1_760_000_000,
    resourcePreEvent: {
      metadata: {
        op,
        urn: `${URN}${type}::${name}`,
        type,
        provider: `${URN}pulumi:providers:gcp::default_8_10_0::04da6b54`,
        ...extra,
      },
    },
  };
}

/** A preview of a drifted gcp-firebase install, as recorded from the engine. */
const RECORDED: EngineEvent[] = [
  { sequence: sequence++, timestamp: 1_760_000_000, preludeEvent: { config: {} } },
  pre("same", "pulumi:pulumi:Stack", "caelo-gcp-firebase-production"),
  pre("create", "pulumi:providers:gcp", "default_8_10_0"),
  pre("refresh", "gcp:run/v2Service:V2Service", "caelo-production-admin"),
  pre("same", "gcp:run/v2Service:V2Service", "caelo-production-admin"),
  pre("update", "gcp:cloudrunv2/service:Service", "caelo-production-gateway", {
    diffs: ["template", "ingress"],
  }),
  pre("create", "gcp:projects/iAMMember:IAMMember", "admin-run-invoker"),
  pre("replace", "gcp:sql/databaseInstance:DatabaseInstance", "caelo-production-pg", {
    diffs: ["region", "settings"],
    keys: ["region"],
  }),
  pre("create-replacement", "gcp:sql/databaseInstance:DatabaseInstance", "caelo-production-pg", {
    keys: ["region"],
  }),
  pre("delete-replaced", "gcp:sql/databaseInstance:DatabaseInstance", "caelo-production-pg"),
  pre("delete", "gcp:storage/bucket:Bucket", "caelo-production-media"),
  pre("replace", "gcp:secretmanager/secret:Secret", "caelo-production-postgres-password", {
    keys: ["replication"],
  }),
  pre("delete", "gcp:firebase/project:Project", "firebase"),
  pre("delete", "gcp:compute/firewall:Firewall", "allow-health-checks"),
  pre("read", "gcp:organizations/getProject:getProject", "project"),
  {
    sequence: sequence++,
    timestamp: 1_760_000_001,
    summaryEvent: {
      maybeCorrupt: false,
      durationSeconds: 12,
      resourceChanges: { same: 2, update: 1, create: 1, replace: 2, delete: 3 },
      policyPacks: {},
    },
  },
];

function recordedPlan(): PlannedStep[] {
  const c = collectPreviewSteps();
  for (const e of RECORDED) c.onEvent(e);
  return c.steps();
}

describe("collectPreviewSteps", () => {
  it("one step per changed resource; same, refresh, read, providers and the stack drop out", () => {
    const steps = recordedPlan();
    expect(steps.map((s) => `${s.op} ${s.name}`)).toEqual([
      "update caelo-production-gateway",
      "create admin-run-invoker",
      "replace caelo-production-pg",
      "delete caelo-production-media",
      "replace caelo-production-postgres-password",
      "delete firebase",
      "delete allow-health-checks",
    ]);
  });

  it("a replace keeps why it is replaced; its sub-steps do not overwrite it", () => {
    const sql = recordedPlan().find((s) => s.name === "caelo-production-pg");
    expect(sql).toEqual({
      op: "replace",
      type: "gcp:sql/databaseInstance:DatabaseInstance",
      name: "caelo-production-pg",
      urn: `${URN}gcp:sql/databaseInstance:DatabaseInstance::caelo-production-pg`,
      diffs: ["region", "settings"],
      replaceReasons: ["region"],
    });
  });
});

describe("losesData", () => {
  it("flags the Cloud SQL instance, a bucket, a secret and the Firebase project", () => {
    const lost = recordedPlan()
      .filter(losesData)
      .map((s) => s.type);
    expect(lost).toEqual([
      "gcp:sql/databaseInstance:DatabaseInstance",
      "gcp:storage/bucket:Bucket",
      "gcp:secretmanager/secret:Secret",
      "gcp:firebase/project:Project",
    ]);
  });

  it("an in-place update or a create of a data-bearing resource loses nothing", () => {
    const step = (op: PlannedStep["op"]): PlannedStep => ({
      op,
      type: "gcp:sql/databaseInstance:DatabaseInstance",
      name: "pg",
      urn: "u",
      diffs: [],
      replaceReasons: [],
    });
    expect(losesData(step("update"))).toBe(false);
    expect(losesData(step("create"))).toBe(false);
    expect(losesData(step("delete"))).toBe(true);
  });

  it("a firewall delete is a delete, but not data loss", () => {
    const fw = recordedPlan().find((s) => s.name === "allow-health-checks");
    expect(fw && losesData(fw)).toBe(false);
    expect(hasReplaceOrDelete(recordedPlan())).toBe(true);
    expect(hasReplaceOrDelete(recordedPlan().filter((s) => s.op === "update"))).toBe(false);
  });
});

describe("formatPlan", () => {
  it("groups destructive steps first and names what each data loss destroys", () => {
    expect(formatPlan(recordedPlan())).toEqual([
      "DELETES (3):",
      "  gcp:storage/bucket:Bucket caelo-production-media  <-- LOSES DATA: Cloud Storage bucket (media, published site or state)",
      "  gcp:firebase/project:Project firebase  <-- LOSES DATA: Firebase project",
      "  gcp:compute/firewall:Firewall allow-health-checks",
      "REPLACES (delete + create) (2):",
      "  gcp:sql/databaseInstance:DatabaseInstance caelo-production-pg (replaced because region changes)  <-- LOSES DATA: Cloud SQL instance (all site data)",
      "  gcp:secretmanager/secret:Secret caelo-production-postgres-password (replaced because replication changes)  <-- LOSES DATA: Secret Manager secret",
      "Updates in place (1):",
      "  gcp:cloudrunv2/service:Service caelo-production-gateway (template, ingress)",
      "Creates (1):",
      "  gcp:projects/iAMMember:IAMMember admin-run-invoker",
      "",
      "4 of these would destroy data: Cloud SQL instance (all site data) caelo-production-pg; Cloud Storage bucket (media, published site or state) caelo-production-media; Secret Manager secret caelo-production-postgres-password; Firebase project firebase.",
    ]);
  });

  it("an empty plan says so", () => {
    expect(formatPlan([])).toEqual(["The preview plans no changes."]);
  });
});

describe("writePlanFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caelo-plan-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes every step with its URN and changed properties, mode 600", () => {
    const path = writePlanFile(dir, "installer", recordedPlan(), new Date("2026-10-21T10:00:00Z"));
    expect(path).toBe(join(dir, "plan-installer-2026-10-21T10-00-00-000Z.txt"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("7 change(s)");
    expect(text).toContain(
      `- replace ${URN}gcp:sql/databaseInstance:DatabaseInstance::caelo-production-pg\n    replaced because: region\n    changes: region, settings`,
    );
  });
});

describe("planGate", () => {
  const only = (pred: (s: PlannedStep) => boolean) => recordedPlan().filter(pred);
  const typed = (type: string) => only((s) => s.type === type);

  it.each([
    ["the Cloud SQL instance", "gcp:sql/databaseInstance:DatabaseInstance"],
    ["a bucket", "gcp:storage/bucket:Bucket"],
    ["a secret", "gcp:secretmanager/secret:Secret"],
    ["the Firebase project", "gcp:firebase/project:Project"],
  ])("replacing or deleting %s needs an explicit yes no flag can give", (_name, type) => {
    const steps = typed(type);
    expect(steps).toHaveLength(1);
    expect(planGate(steps, { interactive: true })).toEqual({ kind: "confirm", losesData: true });
    expect(planGate(steps, { interactive: false })).toEqual({ kind: "refuse" });
  });

  it("a replace or delete without data is asked about, and goes ahead unattended", () => {
    const steps = only((s) => s.name === "allow-health-checks");
    expect(planGate(steps, { interactive: true })).toEqual({ kind: "confirm", losesData: false });
    expect(planGate(steps, { interactive: false })).toEqual({ kind: "proceed" });
  });

  it("creates and updates only: no question", () => {
    const steps = only((s) => s.op === "create" || s.op === "update");
    expect(planGate(steps, { interactive: true })).toEqual({ kind: "proceed" });
    expect(planGate([], { interactive: false })).toEqual({ kind: "proceed" });
  });
});

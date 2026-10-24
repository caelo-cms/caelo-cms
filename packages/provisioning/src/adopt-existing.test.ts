// SPDX-License-Identifier: MPL-2.0

/**
 * adopt-existing.ts (#1079) against fake gcloud and Pulumi runners, on the
 * plan viu.one's installer re-run produced: a stack converged by `upgrade`
 * through gcloud plans to create service accounts that exist already. They
 * are imported, the re-plan no longer creates them; anything that doesn't
 * exist, any other kind and any failure is handled as the file comment says.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent } from "@pulumi/pulumi/automation";
import {
  type AdoptionCandidate,
  AdoptionError,
  adoptExistingResources,
  adoptionCandidates,
  formatAdopted,
} from "./adopt-existing.js";
import type { GcloudResult } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { gatewayServiceAccountId, MCP_IAP_SERVICE_ACCOUNT_ID } from "./gcp-names.js";
import { collectPreviewSteps, type PlannedOp, type PlannedStep } from "./preview-plan.js";
import { stackGcpProviderUrn } from "./wizards/gcp-pulumi.js";

const PROJECT = "viu-one-web";
const SA = "gcp:serviceaccount/account:Account";
const PROVIDER_URN =
  "urn:pulumi:production::caelo-gcp-firebase::pulumi:providers:gcp::caelo-production-gcp";

/**
 * The inputs the gcp-firebase stack declares for the creates in the fixture
 * (the plan file lists names only): the two service accounts as
 * stacks/gcp-firebase/index.ts declares them, IAM members with a role.
 */
function declaredInputs(type: string, name: string): Record<string, unknown> {
  if (name === "caelo-production-gateway-sa") {
    return {
      accountId: gatewayServiceAccountId("production"),
      displayName: "Caelo production gateway",
      createIgnoreAlreadyExists: true,
    };
  }
  if (name === "caelo-production-mcp-sa") {
    return {
      project: PROJECT,
      accountId: MCP_IAP_SERVICE_ACCOUNT_ID,
      displayName: "Caelo MCP (IAP ingress)",
      createIgnoreAlreadyExists: true,
    };
  }
  return { role: "roles/secretmanager.secretAccessor", type };
}

/**
 * The "Every step:" section of the real viu.one plan (preview-plan.ts
 * writePlanFile, 2026-10-24; the Owner's email in one resource name replaced)
 * as the planned steps the preview produced.
 */
function viuOnePlan(): PlannedStep[] {
  const text = readFileSync(
    join(import.meta.dir, "__tests__/fixtures/viu-one-plan-state-migrate.txt"),
    "utf8",
  );
  const body = text.slice(text.indexOf("Every step:"));
  const steps: PlannedStep[] = [];
  for (const line of body.split("\n")) {
    const step = /^- (\w+) (urn:\S+)$/.exec(line);
    if (step) {
      const urn = step[2] as string;
      const [, , type, name] = urn.split("::") as [string, string, string, string];
      const op = step[1] as PlannedOp;
      steps.push({
        op,
        type,
        name,
        urn,
        diffs: [],
        replaceReasons: [],
        ...(op === "create" ? { inputs: declaredInputs(type, name) } : {}),
      });
      continue;
    }
    const changes = /^ {4}changes: (.+)$/.exec(line);
    const last = steps.at(-1);
    if (changes && last) {
      steps[steps.length - 1] = { ...last, diffs: (changes[1] as string).split(", ") };
    }
  }
  return steps;
}

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** gcloud with these service-account emails in the project; every call recorded. */
function fakeGcloud(existing: readonly string[], other: Record<string, string> = {}) {
  const calls: string[][] = [];
  const run: GcloudRunner = async (args) => {
    calls.push(args);
    const email = args[3] ?? "";
    if (args.slice(0, 3).join(" ") !== "iam service-accounts describe") {
      return fail(`unexpected gcloud ${args.join(" ")}`);
    }
    if (other[email]) return fail(other[email] as string);
    return existing.includes(email)
      ? ok(email)
      : fail("ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Unknown service account.");
  };
  return { run, calls };
}

/**
 * A stack whose preview is `plan`, minus the creates `pulumi import` took
 * into its state (an imported account shows as an update of the
 * Terraform-only `createIgnoreAlreadyExists`, which import cannot read).
 */
function fakePulumi(plan: readonly PlannedStep[], opts: { importFails?: boolean } = {}) {
  const imported = new Set<string>();
  const imports: { type: string; name: string; id: string }[][] = [];
  let previews = 0;
  let ups = 0;
  return {
    imports,
    get previews() {
      return previews;
    },
    get ups() {
      return ups;
    },
    up: () => {
      ups++;
    },
    preview: async (): Promise<readonly PlannedStep[]> => {
      previews++;
      return plan.map((s) =>
        s.op === "create" && imported.has(s.urn)
          ? {
              op: "update" as const,
              type: s.type,
              name: s.name,
              urn: s.urn,
              diffs: ["createIgnoreAlreadyExists"],
              replaceReasons: [],
            }
          : s,
      );
    },
    importResources: async (cs: readonly AdoptionCandidate[]) => {
      if (opts.importFails) {
        throw new Error(
          "code: 255\n stderr: error: Preview failed: resource 'projects/x' does not exist",
        );
      }
      imports.push(cs.map((c) => ({ type: c.step.type, name: c.step.name, id: c.importId })));
      for (const c of cs) imported.add(c.step.urn);
    },
  };
}

const GATEWAY_EMAIL = `caelo-production-gateway-sa@${PROJECT}.iam.gserviceaccount.com`;
const MCP_EMAIL = `caelo-mcp@${PROJECT}.iam.gserviceaccount.com`;

/** The installer's order (wizards/gcp-pulumi.ts pulumiUpGcp): adopt, review, up. */
async function installerRun(
  plan: readonly PlannedStep[],
  gcloud: GcloudRunner,
  pulumi: ReturnType<typeof fakePulumi>,
) {
  const result = await adoptExistingResources(plan, {
    projectId: PROJECT,
    gcloud,
    preview: pulumi.preview,
    importResources: pulumi.importResources,
  });
  pulumi.up();
  return result;
}

describe("adoptExistingResources — viu.one's installer re-run (#1079)", () => {
  it("the fixture is the real plan: 8 deletes, 15 updates, 14 creates", () => {
    const plan = viuOnePlan();
    const count = (op: PlannedOp) => plan.filter((s) => s.op === op).length;
    expect([count("delete"), count("update"), count("create")]).toEqual([8, 15, 14]);
  });

  it("imports the service accounts upgrade made; the re-plan creates neither", async () => {
    const plan = viuOnePlan();
    const gcloud = fakeGcloud([GATEWAY_EMAIL, MCP_EMAIL]);
    const pulumi = fakePulumi(plan);
    const { adopted, steps } = await installerRun(plan, gcloud.run, pulumi);

    expect(pulumi.imports).toEqual([
      [
        {
          type: SA,
          name: "caelo-production-gateway-sa",
          id: `projects/${PROJECT}/serviceAccounts/${GATEWAY_EMAIL}`,
        },
        {
          type: SA,
          name: "caelo-production-mcp-sa",
          id: `projects/${PROJECT}/serviceAccounts/${MCP_EMAIL}`,
        },
      ],
    ]);
    expect(adopted.map((c) => c.display)).toEqual([GATEWAY_EMAIL, MCP_EMAIL]);
    expect(steps.filter((s) => s.op === "create" && s.type === SA)).toEqual([]);
    // The IAM members stay creates (idempotent), the retired-secret deletes stay.
    expect(steps.filter((s) => s.op === "create")).toHaveLength(12);
    expect(steps.filter((s) => s.op === "delete")).toHaveLength(8);
    expect(pulumi.previews).toBe(1);
    expect(pulumi.ups).toBe(1);
    // Only the two service accounts were probed: no IAM member, no other kind.
    expect(gcloud.calls.map((a) => a[3])).toEqual([GATEWAY_EMAIL, MCP_EMAIL]);
    expect(gcloud.calls[0]).toEqual([
      "iam",
      "service-accounts",
      "describe",
      GATEWAY_EMAIL,
      `--project=${PROJECT}`,
      "--format=value(email)",
    ]);
  });

  it("shows what it adopted", async () => {
    const plan = viuOnePlan();
    const { adopted } = await installerRun(plan, fakeGcloud([GATEWAY_EMAIL]).run, fakePulumi(plan));
    expect(formatAdopted(adopted)).toEqual([
      "Adopted (1) — already in the project, now in the stack instead of created again:",
      `  service account ${GATEWAY_EMAIL} (caelo-production-gateway-sa)`,
    ]);
    expect(formatAdopted([])).toEqual([]);
  });

  it("a service account that does not exist stays a plain create, and nothing is imported", async () => {
    const plan = viuOnePlan();
    const pulumi = fakePulumi(plan);
    const { adopted, steps } = await installerRun(plan, fakeGcloud([]).run, pulumi);
    expect(adopted).toEqual([]);
    expect(steps).toBe(plan);
    expect(pulumi.imports).toEqual([]);
    expect(pulumi.previews).toBe(0);
    expect(steps.filter((s) => s.op === "create" && s.type === SA)).toHaveLength(2);
  });

  it("adopts only what exists: one of the two", async () => {
    const plan = viuOnePlan();
    const pulumi = fakePulumi(plan);
    const { steps } = await installerRun(plan, fakeGcloud([MCP_EMAIL]).run, pulumi);
    expect(pulumi.imports.flat().map((i) => i.name)).toEqual(["caelo-production-mcp-sa"]);
    expect(steps.filter((s) => s.op === "create" && s.type === SA).map((s) => s.name)).toEqual([
      "caelo-production-gateway-sa",
    ]);
  });

  it("an import failure stops the run loudly with a next step: no re-plan, no up", async () => {
    const plan = viuOnePlan();
    const pulumi = fakePulumi(plan, { importFails: true });
    const run = installerRun(plan, fakeGcloud([GATEWAY_EMAIL]).run, pulumi);
    await expect(run).rejects.toBeInstanceOf(AdoptionError);
    await expect(run).rejects.toThrow(
      `could not adopt service account ${GATEWAY_EMAIL} (already in the project) into the stack: pulumi import says "error: Preview failed: resource 'projects/x' does not exist". Nothing was applied. Re-run the installer`,
    );
    expect(pulumi.previews).toBe(0);
    expect(pulumi.ups).toBe(0);
  });

  it("a probe that fails for another reason than NOT_FOUND stops the run before any import", async () => {
    const plan = viuOnePlan();
    const pulumi = fakePulumi(plan);
    const gcloud = fakeGcloud([], {
      [GATEWAY_EMAIL]: "ERROR: (gcloud.iam.service-accounts.describe) PERMISSION_DENIED",
    });
    const run = installerRun(plan, gcloud.run, pulumi);
    await expect(run).rejects.toThrow(
      `could not tell whether the service account ${GATEWAY_EMAIL} exists (gcloud: ERROR: (gcloud.iam.service-accounts.describe) PERMISSION_DENIED). Nothing was imported or applied.`,
    );
    expect(pulumi.imports).toEqual([]);
    expect(pulumi.ups).toBe(0);
  });

  it("a re-plan that still creates an adopted resource stops the run", async () => {
    const plan = viuOnePlan();
    const pulumi = fakePulumi(plan);
    const run = adoptExistingResources(plan, {
      projectId: PROJECT,
      gcloud: fakeGcloud([GATEWAY_EMAIL]).run,
      preview: async () => plan,
      importResources: pulumi.importResources,
    });
    await expect(run).rejects.toThrow(
      "but the next preview still creates caelo-production-gateway-sa. Nothing was applied.",
    );
  });
});

describe("adoptionCandidates — only declared creates of an adoptable kind", () => {
  const step = (over: Partial<PlannedStep> & Pick<PlannedStep, "type" | "name">): PlannedStep => ({
    op: "create",
    urn: `urn:pulumi:production::caelo-gcp::${over.type}::${over.name}`,
    diffs: [],
    replaceReasons: [],
    inputs: {},
    ...over,
  });

  it("leaves unknown and non-adoptable kinds, IAM members, updates and unnamed creates to Pulumi", () => {
    const steps = [
      step({ type: "gcp:storage/bucket:Bucket", name: "media", inputs: { name: "x-media" } }),
      step({ type: "gcp:secretmanager/secret:Secret", name: "kek", inputs: { secretId: "k" } }),
      step({ type: "gcp:cloudrunv2/job:Job", name: "job", inputs: { name: "j" } }),
      step({ type: "gcp:projects/iAMMember:IAMMember", name: "m", inputs: { role: "r" } }),
      step({ type: "acme:widget:Widget", name: "w", inputs: { accountId: "a" } }),
      step({ type: SA, name: "updated", op: "update", inputs: { accountId: "a" } }),
      step({ type: SA, name: "no-inputs", inputs: undefined }),
      step({ type: SA, name: "computed-id", inputs: { accountId: undefined } }),
      step({ type: SA, name: "elsewhere", inputs: { accountId: "a", project: "other-project" } }),
    ];
    expect(adoptionCandidates(steps, PROJECT)).toEqual([]);
  });

  it("names a service account by its accountId in the install's project", () => {
    const [c] = adoptionCandidates(
      [step({ type: SA, name: "run", inputs: { accountId: "r" } })],
      PROJECT,
    );
    expect(c?.importId).toBe(
      `projects/${PROJECT}/serviceAccounts/r@${PROJECT}.iam.gserviceaccount.com`,
    );
    expect(c?.label).toBe("service account");
  });
});

describe("preview steps carry a create's inputs for adoption", () => {
  it("keeps the inputs of creates only", () => {
    const c = collectPreviewSteps();
    const event = (op: "create" | "update", name: string): EngineEvent => ({
      sequence: 1,
      timestamp: 1_760_000_000,
      resourcePreEvent: {
        metadata: {
          op,
          urn: `urn:pulumi:production::caelo-gcp::${SA}::${name}`,
          type: SA,
          provider: PROVIDER_URN,
          new: {
            type: SA,
            urn: `urn:pulumi:production::caelo-gcp::${SA}::${name}`,
            id: "",
            parent: "",
            provider: PROVIDER_URN,
            inputs: { accountId: name },
            outputs: {},
          },
        },
      },
    });
    c.onEvent(event("create", "a"));
    c.onEvent(event("update", "b"));
    const [created, updated] = c.steps();
    expect(created?.inputs).toEqual({ accountId: "a" });
    expect(updated?.inputs).toBeUndefined();
  });
});

describe("stackGcpProviderUrn — what adopted resources are imported under", () => {
  it("is the state's one GCP provider", () => {
    expect(
      stackGcpProviderUrn([
        { type: "pulumi:pulumi:Stack", urn: "urn:stack" },
        { type: "pulumi:providers:gcp", urn: PROVIDER_URN },
      ]),
    ).toBe(PROVIDER_URN);
  });

  it("refuses none or several", () => {
    expect(() => stackGcpProviderUrn([])).toThrow(AdoptionError);
    expect(() =>
      stackGcpProviderUrn([
        { type: "pulumi:providers:gcp", urn: PROVIDER_URN },
        { type: "pulumi:providers:gcp", urn: `${PROVIDER_URN}-2` },
      ]),
    ).toThrow("holds 2 GCP providers");
  });
});

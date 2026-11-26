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
  existingCandidates,
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

/** A planned create (or `over.op`) of `over.type` named `over.name`. */
const step = (over: Partial<PlannedStep> & Pick<PlannedStep, "type" | "name">): PlannedStep => ({
  op: "create",
  urn: `urn:pulumi:production::caelo-gcp::${over.type}::${over.name}`,
  diffs: [],
  replaceReasons: [],
  inputs: {},
  ...over,
});

describe("adoptionCandidates — only declared creates of an adoptable kind", () => {
  it("leaves unknown and non-adoptable kinds, IAM members, updates and unnamed creates to Pulumi", () => {
    const steps = [
      step({ type: "gcp:storage/bucket:Bucket", name: "media", inputs: { name: "x-media" } }),
      step({ type: "gcp:secretmanager/secret:Secret", name: "kek", inputs: { secretId: "k" } }),
      step({ type: "gcp:cloudrunv2/job:Job", name: "job", inputs: { name: "j" } }),
      step({ type: "gcp:projects/iAMMember:IAMMember", name: "m", inputs: { role: "r" } }),
      step({ type: "acme:widget:Widget", name: "w", inputs: { accountId: "a" } }),
      step({ type: SA, name: "updated", op: "update", inputs: { accountId: "caelo-run" } }),
      step({ type: SA, name: "no-inputs", inputs: undefined }),
      step({ type: SA, name: "computed-id", inputs: { accountId: undefined } }),
      step({
        type: SA,
        name: "unknown-id",
        inputs: { accountId: "04da6b54-80e4-46f7-96ec-b56ff0331ba9" },
      }),
      step({
        type: SA,
        name: "elsewhere",
        inputs: { accountId: "caelo-run", project: "other-project" },
      }),
    ];
    expect(adoptionCandidates(steps, PROJECT)).toEqual([]);
  });

  it("names a service account by its accountId in the install's project", () => {
    const [c] = adoptionCandidates(
      [step({ type: SA, name: "run", inputs: { accountId: "caelo-run" } })],
      PROJECT,
    );
    expect(c?.importId).toBe(
      `projects/${PROJECT}/serviceAccounts/caelo-run@${PROJECT}.iam.gserviceaccount.com`,
    );
    expect(c?.label).toBe("service account");
  });

  it("#1328 — names an explicitly named Cloud Run service (the data gateway) and only such", () => {
    const SERVICE = "gcp:cloudrunv2/service:Service";
    const [c, ...rest] = adoptionCandidates(
      [
        step({
          type: SERVICE,
          name: "caelo-production-data-gateway",
          inputs: { name: "caelo-production-data-gateway", location: "europe-west1" },
        }),
        // Auto-named services (the admin, the proxy) have no name to look up.
        step({
          type: SERVICE,
          name: "caelo-production-admin",
          inputs: { location: "europe-west1" },
        }),
        step({
          type: SERVICE,
          name: "elsewhere",
          inputs: { name: "x-svc", location: "europe-west1", project: "other-project" },
        }),
      ],
      PROJECT,
    );
    expect(rest).toEqual([]);
    expect(c?.label).toBe("Cloud Run service");
    expect(c?.importId).toBe(
      `projects/${PROJECT}/locations/europe-west1/services/caelo-production-data-gateway`,
    );
    expect(c?.describeArgs).toEqual([
      "run",
      "services",
      "describe",
      "caelo-production-data-gateway",
      "--region=europe-west1",
      `--project=${PROJECT}`,
      "--format=value(metadata.name)",
    ]);
  });

  it("#1329 — names the staging database and its login the converge creates, and nothing else of Cloud SQL", () => {
    const instance = "caelo-production-pg-1a2b3c";
    const candidates = adoptionCandidates(
      [
        step({
          type: "gcp:sql/database:Database",
          name: "caelo-production-cms-public-staging",
          inputs: { instance, name: "cms_public_staging" },
        }),
        step({
          type: "gcp:sql/user:User",
          name: "caelo-production-public-staging-user",
          inputs: { instance, name: "public_staging_role", password: "[secret]" },
        }),
        // Pulumi's own: never adopted.
        step({
          type: "gcp:sql/database:Database",
          name: "caelo-production-cms-public",
          inputs: { instance, name: "cms_public" },
        }),
        step({
          type: "gcp:sql/user:User",
          name: "caelo-production-public-user",
          inputs: { instance, name: "public_role" },
        }),
      ],
      PROJECT,
    );
    expect(candidates.map((c) => [c.label, c.importId])).toEqual([
      [
        "Cloud SQL database",
        `projects/${PROJECT}/instances/${instance}/databases/cms_public_staging`,
      ],
      ["Cloud SQL user", `${PROJECT}/${instance}/public_staging_role`],
    ]);
    expect(candidates[1]?.describeArgs).toEqual([
      "sql",
      "users",
      "describe",
      "public_staging_role",
      `--instance=${instance}`,
      `--project=${PROJECT}`,
      "--format=value(name)",
    ]);
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

describe("existingCandidates — every gcloud wording for a missing resource", () => {
  // gcp-firebase scratch install of v0.11.15 (2026-11-04): Cloud Run says
  // "Cannot find service [<name>]." with no NOT_FOUND code, and the probe read
  // that as an unknown state and stopped a fresh install.
  it("a Cloud Run service gcloud cannot find is a plain create, not a stop", async () => {
    const candidates = adoptionCandidates(
      [
        step({
          type: "gcp:cloudrunv2/service:Service",
          name: "caelo-production-gateway",
          inputs: { name: "caelo-production-gateway-aa7db32", location: "europe-west1" },
        }),
      ],
      PROJECT,
    );
    const existing = await existingCandidates(candidates, async () =>
      fail(
        "ERROR: (gcloud.run.services.describe) Cannot find service [caelo-production-gateway-aa7db32]",
      ),
    );
    expect(candidates).toHaveLength(1);
    expect(existing).toEqual([]);
  });
});

/**
 * A resumed install whose first run stopped before its Cloud SQL instance
 * existed. The stack below is what the gcp and gcp-firebase stacks declare
 * around the database, in dependency order. `pulumiUpGcp` previews and
 * adopts only when the stack's state holds resources: the first run `up`s an
 * empty stack and stops at the instance (a failed peering or instance
 * create, a killed run); the second previews what is left, adopts, and `up`s.
 */
describe("a resumed install whose first run stopped before the Cloud SQL instance existed", () => {
  const INSTANCE = "caelo-production-pg-5e1f0a2";
  const INSTANCE_TYPE = "gcp:sql/databaseInstance:DatabaseInstance";
  const DATABASE = "gcp:sql/database:Database";
  const USER = "gcp:sql/user:User";
  const declared: readonly PlannedStep[] = [
    step({ type: SA, name: "caelo-production-gateway-sa", inputs: { accountId: "caelo-gw" } }),
    step({ type: "gcp:compute/network:Network", name: "caelo-production-vpc", inputs: {} }),
    // Auto-named: the preview carries the name the create will use.
    step({ type: INSTANCE_TYPE, name: "caelo-production-pg", inputs: { name: INSTANCE } }),
    step({
      type: DATABASE,
      name: "caelo-production-cms-admin",
      inputs: { instance: INSTANCE, name: "cms_admin" },
    }),
    step({
      type: DATABASE,
      name: "caelo-production-cms-public-staging",
      inputs: { instance: INSTANCE, name: "cms_public_staging" },
    }),
    step({
      type: USER,
      name: "caelo-production-public-staging-user",
      inputs: { instance: INSTANCE, name: "public_staging_role", password: "[secret]" },
    }),
  ];
  const input = (s: PlannedStep, key: string) => String(s.inputs?.[key]);

  /** The project as Google Cloud answers about it; every call recorded. */
  function fakeProject() {
    const accounts = new Set<string>();
    /** Instance name → its `databases:<name>` and `users:<name>`. */
    const instances = new Map<string, Set<string>>();
    const calls: string[][] = [];
    const run: GcloudRunner = async (args) => {
      calls.push(args);
      const verb = args.slice(0, 3).join(" ");
      if (verb === "iam service-accounts describe") {
        return accounts.has(args[3] ?? "")
          ? ok(args[3])
          : fail(
              "ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Unknown service account.",
            );
      }
      if (verb === "sql instances list") return ok([...instances.keys()].join("\n"));
      if (verb === "sql databases describe" || verb === "sql users describe") {
        const on = instances.get(args.find((a) => a.startsWith("--instance="))?.slice(11) ?? "");
        // What the Cloud SQL Admin API answers for anything on an instance
        // that does not exist: 403, not 404.
        if (!on) {
          return fail(
            `ERROR: (gcloud.sql.${args[1]}.describe) HTTPError 403: The client is not authorized to make this request.`,
          );
        }
        return on.has(`${args[1]}:${args[3]}`)
          ? ok(args[3])
          : fail(`ERROR: (gcloud.sql.${args[1]}.describe) HTTPError 404: Not Found`);
      }
      return fail(`unexpected gcloud ${args.join(" ")}`);
    };
    return { run, calls, accounts, instances };
  }

  /** The stack: its state, a preview of what is left, and an `up` that can stop at a resource. */
  function fakeStack(project: ReturnType<typeof fakeProject>) {
    const state = new Set<string>();
    const created: string[] = [];
    const preview = async (): Promise<readonly PlannedStep[]> =>
      declared.filter((s) => !state.has(s.urn));
    const up = (stopAt?: string) => {
      for (const s of declared) {
        if (state.has(s.urn)) continue;
        if (s.name === stopAt) throw new Error(`creating ${s.name} failed`);
        if (s.type === SA) {
          project.accounts.add(`${input(s, "accountId")}@${PROJECT}.iam.gserviceaccount.com`);
        } else if (s.type === INSTANCE_TYPE) {
          project.instances.set(input(s, "name"), new Set());
        } else if (s.type === DATABASE || s.type === USER) {
          const on = project.instances.get(input(s, "instance"));
          if (!on) throw new Error(`${s.name}: its instance does not exist`);
          on.add(`${s.type === DATABASE ? "databases" : "users"}:${input(s, "name")}`);
        }
        state.add(s.urn);
        created.push(s.name);
      }
    };
    const importResources = async (cs: readonly AdoptionCandidate[]) => {
      for (const c of cs) state.add(c.step.urn);
    };
    return { state, created, preview, up, importResources };
  }

  /** One installer pass in pulumiUpGcp's order. */
  async function installerPass(
    project: ReturnType<typeof fakeProject>,
    stack: ReturnType<typeof fakeStack>,
    stopAt?: string,
  ) {
    const adopted =
      stack.state.size > 0
        ? (
            await adoptExistingResources(await stack.preview(), {
              projectId: PROJECT,
              gcloud: project.run,
              preview: stack.preview,
              importResources: stack.importResources,
            })
          ).adopted
        : [];
    stack.up(stopAt);
    return adopted;
  }

  it("the second run creates the instance and everything on it instead of stopping at Cloud SQL's 403", async () => {
    const project = fakeProject();
    const stack = fakeStack(project);
    await expect(installerPass(project, stack, "caelo-production-pg")).rejects.toThrow(
      "creating caelo-production-pg failed",
    );
    expect(project.instances.size).toBe(0);
    expect(stack.created).toEqual(["caelo-production-gateway-sa", "caelo-production-vpc"]);

    const adopted = await installerPass(project, stack);
    expect(adopted).toEqual([]);
    expect([...(project.instances.get(INSTANCE) ?? [])].sort()).toEqual([
      "databases:cms_admin",
      "databases:cms_public_staging",
      "users:public_staging_role",
    ]);
    // Nothing on the missing instance was asked about: the instances were
    // listed once, and none of them was it.
    const sql = project.calls.filter((a) => a[0] === "sql").map((a) => a.slice(0, 3).join(" "));
    expect(sql).toEqual(["sql instances list"]);
  });

  it("the staging database and login a converge made on an existing instance are still adopted (#1329)", async () => {
    const project = fakeProject();
    const stack = fakeStack(project);
    await expect(
      installerPass(project, stack, "caelo-production-cms-public-staging"),
    ).rejects.toThrow("failed");
    // Made since by `upgrade` through gcloud (staging-database.ts).
    project.instances.get(INSTANCE)?.add("databases:cms_public_staging");
    project.instances.get(INSTANCE)?.add("users:public_staging_role");

    const adopted = await installerPass(project, stack);
    expect(adopted.map((c) => c.display)).toEqual([
      `cms_public_staging (${INSTANCE})`,
      `public_staging_role (${INSTANCE})`,
    ]);
    expect(stack.created).not.toContain("caelo-production-cms-public-staging");
  });

  it("a permission 403 on listing the instances stays loud, with the next step", async () => {
    const candidates = adoptionCandidates(declared, PROJECT);
    const run: GcloudRunner = async (args) =>
      args.slice(0, 3).join(" ") === "sql instances list"
        ? fail(
            "ERROR: (gcloud.sql.instances.list) HTTPError 403: The client is not authorized to make this request.",
          )
        : fail("ERROR: NOT_FOUND");
    const probe = existingCandidates(candidates, run);
    await expect(probe).rejects.toBeInstanceOf(AdoptionError);
    await expect(probe).rejects.toThrow(
      `could not list the Cloud SQL instances of ${PROJECT} (gcloud: ERROR: (gcloud.sql.instances.list) HTTPError 403`,
    );
    await expect(probe).rejects.toThrow("needs cloudsql.instances.list on the project");
  });

  it("a 403 about a database on an instance that exists stays loud", async () => {
    const project = fakeProject();
    project.instances.set(INSTANCE, new Set());
    const run: GcloudRunner = async (args) =>
      args[0] === "sql" && args[2] === "describe"
        ? fail("ERROR: (gcloud.sql.databases.describe) HTTPError 403: PERMISSION_DENIED")
        : project.run(args);
    await expect(existingCandidates(adoptionCandidates(declared, PROJECT), run)).rejects.toThrow(
      `could not tell whether the Cloud SQL database cms_public_staging (${INSTANCE}) exists`,
    );
  });
});

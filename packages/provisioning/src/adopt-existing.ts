// SPDX-License-Identifier: MPL-2.0

/**
 * Adopt cloud resources the stack declares but its Pulumi state lacks
 * (#1079), before the installer's `pulumi up`.
 *
 * `cms-provision upgrade` converges an install through gcloud and never runs
 * Pulumi (stack-converge.ts), so it creates some resources the stack also
 * declares — the gateway's service account (runtime-secrets.ts), the MCP
 * service account (mcp-iap.ts) — without them entering the state. The next
 * installer run then plans to CREATE them, and `state migrate` refuses an
 * install whose preview plans anything. So, after the preview and before
 * the review:
 *
 *   1. {@link adoptionCandidates}: the planned creates of a kind in
 *      {@link ADOPTABLE_KINDS} whose inputs name the cloud resource. Only
 *      planned steps are looked at, so nothing the stack does not declare is
 *      ever adopted; every other kind is left to Pulumi.
 *   2. {@link existingCandidates}: a gcloud describe per candidate. Exists →
 *      adopt; NOT_FOUND → a plain create; anything else stops the run (we
 *      can't tell, and guessing either way is wrong).
 *   3. `pulumi import` of the existing ones into the stack, under the
 *      stack's explicit GCP provider (wizards/gcp-pulumi.ts). State only: the
 *      cloud resources are not touched.
 *   4. A second preview: what the review shows and `up` applies. An adopted
 *      resource that is still planned as a create stops the run.
 *
 * Why service accounts, since #1338 the Cloud SQL private DNS zone and its
 * record (cloudsql-tls.ts creates both on upgrade), and since #1328
 * explicitly named Cloud Run services — {@link ADOPTABLE_KINDS}. A kind is adopted
 * when the stack declares it AND the CLI also creates it through gcloud, and
 * its name is unique in the project. Checked per kind against both stacks:
 *
 *   - Secret Manager secrets: the stack declares only `postgres-password` and
 *     `secret-kek`, which the CLI never creates; the secrets the CLI makes
 *     (stack-contract.ts CLI_GENERATED_SECRETS) the stack only references by
 *     id. Adopting a secret without its value resource would also make `up`
 *     add a version with a freshly generated value — a new KEK.
 *   - Cloud Run services: only the ones the stack names explicitly (#1328:
 *     the gcp-firebase data gateway, which the converge creates on older
 *     installs); the auto-named admin and proxy are Pulumi's alone.
 *   - Buckets, Cloud Run jobs, custom roles: the stack's buckets are made by
 *     Pulumi alone; the CLI's own (ops, audit results, the upgrader, converge,
 *     audit and operator-access jobs, their custom roles) are not declared.
 *   - The admin's Cloud Run domain mapping: owned by `admin-domain enable`
 *     (admin-domain.ts), the stack's copy stays off; Pulumi, running as the
 *     provisioner, could not manage it.
 *   - IAM member resources (`*IamMember`, `IAMMember`): non-authoritative.
 *     Their create is a read-modify-write that merges the member into the
 *     policy and succeeds when it is there already, so a planned create of
 *     one is an adoption already.
 *   - Cloud SQL databases and users: only the staging database
 *     `cms_public_staging` and its login `public_staging_role` (#1329), which
 *     the converge creates on installs from before them (staging-database.ts).
 *     Every other one is Pulumi's alone: the CLI's other users are IAM users
 *     named after service accounts, the stack's the built-in `admin_role` /
 *     `public_role`.
 */

import type { GcloudRunner } from "./gcloud-retry.js";
import type { PlannedStep } from "./preview-plan.js";
import { STAGING_DATABASE, STAGING_DATABASE_ROLE } from "./staging-database.js";

/** The cloud identity of a resource a planned create would make. */
export interface AdoptionTarget {
  /** How the operator knows it, e.g. the service account's email. */
  readonly display: string;
  /** gcloud args that succeed exactly when it exists. */
  readonly describeArgs: readonly string[];
  /** The id `pulumi import` takes for the kind. */
  readonly importId: string;
}

/** A resource kind the installer adopts when it exists already. */
export interface AdoptableKind {
  /** What it is, for messages (`service account`). */
  readonly label: string;
  /**
   * The resource a create with these inputs would make, or null when the
   * inputs don't pin it down (then the create is left to Pulumi).
   */
  target(inputs: Readonly<Record<string, unknown>>, projectId: string): AdoptionTarget | null;
}

/** The Cloud SQL objects the converge creates that the stack declares too (#1329). */
const CONVERGE_CREATED_SQL = { database: STAGING_DATABASE, user: STAGING_DATABASE_ROLE } as const;

/** Kinds adopted before `up`, by Pulumi type token. See the file comment for the rest. */
export const ADOPTABLE_KINDS: Readonly<Record<string, AdoptableKind>> = {
  "gcp:serviceaccount/account:Account": {
    label: "service account",
    target(inputs, projectId) {
      // GCP's account-id format; also keeps out the engine's placeholder
      // for a value only known after apply.
      const accountId = inputs.accountId;
      if (typeof accountId !== "string" || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(accountId)) {
        return null;
      }
      // Unset means the provider's project, which is the install's
      // (assertStackProject). Another project is never adopted.
      const project = inputs.project ?? projectId;
      if (project !== projectId) return null;
      const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
      return {
        display: email,
        describeArgs: [
          "iam",
          "service-accounts",
          "describe",
          email,
          `--project=${projectId}`,
          "--format=value(email)",
        ],
        importId: `projects/${projectId}/serviceAccounts/${email}`,
      };
    },
  },
  // #1338 — the private zone + A record that resolve the Cloud SQL
  // instance's DNS name in the VPC. `cms-provision upgrade` creates both
  // through gcloud (cloudsql-tls.ts) on installs that predate them; the
  // stacks declare them with literal names so the preview pins them down.
  "gcp:dns/managedZone:ManagedZone": {
    label: "private DNS zone",
    target(inputs, projectId) {
      const name = inputs.name;
      if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(name)) return null;
      if ((inputs.project ?? projectId) !== projectId) return null;
      return {
        display: name,
        describeArgs: [
          "dns",
          "managed-zones",
          "describe",
          name,
          `--project=${projectId}`,
          "--format=value(name)",
        ],
        importId: `projects/${projectId}/managedZones/${name}`,
      };
    },
  },
  "gcp:dns/recordSet:RecordSet": {
    label: "DNS record",
    target(inputs, projectId) {
      const { managedZone: zone, name, type } = inputs;
      if (typeof zone !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(zone)) return null;
      if (typeof name !== "string" || !/^[a-z0-9.-]{1,253}\.$/.test(name)) return null;
      if (typeof type !== "string" || !/^[A-Z]{1,10}$/.test(type)) return null;
      if ((inputs.project ?? projectId) !== projectId) return null;
      return {
        display: `${name} ${type}`,
        describeArgs: [
          "dns",
          "record-sets",
          "describe",
          name,
          `--zone=${zone}`,
          `--type=${type}`,
          `--project=${projectId}`,
          "--format=value(name)",
        ],
        importId: `projects/${projectId}/managedZones/${zone}/rrsets/${name}/${type}`,
      };
    },
  },
  // #1328 — the gcp-firebase data gateway: the stack declares it under a
  // fixed name (stack-contract.ts fixedCloudRunServiceName), and the converge
  // creates the same service on installs whose stack predates it. Only a
  // service the stack names explicitly is a candidate: an auto-named one has
  // no name until Pulumi picks it.
  "gcp:cloudrunv2/service:Service": {
    label: "Cloud Run service",
    target(inputs, projectId) {
      const name = inputs.name;
      const location = inputs.location;
      if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,47}[a-z0-9]$/.test(name)) return null;
      if (typeof location !== "string" || !/^[a-z]+-[a-z]+\d+$/.test(location)) return null;
      const project = inputs.project ?? projectId;
      if (project !== projectId) return null;
      return {
        display: `${name} (${location})`,
        describeArgs: [
          "run",
          "services",
          "describe",
          name,
          `--region=${location}`,
          `--project=${projectId}`,
          "--format=value(metadata.name)",
        ],
        importId: `projects/${projectId}/locations/${location}/services/${name}`,
      };
    },
  },
  // #1329 — the staging database and its login: created by the converge on
  // an install whose stack predates them (staging-database.ts), declared by
  // the stack with literal names. Only those two names are candidates.
  "gcp:sql/database:Database": {
    label: "Cloud SQL database",
    target(inputs, projectId) {
      const { instance, name } = inputs;
      if (name !== CONVERGE_CREATED_SQL.database) return null;
      if (typeof instance !== "string" || !/^[a-z][a-z0-9-]{0,97}$/.test(instance)) return null;
      if ((inputs.project ?? projectId) !== projectId) return null;
      return {
        display: `${name} (${instance})`,
        describeArgs: [
          "sql",
          "databases",
          "describe",
          name,
          `--instance=${instance}`,
          `--project=${projectId}`,
          "--format=value(name)",
        ],
        importId: `projects/${projectId}/instances/${instance}/databases/${name}`,
      };
    },
  },
  "gcp:sql/user:User": {
    label: "Cloud SQL user",
    target(inputs, projectId) {
      const { instance, name } = inputs;
      if (name !== CONVERGE_CREATED_SQL.user) return null;
      if (typeof instance !== "string" || !/^[a-z][a-z0-9-]{0,97}$/.test(instance)) return null;
      if ((inputs.project ?? projectId) !== projectId) return null;
      return {
        display: `${name} (${instance})`,
        describeArgs: [
          "sql",
          "users",
          "describe",
          name,
          `--instance=${instance}`,
          `--project=${projectId}`,
          "--format=value(name)",
        ],
        // The provider's import id for a Postgres built-in user.
        importId: `${projectId}/${instance}/${name}`,
      };
    },
  },
};

/** A planned create the installer may adopt instead. */
export interface AdoptionCandidate extends AdoptionTarget {
  readonly step: PlannedStep;
  readonly label: string;
}

/** Thrown when adoption cannot finish; nothing was applied. */
export class AdoptionError extends Error {
  override readonly name = "AdoptionError";
}

/** The planned creates of an adoptable kind, with what each would create. */
export function adoptionCandidates(
  steps: readonly PlannedStep[],
  projectId: string,
): AdoptionCandidate[] {
  const out: AdoptionCandidate[] = [];
  for (const step of steps) {
    if (step.op !== "create") continue;
    const kind = ADOPTABLE_KINDS[step.type];
    if (!kind || !step.inputs) continue;
    const target = kind.target(step.inputs, projectId);
    if (target) out.push({ ...target, step, label: kind.label });
  }
  return out;
}

const NOT_FOUND = /NOT_FOUND|not found|does not exist/i;

/**
 * The candidates that exist in the project.
 *
 * @throws AdoptionError when a describe fails for another reason than NOT_FOUND
 */
export async function existingCandidates(
  candidates: readonly AdoptionCandidate[],
  run: GcloudRunner,
): Promise<AdoptionCandidate[]> {
  const existing: AdoptionCandidate[] = [];
  for (const c of candidates) {
    const r = await run([...c.describeArgs]);
    if (r.ok) existing.push(c);
    else if (!NOT_FOUND.test(r.stderr)) {
      throw new AdoptionError(
        `could not tell whether the ${c.label} ${c.display} exists (gcloud: ${r.stderr.trim()}). Nothing was imported or applied. Check that gcloud is signed in as the Owner (gcloud auth login) and re-run the installer.`,
      );
    }
  }
  return existing;
}

/** What adoption needs from Pulumi and gcloud; fakes in tests. */
export interface AdoptionDeps {
  readonly projectId: string;
  readonly gcloud: GcloudRunner;
  /** A fresh preview of the stack. */
  preview(): Promise<readonly PlannedStep[]>;
  /** `pulumi import` the candidates into the stack (state only). */
  importResources(candidates: readonly AdoptionCandidate[]): Promise<void>;
}

/** The plan to review after adoption, and what was adopted into it. */
export interface AdoptionResult {
  readonly adopted: readonly AdoptionCandidate[];
  readonly steps: readonly PlannedStep[];
}

/**
 * The line of a failed Pulumi call that says what went wrong. The
 * Automation API's error starts with `code: 255` and carries the CLI's
 * stderr below; its first `error:` line is the reason.
 */
export function pulumiErrorReason(e: unknown): string {
  const lines = (e instanceof Error ? e.message : String(e))
    .split("\n")
    .map((l) => l.trim().replace(/^stderr:\s*/, ""))
    .filter((l) => l !== "");
  return lines.find((l) => /^error:/i.test(l)) ?? lines[0] ?? "no output";
}

/**
 * Adopt the planned creates of `steps` that exist in the project already,
 * and return the plan after it. With nothing to adopt, `steps` comes back
 * unchanged and nothing else runs.
 *
 * @throws AdoptionError when a probe or the import fails, or a re-plan still
 *   creates an adopted resource; `up` must not run then
 */
export async function adoptExistingResources(
  steps: readonly PlannedStep[],
  deps: AdoptionDeps,
): Promise<AdoptionResult> {
  const existing = await existingCandidates(adoptionCandidates(steps, deps.projectId), deps.gcloud);
  if (existing.length === 0) return { adopted: [], steps };
  const names = existing.map((c) => `${c.label} ${c.display}`).join(", ");
  try {
    await deps.importResources(existing);
  } catch (e) {
    throw new AdoptionError(
      `could not adopt ${names} (already in the project) into the stack: pulumi import says "${pulumiErrorReason(e)}". Nothing was applied. Re-run the installer: what was adopted stays adopted. If it fails the same way, report it with this message.`,
    );
  }
  const after = await deps.preview();
  const stillCreated = after.filter(
    (s) => s.op === "create" && existing.some((c) => c.step.urn === s.urn),
  );
  if (stillCreated.length > 0) {
    throw new AdoptionError(
      `imported ${names}, but the next preview still creates ${stillCreated.map((s) => s.name).join(", ")}. Nothing was applied. Report this with the message; re-running the installer does not fix it.`,
    );
  }
  return { adopted: existing, steps: after };
}

/** The adopted resources as lines for the review, or none. */
export function formatAdopted(adopted: readonly AdoptionCandidate[]): string[] {
  if (adopted.length === 0) return [];
  return [
    `Adopted (${adopted.length}) — already in the project, now in the stack instead of created again:`,
    ...adopted.map((c) => `  ${c.label} ${c.display} (${c.step.name})`),
  ];
}

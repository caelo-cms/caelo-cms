// SPDX-License-Identifier: MPL-2.0

/**
 * The upgrader job's IAM self-check (#818): before it takes the state lock
 * or changes anything, the job asks Google Cloud whether its own service
 * account holds every permission the run will need, and stops with ALL the
 * missing ones named when it does not.
 *
 * Why: the first live in-app update died at its first bucket write (#799)
 * because a grant that looked right could never match the call. Unit tests
 * against a fake gcloud cannot catch that class of bug; asking IAM can, and
 * asking first means a missing grant ends the run before the backup, the
 * migrations or the roll, with a reason a non-technical Owner can pass on
 * ("Run the upgrade once with Cloud Shell" re-converges the grants).
 *
 * How each permission is checked, without doing the action:
 *
 *   - `testIamPermissions` on the resource the call acts on — the project,
 *     a service account, the upgrader's own job, the ops bucket, the release
 *     image repository. Google returns the subset the CALLER holds; no
 *     permission is needed to ask.
 *   - The `install/` objects in the ops bucket are the exception. The
 *     upgrader's object rights there are an IAM grant CONDITIONED on the
 *     object name (upgrader-setup.ts `installStateCondition`), and a bucket's
 *     testIamPermissions evaluates conditions against the bucket's own
 *     resource name, never an object's — it would report a grant that works
 *     as missing (the mirror image of #799). Cloud Storage has no object
 *     testIamPermissions on uniform-access buckets, so those three are
 *     probed with requests that can never change anything: a read of an
 *     object that does not exist, and an upload + a delete preconditioned
 *     on generation 1, which no object ever has. Cloud Storage authorizes a
 *     request before it evaluates its preconditions, so 403 means the
 *     permission is missing and 404/412 means it is held — with one
 *     exception: a read of an absent object is answered 403 whenever the
 *     caller lacks storage.objects.list, so objects.get is probed only once
 *     the bucket check confirmed list, and reported "unchecked" otherwise.
 *
 * Direct VPC egress (#818): the migration job and both services are
 * deployed with `--network/--subnet`. Google documents the compute
 * permissions for that (`compute.subnetworks.use`, …) on the Cloud Run
 * SERVICE AGENT (roles/run.serviceAgent has them), not on the principal
 * that deploys, so they are not checked here and the upgrader gets no
 * compute role (UPGRADER_FORBIDDEN_ROLES). The real-GCP upgrader smoke test
 * (.github/workflows/upgrader-smoke.yml) is what proves that on every
 * release candidate.
 *
 * Everything here is pure except {@link restIamTester}, which takes its
 * HTTP client and token source as arguments.
 */

import { z } from "zod";
import {
  gatewayServiceAccountEmail,
  mcpIapServiceAccountEmail,
  runServiceAccountEmail,
  upgraderJobName,
  upgraderServiceAccountEmail,
} from "./gcp-names.js";
import type { HttpFetch } from "./runtime-secrets.js";
import { OPS_INSTALL_PREFIX, opsBucketName } from "./state-backend.js";
import { RELEASE_REGISTRY } from "./upgrade/release-images.js";

/** A resource IAM can be asked about. */
export type IamResource =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "service-account"; readonly projectId: string; readonly email: string }
  | {
      readonly kind: "run-job";
      readonly projectId: string;
      readonly region: string;
      readonly name: string;
    }
  | { readonly kind: "bucket"; readonly bucket: string }
  /** Objects under `prefix/` in `bucket`, behind a name-conditioned grant (probed). */
  | { readonly kind: "bucket-objects"; readonly bucket: string; readonly prefix: string }
  | {
      readonly kind: "artifact-repository";
      readonly projectId: string;
      readonly location: string;
      readonly repository: string;
    };

/** One thing the run will do, the permissions it takes, and where. */
export interface AccessCheck {
  /** What the upgrader could not do without them, in plain words. */
  readonly need: string;
  readonly resource: IamResource;
  readonly permissions: readonly string[];
}

/** A check with the permissions it lacks. */
export interface MissingAccess {
  readonly check: AccessCheck;
  readonly missing: readonly string[];
  /**
   * Permissions that could not be judged because another one is missing
   * first (storage.objects.get needs storage.objects.list to be testable).
   */
  readonly unchecked?: readonly string[];
}

/** The permissions IAM confirmed on one resource, or why it could not be asked. */
export type GrantedResult =
  | { readonly ok: true; readonly granted: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** Asks IAM which of `permissions` the job's identity holds on `resource`. */
export interface IamTester {
  granted(resource: IamResource, permissions: readonly string[]): Promise<GrantedResult>;
}

/** How the self-check came out. */
export type PreflightOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "missing"; readonly missing: readonly MissingAccess[] }
  /** IAM could not be asked about at least one resource; nothing was judged missing. */
  | { readonly kind: "error"; readonly errors: readonly string[] };

/** The object the `install/` probes name. It is never written: every probe fails its precondition. */
export const PREFLIGHT_PROBE_OBJECT = ".caelo-iam-preflight";

/**
 * Every permission an upgrader run needs after its decision, grouped by
 * what it is for (upgrade/app-roll.ts, migration-runner.ts, backup.ts,
 * health.ts, state-store.ts, the self-update in upgrader-job.ts). Keep in
 * step with the grants in upgrader-setup.ts: a permission listed here that
 * setup does not grant stops every update.
 */
export function upgraderAccessChecks(target: {
  readonly projectId: string;
  readonly region: string;
  readonly env: string;
}): AccessCheck[] {
  const { projectId, region, env } = target;
  const project: IamResource = { kind: "project", projectId };
  const sa = (email: string): IamResource => ({ kind: "service-account", projectId, email });
  const bucket = opsBucketName(projectId);
  return [
    {
      need: "read which release the site's admin and gateway serve",
      resource: project,
      permissions: [
        "run.services.get",
        "run.services.list",
        "run.revisions.get",
        "run.revisions.list",
      ],
    },
    {
      need: "deploy the new release to the admin and gateway and move their traffic",
      resource: project,
      permissions: ["run.services.update", "run.operations.get"],
    },
    {
      need: "run the database migrations as a one-off job (and check whether an earlier run still holds the install's lock)",
      resource: project,
      permissions: [
        "run.jobs.create",
        "run.jobs.delete",
        "run.jobs.get",
        "run.jobs.run",
        "run.executions.get",
      ],
    },
    {
      need: "back up the database before anything changes",
      resource: project,
      permissions: [
        "cloudsql.backupRuns.create",
        "cloudsql.backupRuns.get",
        "cloudsql.backupRuns.list",
        "cloudsql.instances.get",
        "cloudsql.instances.list",
      ],
    },
    {
      need: "run the admin and the migration job as the admin's service account",
      resource: sa(runServiceAccountEmail(projectId, env)),
      permissions: ["iam.serviceAccounts.actAs"],
    },
    {
      need: "run the gateway as its service account",
      resource: sa(gatewayServiceAccountEmail(projectId, env)),
      permissions: ["iam.serviceAccounts.actAs"],
    },
    {
      need: "keep the upgrader job running as its own service account after it updates itself",
      resource: sa(upgraderServiceAccountEmail(projectId, env)),
      permissions: ["iam.serviceAccounts.actAs"],
    },
    {
      need: "sign in to the admin (through its identity proxy) for the health check",
      resource: sa(mcpIapServiceAccountEmail(projectId)),
      permissions: ["iam.serviceAccounts.signJwt"],
    },
    {
      need: "move the upgrader itself onto the new release",
      resource: { kind: "run-job", projectId, region, name: upgraderJobName(env) },
      permissions: ["run.jobs.get", "run.jobs.update"],
    },
    {
      need: "list the install's ops bucket (every write there lists it first)",
      resource: { kind: "bucket", bucket },
      permissions: ["storage.objects.list"],
    },
    {
      need: `read and write the install's records and its state lock (${OPS_INSTALL_PREFIX}/ in the ops bucket)`,
      resource: { kind: "bucket-objects", bucket, prefix: OPS_INSTALL_PREFIX },
      permissions: ["storage.objects.get", "storage.objects.create", "storage.objects.delete"],
    },
    {
      need: "read Caelo's release images",
      resource: {
        kind: "artifact-repository",
        projectId: RELEASE_REGISTRY.project,
        location: RELEASE_REGISTRY.region,
        repository: RELEASE_REGISTRY.repo,
      },
      permissions: ["artifactregistry.repositories.downloadArtifacts"],
    },
  ];
}

/** Ask IAM about every check (one call per resource); never throws. */
export async function runIamPreflight(
  checks: readonly AccessCheck[],
  tester: IamTester,
): Promise<PreflightOutcome> {
  // One question per resource: the project alone carries four checks.
  const byResource = new Map<string, { resource: IamResource; permissions: Set<string> }>();
  for (const c of checks) {
    const key = resourceName(c.resource);
    const entry = byResource.get(key) ?? { resource: c.resource, permissions: new Set<string>() };
    for (const p of c.permissions) entry.permissions.add(p);
    byResource.set(key, entry);
  }
  const granted = new Map<string, ReadonlySet<string>>();
  /** Permissions that could not be judged (see the object probes below). */
  const unverified = new Map<string, ReadonlySet<string>>();
  const errors: string[] = [];
  const ask = async (key: string, resource: IamResource, permissions: readonly string[]) => {
    let r: GrantedResult;
    try {
      r = await tester.granted(resource, [...permissions].sort());
    } catch (e) {
      r = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (r.ok) granted.set(key, new Set(r.granted));
    else errors.push(`${key}: ${r.error}`);
  };
  const entries = [...byResource];
  await Promise.all(
    entries
      .filter(([, e]) => e.resource.kind !== "bucket-objects")
      .map(([key, e]) => ask(key, e.resource, [...e.permissions])),
  );
  // The object probes go second: Cloud Storage answers a read of an absent
  // object with 403 — not 404 — when the caller lacks storage.objects.list
  // on the bucket, so the objects.get probe means something only once list
  // is confirmed. Without it, get is reported as unchecked, never missing.
  await Promise.all(
    entries
      .filter(([, e]) => e.resource.kind === "bucket-objects")
      .map(([key, e]) => {
        const r = e.resource as Extract<IamResource, { kind: "bucket-objects" }>;
        const listHeld =
          granted.get(resourceName({ kind: "bucket", bucket: r.bucket }))?.has(OBJECT_LIST) ??
          false;
        const asked = [...e.permissions].filter((p) => listHeld || p !== OBJECT_GET);
        if (asked.length < e.permissions.size) unverified.set(key, new Set([OBJECT_GET]));
        return ask(key, e.resource, asked);
      }),
  );
  if (errors.length > 0) return { kind: "error", errors: errors.sort() };
  const missing: MissingAccess[] = [];
  for (const check of checks) {
    const key = resourceName(check.resource);
    const held = granted.get(key) ?? new Set<string>();
    const unknown = unverified.get(key) ?? new Set<string>();
    const lacking = check.permissions.filter((p) => !held.has(p) && !unknown.has(p));
    const unchecked = check.permissions.filter((p) => unknown.has(p));
    if (lacking.length > 0 || unchecked.length > 0) {
      missing.push({ check, missing: lacking, ...(unchecked.length > 0 ? { unchecked } : {}) });
    }
  }
  return missing.length === 0 ? { kind: "ok" } : { kind: "missing", missing };
}

const OBJECT_LIST = "storage.objects.list";
const OBJECT_GET = "storage.objects.get";

/**
 * The request's end reason for missing permissions: every one of them, each
 * with what it is for, then the one next step.
 */
export function preflightMissingReason(missing: readonly MissingAccess[]): string {
  const lines = missing.map((m) => {
    const where = resourceName(m.check.resource);
    const parts = [
      ...(m.missing.length > 0 ? [`missing ${m.missing.join(", ")} on ${where}`] : []),
      ...(m.unchecked && m.unchecked.length > 0
        ? [
            `${m.unchecked.join(", ")} on ${where} could not be checked: without storage.objects.list Cloud Storage answers 403 for any absent object, held or not`,
          ]
        : []),
    ];
    return `it ${m.missing.length > 0 ? "cannot" : "may not be able to"} ${m.check.need} (${parts.join("; ")})`;
  });
  return `Nothing was changed: the upgrader checked its access before starting and is missing permissions this update needs — ${lines.join("; ")}. Run the upgrade once with Cloud Shell; it repairs the upgrader's access.`;
}

/** The request's end reason when IAM could not be asked. */
export function preflightErrorReason(errors: readonly string[]): string {
  return `Nothing was changed: the upgrader could not check its access before starting (${errors.join("; ")}). Try again in a few minutes; if it keeps failing, run the upgrade once with Cloud Shell.`;
}

/** A resource's full name, as IAM and the messages name it. */
export function resourceName(r: IamResource): string {
  switch (r.kind) {
    case "project":
      return `projects/${r.projectId}`;
    case "service-account":
      return `projects/${r.projectId}/serviceAccounts/${r.email}`;
    case "run-job":
      return `projects/${r.projectId}/locations/${r.region}/jobs/${r.name}`;
    case "bucket":
      return `gs://${r.bucket}`;
    case "bucket-objects":
      return `gs://${r.bucket}/${r.prefix}/`;
    case "artifact-repository":
      return `projects/${r.projectId}/locations/${r.location}/repositories/${r.repository}`;
  }
}

const testIamResponse = z.object({ permissions: z.array(z.string()).optional() });

/**
 * The real {@link IamTester}: Google's REST APIs with the job's own access
 * token. `token` is asked once per call (gcloud caches it).
 *
 * @example
 * const tester = restIamTester({ http: fetch, token: async () => "<access token>" });
 * await tester.granted({ kind: "project", projectId: "acme" }, ["run.services.get"]);
 */
export function restIamTester(deps: {
  readonly http: HttpFetch;
  readonly token: () => Promise<string>;
}): IamTester {
  return {
    async granted(resource, permissions) {
      const bearer = await deps.token();
      if (!bearer) return { ok: false, error: "no access token for the upgrader's account" };
      const auth = { Authorization: `Bearer ${bearer}` };
      if (resource.kind === "bucket-objects") {
        return probeObjects(deps.http, auth, resource, permissions);
      }
      const call = testIamCall(resource, permissions);
      const res = await deps.http(call.url, {
        method: call.method,
        headers: { ...auth, ...(call.body ? { "Content-Type": "application/json" } : {}) },
        ...(call.body ? { body: call.body } : {}),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${text.trim().slice(0, 300)}` };
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return { ok: false, error: "testIamPermissions answered without JSON" };
      }
      const parsed = testIamResponse.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: "testIamPermissions answered without a permission list" };
      }
      // An empty answer omits `permissions`: none of them is held.
      return { ok: true, granted: parsed.data.permissions ?? [] };
    },
  };
}

/** The testIamPermissions request for a resource that has one. */
export function testIamCall(
  resource: Exclude<IamResource, { kind: "bucket-objects" }>,
  permissions: readonly string[],
): { url: string; method: "GET" | "POST"; body?: string } {
  const body = JSON.stringify({ permissions });
  switch (resource.kind) {
    case "project":
      return {
        url: `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(resource.projectId)}:testIamPermissions`,
        method: "POST",
        body,
      };
    case "service-account":
      return {
        url: `https://iam.googleapis.com/v1/projects/${encodeURIComponent(resource.projectId)}/serviceAccounts/${encodeURIComponent(resource.email)}:testIamPermissions`,
        method: "POST",
        body,
      };
    case "run-job":
      return {
        url: `https://run.googleapis.com/v2/projects/${encodeURIComponent(resource.projectId)}/locations/${encodeURIComponent(resource.region)}/jobs/${encodeURIComponent(resource.name)}:testIamPermissions`,
        method: "POST",
        body,
      };
    case "bucket": {
      const q = permissions.map((p) => `permissions=${encodeURIComponent(p)}`).join("&");
      return {
        url: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(resource.bucket)}/iam/testPermissions?${q}`,
        method: "GET",
      };
    }
    case "artifact-repository":
      return {
        url: `https://artifactregistry.googleapis.com/v1/projects/${encodeURIComponent(resource.projectId)}/locations/${encodeURIComponent(resource.location)}/repositories/${encodeURIComponent(resource.repository)}:testIamPermissions`,
        method: "POST",
        body,
      };
  }
}

const OBJECT_PROBES: Record<
  string,
  { method: "GET" | "POST" | "DELETE"; held: readonly number[] }
> = {
  // A read of an object that does not exist: 404 once authorized.
  "storage.objects.get": { method: "GET", held: [404, 200] },
  // An upload that must match generation 1: never true, so 412 once authorized.
  "storage.objects.create": { method: "POST", held: [412] },
  // A delete that must match generation 1: 404 (absent) or 412 once authorized.
  "storage.objects.delete": { method: "DELETE", held: [404, 412] },
};

/** The precondition-guarded request that tests one object permission (see the file comment). */
export function objectProbeCall(
  resource: Extract<IamResource, { kind: "bucket-objects" }>,
  permission: string,
): { url: string; method: "GET" | "POST" | "DELETE" } | null {
  const probe = OBJECT_PROBES[permission];
  if (!probe) return null;
  const bucket = encodeURIComponent(resource.bucket);
  const object = encodeURIComponent(`${resource.prefix}/${PREFLIGHT_PROBE_OBJECT}`);
  switch (probe.method) {
    case "GET":
      return {
        url: `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}`,
        method: "GET",
      };
    case "POST":
      return {
        url: `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${object}&ifGenerationMatch=1`,
        method: "POST",
      };
    case "DELETE":
      return {
        url: `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}?ifGenerationMatch=1`,
        method: "DELETE",
      };
  }
}

async function probeObjects(
  http: HttpFetch,
  auth: Record<string, string>,
  resource: Extract<IamResource, { kind: "bucket-objects" }>,
  permissions: readonly string[],
): Promise<GrantedResult> {
  const granted: string[] = [];
  for (const permission of permissions) {
    const call = objectProbeCall(resource, permission);
    const probe = OBJECT_PROBES[permission];
    if (!call || !probe) {
      return { ok: false, error: `no probe for ${permission} on ${resourceName(resource)}` };
    }
    const res = await http(call.url, {
      method: call.method,
      headers:
        call.method === "POST" ? { ...auth, "Content-Type": "application/octet-stream" } : auth,
      ...(call.method === "POST" ? { body: "" } : {}),
    });
    const text = await res.text();
    if (probe.held.includes(res.status)) {
      // 200 on the upload would mean an object was written; held[] for
      // create has no 200, so that lands below as an error, loudly.
      granted.push(permission);
    } else if (res.status === 403) {
    } else {
      return {
        ok: false,
        error: `probing ${permission} on ${resourceName(resource)}: HTTP ${res.status} ${text.trim().slice(0, 300)}`,
      };
    }
  }
  return { ok: true, granted };
}

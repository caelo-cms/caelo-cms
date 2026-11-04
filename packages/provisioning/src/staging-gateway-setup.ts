// SPDX-License-Identifier: MPL-2.0

/**
 * #1330 — the staging gateway on Google Cloud: the live gateway's image with
 * `CAELO_GATEWAY_ENVIRONMENT=staging`, which serves the staged build from
 * the private staging bucket behind the staging gate, on every host
 * (`*.run.app` included), and staging's own data (`cms_public_staging`).
 * One shape on both providers (E11 of #763); only the edge in front of it
 * differs:
 *
 *   - `gcp-firebase` (E13 a): a second Firebase Hosting site with one `**`
 *     rewrite to the staging gateway, the staging host as that site's
 *     custom domain. The Cloud Run domain mapping that sent the staging
 *     host to the old gateway service (#650) is deleted: nothing may lead
 *     to the staged files but the gate.
 *   - `gcp`: the staging host gets its own host rule on the site's load
 *     balancer, routed in full to the staging gateway's serverless NEG and
 *     backend (the gateway's Cloud Armor policy as an extra layer, E3), and
 *     a managed certificate of its own, like the admin's.
 *
 * CLI-owned, like the audit and capture jobs: the stacks declare the
 * staging gateway's service account and its secret binding, everything
 * else is created here, by the wizard after the first `pulumi up` and by
 * every converge (`cms-provision upgrade`, the converge job), idempotently.
 * Split in two because the service must exist before the upgrade plans its
 * rolls ({@link ensureStagingGatewayService}, from ensureReleaseServices),
 * while the edge only routes traffic to it ({@link ensureStagingGatewayEdge},
 * later in the converge).
 *
 * The staging gateway's account reads the staging bucket and its own login
 * password, nothing else: no media, no static bucket, no gate key (the admin
 * publishes that to the staging database), no live database.
 */

import { createHash } from "node:crypto";
import {
  DB_PUBLIC_POOL_MAX_ENV,
  DEFAULT_STAGING_GATEWAY_MAX_INSTANCES,
  GATEWAY_POOL_MAX,
  isIpLiteral,
} from "@caelo-cms/shared";
import { gcloud as defaultGcloud, isGcloudNotFound } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import {
  firebaseStagingSiteId,
  gcpBucketName,
  gcpNamePrefix,
  gcpSecretId,
  runServiceAccountEmail,
  stagingGatewayEdgeNames,
  stagingGatewayServiceAccountEmail,
} from "./gcp-names.js";
import {
  type EnsureOutcome,
  ensureStagingGatewayServiceAccount,
  type HttpFetch,
} from "./runtime-secrets.js";
import {
  type CloudRunEnvVar,
  cloudRunServicePrefix,
  databaseUrls,
  fixedCloudRunServiceName,
  type GcpProvider,
  STAGING_GATEWAY_TIMEOUT_SECONDS,
  serviceSecrets,
  stagingGatewayEnvContract,
} from "./stack-contract.js";
import { listFlag, liveContainerEnv } from "./stack-converge.js";
import { lookupFailure, resolveGcpResourceName } from "./upgrade/gcp-lookup.js";

/** The install the staging gateway is set up on. */
export interface StagingGatewayTarget {
  readonly provider: GcpProvider;
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  readonly domain: string;
  /** The staging host (install.json `stagingDomain`, default `staging.<domain>`). */
  readonly stagingHost: string;
}

/** A DNS record the operator adds at their registrar for the staging host. */
export interface StagingDnsRecord {
  readonly name: string;
  readonly type: string;
  readonly value: string;
}

const ALREADY_EXISTS = /ALREADY_EXISTS|already exists|409/i;

/** The `gcp` staging host's managed certificate: the edge's prefix plus six hex of the host's SHA-256. */
export function stagingCertName(env: string, stagingHost: string): string {
  const hash = createHash("sha256").update(stagingHost.toLowerCase()).digest("hex").slice(0, 6);
  return `${stagingGatewayEdgeNames(env).cert}-${hash}`;
}

/** The staging gateway's Cloud Run service name (fixed on both providers). */
export function stagingGatewayServiceName(env: string): string {
  return fixedCloudRunServiceName("gcp", env, "staging-gateway") as string;
}

// ===========================================================================
// The service
// ===========================================================================

/** What {@link ensureStagingGatewayService} needs beyond the install. */
export interface StagingGatewayServiceInputs extends StagingGatewayTarget {
  /** The release's digest-pinned gateway image — the staging gateway runs it too. */
  readonly gatewayImageRef: string;
  /**
   * The Cloud SQL instance's DNS name (the host of the admin's
   * `ADMIN_DATABASE_URL`, #1338): its URLs must be verify-full.
   */
  readonly databaseHost: string;
  /** The live gateway's `run.googleapis.com/network-interfaces` (direct VPC egress). */
  readonly vpc: { readonly network: string; readonly subnetwork: string };
}

/**
 * The `gcloud run deploy` argv of a first staging gateway: the release's
 * gateway image, its env contract, direct VPC egress (it reaches the staging
 * database on Cloud SQL's private IP), request-based CPU, invokable without
 * a Google identity (the gate is the staging gateway's own, on every host),
 * load-balancer-only ingress on `gcp`, all on `gcp-firebase` (Hosting
 * rewrites arrive from Google's edge). Its scale-out is the one the
 * connection budget reserves for it ({@link DEFAULT_STAGING_GATEWAY_MAX_INSTANCES}:
 * staging is used by the team, not by visitors).
 */
export function stagingGatewayDeployArgs(inputs: StagingGatewayServiceInputs): string[] {
  const env: CloudRunEnvVar[] = stagingGatewayEnvContract({
    provider: inputs.provider,
    projectId: inputs.projectId,
    env: inputs.env,
    domain: inputs.domain,
    region: inputs.region,
    stagingHost: inputs.stagingHost,
    databaseUrls: databaseUrls(inputs.databaseHost),
  });
  const plain = [
    ...env.flatMap((e) => ("value" in e ? [`${e.name}=${e.value}`] : [])),
    // The connection budget's share of one instance (pool-budget.ts): the
    // stacks set the same on the live gateway.
    `${DB_PUBLIC_POOL_MAX_ENV}=${GATEWAY_POOL_MAX}`,
  ];
  const secrets = env.flatMap((e) =>
    "valueSource" in e
      ? [`${e.name}=${e.valueSource.secretKeyRef.secret}:${e.valueSource.secretKeyRef.version}`]
      : [],
  );
  return [
    "run",
    "deploy",
    stagingGatewayServiceName(inputs.env),
    `--image=${inputs.gatewayImageRef}`,
    `--region=${inputs.region}`,
    `--project=${inputs.projectId}`,
    `--service-account=${stagingGatewayServiceAccountEmail(inputs.projectId, inputs.env)}`,
    inputs.provider === "gcp" ? "--ingress=internal-and-cloud-load-balancing" : "--ingress=all",
    "--allow-unauthenticated",
    "--min-instances=0",
    `--max-instances=${DEFAULT_STAGING_GATEWAY_MAX_INSTANCES}`,
    "--cpu=1",
    "--memory=512Mi",
    "--cpu-throttling",
    `--timeout=${STAGING_GATEWAY_TIMEOUT_SECONDS}`,
    `--network=${inputs.vpc.network}`,
    `--subnet=${inputs.vpc.subnetwork}`,
    "--vpc-egress=private-ranges-only",
    listFlag("--set-env-vars", plain),
    listFlag("--set-secrets", secrets),
    "--quiet",
  ];
}

/**
 * The live gateway's direct VPC egress, to give the staging gateway the same
 * route to Cloud SQL's private IP (the stacks auto-name the network).
 *
 * @returns null when the service JSON has none
 */
export function liveVpcInterface(
  serviceJson: string,
): { readonly network: string; readonly subnetwork: string } | null {
  const svc = JSON.parse(serviceJson) as {
    spec?: { template?: { metadata?: { annotations?: Record<string, string> } } };
  };
  const raw = svc.spec?.template?.metadata?.annotations?.["run.googleapis.com/network-interfaces"];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { network?: string; subnetwork?: string }[];
    const first = parsed[0];
    return first?.network && first.subnetwork
      ? { network: first.network, subnetwork: first.subnetwork }
      : null;
  } catch {
    return null;
  }
}

/**
 * Everything the staging gateway service needs, created when missing, in an
 * order that never deploys something that cannot start: its account, its
 * secret access, the staging bucket (`gcp-firebase`: new, private, the admin
 * may write it) and its read access, then the service itself. Deployed
 * once; the app-roll moves it onto each release's gateway image after that.
 */
export async function ensureStagingGatewayService(
  inputs: StagingGatewayServiceInputs,
  deps: { readonly run?: GcloudRunner; readonly sleep?: Sleep } = {},
): Promise<EnsureOutcome[]> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const outcomes: EnsureOutcome[] = [];
  const account = await ensureStagingGatewayServiceAccount(inputs, { run });
  outcomes.push(account);
  if (account.status === "failed") return outcomes;
  const member = `serviceAccount:${stagingGatewayServiceAccountEmail(inputs.projectId, inputs.env)}`;
  for (const secret of serviceSecrets("staging-gateway")) {
    const id = `secretAccessor → staging gateway on ${secret}`;
    // The account may have been created a moment ago; IAM answers "does not
    // exist" until it has propagated, so this is retried, not failed.
    const r = await runWithRetry(run, sleep, [
      "secrets",
      "add-iam-policy-binding",
      gcpSecretId(inputs.env, secret),
      `--project=${inputs.projectId}`,
      `--member=${member}`,
      "--role=roles/secretmanager.secretAccessor",
      "--condition=None",
      "--quiet",
    ]);
    outcomes.push(
      r.ok ? { id, status: "present" } : { id, status: "failed", error: r.stderr.trim() },
    );
  }
  if (outcomes.some((o) => o.status === "failed")) return outcomes;
  outcomes.push(...(await ensureStagingBucket(inputs, member, run, sleep)));
  if (outcomes.some((o) => o.status === "failed")) return outcomes;
  outcomes.push(await ensureService(inputs, run));
  return outcomes;
}

/**
 * The staging bucket and who may use it. On `gcp` the stack has always
 * created it (Stage uploads there); on `gcp-firebase` it is new with #1330:
 * uniform access, public access prevention enforced, in the install's
 * region. The admin writes it (Stage's two build slots), the staging
 * gateway only reads it.
 */
async function ensureStagingBucket(
  t: StagingGatewayTarget,
  stagingMember: string,
  run: GcloudRunner,
  sleep: Sleep,
): Promise<EnsureOutcome[]> {
  const bucket = gcpBucketName(t.projectId, t.env, "staging");
  const url = `gs://${bucket}`;
  const outcomes: EnsureOutcome[] = [];
  if (t.provider === "gcp-firebase") {
    const id = `staging bucket ${url}`;
    const described = await run([
      "storage",
      "buckets",
      "describe",
      url,
      `--project=${t.projectId}`,
      "--format=value(name)",
    ]);
    if (described.ok) outcomes.push({ id, status: "present" });
    else if (!isGcloudNotFound(described.stderr)) {
      return [{ id, status: "failed", error: described.stderr.trim() }];
    } else {
      const created = await run([
        "storage",
        "buckets",
        "create",
        url,
        `--project=${t.projectId}`,
        `--location=${t.region}`,
        "--uniform-bucket-level-access",
        "--public-access-prevention",
        "--quiet",
      ]);
      if (!created.ok && !ALREADY_EXISTS.test(created.stderr)) {
        return [{ id, status: "failed", error: created.stderr.trim() }];
      }
      outcomes.push({ id, status: "applied", detail: "private, uniform access" });
    }
    outcomes.push(
      await bucketBinding(
        run,
        sleep,
        url,
        `serviceAccount:${runServiceAccountEmail(t.projectId, t.env)}`,
        "roles/storage.objectAdmin",
        "admin writes the staged build",
        t.projectId,
      ),
    );
  }
  outcomes.push(
    await bucketBinding(
      run,
      sleep,
      url,
      stagingMember,
      "roles/storage.objectViewer",
      "staging gateway reads the staged build",
      t.projectId,
    ),
  );
  return outcomes;
}

async function bucketBinding(
  run: GcloudRunner,
  sleep: Sleep,
  url: string,
  member: string,
  role: string,
  what: string,
  projectId: string,
): Promise<EnsureOutcome> {
  const id = `${role} on ${url} (${what})`;
  const r = await runWithRetry(run, sleep, [
    "storage",
    "buckets",
    "add-iam-policy-binding",
    url,
    `--project=${projectId}`,
    `--member=${member}`,
    `--role=${role}`,
    "--quiet",
  ]);
  return r.ok ? { id, status: "present" } : { id, status: "failed", error: r.stderr.trim() };
}

async function ensureService(
  inputs: StagingGatewayServiceInputs,
  run: GcloudRunner,
): Promise<EnsureOutcome> {
  const name = stagingGatewayServiceName(inputs.env);
  const id = `Cloud Run service ${name} (the staging gateway)`;
  const existing = await run([
    "run",
    "services",
    "describe",
    name,
    `--region=${inputs.region}`,
    `--project=${inputs.projectId}`,
    "--format=value(metadata.name)",
  ]);
  if (!existing.ok && !isGcloudNotFound(existing.stderr)) {
    return { id, status: "failed", error: existing.stderr.trim() };
  }
  if (!existing.ok) {
    const deployed = await run(stagingGatewayDeployArgs(inputs));
    if (!deployed.ok) return { id, status: "failed", error: deployed.stderr.trim() };
  }
  // Invokable without a Google identity: the staging gate is the gateway's
  // own and holds on every host (E8). Idempotent, ensured on every run.
  const invoker = await run([
    "run",
    "services",
    "add-iam-policy-binding",
    name,
    `--region=${inputs.region}`,
    `--project=${inputs.projectId}`,
    "--member=allUsers",
    "--role=roles/run.invoker",
    "--quiet",
  ]);
  if (!invoker.ok) {
    return { id, status: "failed", error: `allUsers run.invoker: ${invoker.stderr.trim()}` };
  }
  return existing.ok ? { id, status: "present" } : { id, status: "applied" };
}

/**
 * #1330 — the staging gateway (staging-gateway-setup.ts), with the live
 * gateway's route to Cloud SQL: its direct VPC egress and the database's DNS
 * name from its `PUBLIC_DATABASE_URL` (verify-full, #1338).
 */
export async function ensureStagingGatewayFromLiveGateway(
  target: StagingGatewayTarget & { readonly gatewayImageRef: string },
  deps: { readonly run?: GcloudRunner; readonly sleep?: Sleep } = {},
): Promise<EnsureOutcome[]> {
  const run = deps.run ?? defaultGcloud;
  const sleep = deps.sleep ?? realSleep;
  const id = "the staging gateway's route to the database";
  const prefix = cloudRunServicePrefix(target.provider, target.env, "gateway");
  const live = await resolveGcpResourceName(
    run,
    "run-service",
    prefix,
    target.projectId,
    target.region,
  );
  if (live.status !== "found") {
    return [
      {
        id,
        status: "failed",
        error: lookupFailure(live, `${prefix}* Cloud Run service`, "operator"),
      },
    ];
  }
  const described = await run([
    "run",
    "services",
    "describe",
    live.name,
    `--region=${target.region}`,
    `--project=${target.projectId}`,
    "--format=json",
  ]);
  if (!described.ok) {
    return [{ id, status: "failed", error: `describe ${live.name}: ${described.stderr.trim()}` }];
  }
  const vpc = liveVpcInterface(described.stdout);
  const url = liveContainerEnv(described.stdout).get("PUBLIC_DATABASE_URL");
  let host: string | null = null;
  try {
    host = url?.kind === "value" && url.value ? new URL(url.value).hostname : null;
  } catch {
    host = null;
  }
  if (!vpc || !host) {
    return [
      {
        id,
        status: "failed",
        error: `${live.name} has ${vpc ? "no PUBLIC_DATABASE_URL" : "no direct VPC egress"}, so the staging gateway's route to the database is unknown. Re-run the installer to restore the gateway, then upgrade again.`,
      },
    ];
  }
  if (isIpLiteral(host)) {
    return [
      {
        id,
        status: "failed",
        error: `${live.name} still dials the Cloud SQL instance's IP; the staging gateway connects with verify-full TLS, which needs the instance's DNS name (#1338). Install the release that moves the services onto it first (contract 15), then this one.`,
      },
    ];
  }
  return ensureStagingGatewayService(
    {
      provider: target.provider,
      projectId: target.projectId,
      region: target.region,
      env: target.env,
      domain: target.domain,
      stagingHost: target.stagingHost,
      gatewayImageRef: target.gatewayImageRef,
      databaseHost: host,
      vpc,
    },
    { run, sleep },
  );
}

// ===========================================================================
// The edge
// ===========================================================================

/** What {@link ensureStagingGatewayEdge} did. */
export type StagingEdgeResult =
  | {
      readonly ok: true;
      readonly done: string[];
      /** The records the staging host needs at the registrar (Settings → Updates shows them too). */
      readonly dnsRecords: StagingDnsRecord[];
    }
  | { readonly ok: false; readonly error: string; readonly done: string[] };

/** Dependencies of the edge step. */
export interface StagingEdgeDeps {
  readonly run?: GcloudRunner;
  readonly http?: HttpFetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Route the staging host to the staging gateway — and nowhere else. See the
 * module comment for the per-provider primitive.
 */
export async function ensureStagingGatewayEdge(
  t: StagingGatewayTarget,
  deps: StagingEdgeDeps = {},
): Promise<StagingEdgeResult> {
  return t.provider === "gcp-firebase"
    ? ensureFirebaseStagingSite(t, deps)
    : ensureGcpEdge(t, deps);
}

// --- gcp-firebase ----------------------------------------------------------

const FIREBASE_HOSTING_API = "https://firebasehosting.googleapis.com/v1beta1";

/** The config of the staging site's only version: every path to the staging gateway. */
export function firebaseStagingSiteConfig(t: Pick<StagingGatewayTarget, "env" | "region">): {
  readonly rewrites: readonly { glob: string; run: { serviceId: string; region: string } }[];
} {
  return {
    rewrites: [
      { glob: "**", run: { serviceId: stagingGatewayServiceName(t.env), region: t.region } },
    ],
  };
}

/** Whether a served version's config already is {@link firebaseStagingSiteConfig}. */
export function isFirebaseStagingConfig(
  config: unknown,
  t: Pick<StagingGatewayTarget, "env" | "region">,
): boolean {
  const want = firebaseStagingSiteConfig(t).rewrites;
  const rewrites = (config as { rewrites?: unknown[] } | null)?.rewrites;
  const redirects = (config as { redirects?: unknown[] } | null)?.redirects ?? [];
  const headers = (config as { headers?: unknown[] } | null)?.headers ?? [];
  return (
    Array.isArray(rewrites) &&
    rewrites.length === 1 &&
    JSON.stringify(rewrites[0]) === JSON.stringify(want[0]) &&
    redirects.length === 0 &&
    headers.length === 0
  );
}

/** The DNS records a Firebase custom domain asks for (`requiredDnsUpdates.desired`). */
export function firebaseDesiredRecords(customDomain: unknown): StagingDnsRecord[] {
  const desired = (
    customDomain as {
      requiredDnsUpdates?: {
        desired?: { records?: { domainName?: string; type?: string; rdata?: string }[] }[];
      };
    } | null
  )?.requiredDnsUpdates?.desired;
  return (desired ?? []).flatMap((set) =>
    (set.records ?? []).flatMap((r) =>
      r.domainName && r.type && r.rdata
        ? [{ name: r.domainName.replace(/\.$/, ""), type: r.type, value: r.rdata }]
        : [],
    ),
  );
}

async function ensureFirebaseStagingSite(
  t: StagingGatewayTarget,
  deps: StagingEdgeDeps,
): Promise<StagingEdgeResult> {
  const run = deps.run ?? defaultGcloud;
  const http = deps.http ?? (fetch as unknown as HttpFetch);
  const done: string[] = [];
  const fail = (error: string): StagingEdgeResult => ({ ok: false, error, done });
  const liveSite = await readAdminEnv(run, t, "CAELO_FIREBASE_SITE");
  if (!liveSite.ok) return fail(liveSite.error);
  const site = firebaseStagingSiteId(t.env, liveSite.value);
  const bearer = await accessToken(run);
  if (!bearer.ok) return fail(bearer.error);
  const headers = {
    Authorization: `Bearer ${bearer.token}`,
    "Content-Type": "application/json",
    // A user's token needs a quota project for the Firebase APIs.
    "X-Goog-User-Project": t.projectId,
  };
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; json: unknown; text: string }> => {
    const res = await http(`${FIREBASE_HOSTING_API}/${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  };
  const project = encodeURIComponent(t.projectId);

  // 1. The site.
  const existing = await call(`projects/${project}/sites/${site}`);
  if (existing.status === 404) {
    const created = await call(`projects/${project}/sites?siteId=${site}`, "POST", {});
    if (!created.ok && created.status !== 409) {
      return fail(
        `create Hosting site ${site}: HTTP ${created.status} ${created.text.slice(0, 300)}`,
      );
    }
    done.push(`created the staging Hosting site ${site}`);
  } else if (!existing.ok) {
    return fail(
      `read Hosting site ${site}: HTTP ${existing.status} ${existing.text.slice(0, 300)}`,
    );
  }

  // 2. Its one version: `**` → the staging gateway, released on its live channel.
  const released = await call(`sites/${site}/channels/live/releases?pageSize=1`);
  if (!released.ok && released.status !== 404) {
    return fail(`read ${site}'s release: HTTP ${released.status} ${released.text.slice(0, 300)}`);
  }
  const servedConfig = (released.json as { releases?: { version?: { config?: unknown } }[] } | null)
    ?.releases?.[0]?.version?.config;
  if (!isFirebaseStagingConfig(servedConfig, t)) {
    const version = await call(`sites/${site}/versions`, "POST", {
      config: firebaseStagingSiteConfig(t),
    });
    const name = (version.json as { name?: string } | null)?.name;
    if (!version.ok || !name) {
      return fail(
        `create a version of ${site}: HTTP ${version.status} ${version.text.slice(0, 300)}`,
      );
    }
    const versionId = name.split("/").pop() ?? "";
    const finalized = await call(`sites/${site}/versions/${versionId}?updateMask=status`, "PATCH", {
      status: "FINALIZED",
    });
    if (!finalized.ok) {
      return fail(`finalize ${name}: HTTP ${finalized.status} ${finalized.text.slice(0, 300)}`);
    }
    const release = await call(
      `sites/${site}/releases?versionName=${encodeURIComponent(name)}`,
      "POST",
      { message: "Caelo: the staging host is served by the staging gateway (#1330)" },
    );
    if (!release.ok) {
      return fail(`release ${name}: HTTP ${release.status} ${release.text.slice(0, 300)}`);
    }
    done.push(`released ${site}: every path → ${stagingGatewayServiceName(t.env)}`);
  }

  // 3. The staging host as its custom domain.
  const domainPath = `projects/${project}/sites/${site}/customDomains/${encodeURIComponent(t.stagingHost)}`;
  let domain = await call(domainPath);
  if (domain.status === 404) {
    const created = await call(
      `projects/${project}/sites/${site}/customDomains?customDomainId=${encodeURIComponent(t.stagingHost)}`,
      "POST",
      {},
    );
    if (!created.ok && created.status !== 409) {
      return fail(
        `add ${t.stagingHost} to ${site}: HTTP ${created.status} ${created.text.slice(0, 300)}`,
      );
    }
    done.push(`added ${t.stagingHost} as the custom domain of ${site}`);
    domain = await call(domainPath);
  }
  if (!domain.ok) {
    return fail(
      `read ${t.stagingHost} on ${site}: HTTP ${domain.status} ${domain.text.slice(0, 300)}`,
    );
  }

  // 4. The old route: the Cloud Run domain mapping (#650) to the service
  // that is now the MCP-Auth-Proxy. Nothing but the gate may lead to the
  // staged files, and the proxy no longer forwards (#1331).
  const mapping = await deleteStagingDomainMapping(t, run);
  if (!mapping.ok) return fail(mapping.error);
  if (mapping.deleted) done.push(`deleted the Cloud Run domain mapping of ${t.stagingHost}`);

  return { ok: true, done, dnsRecords: firebaseDesiredRecords(domain.json) };
}

/**
 * Delete the staging host's Cloud Run domain mapping (#650), if there is
 * one. Needs the gcloud `beta` component; without it the mapping is reported
 * as unknown rather than guessed away.
 */
async function deleteStagingDomainMapping(
  t: StagingGatewayTarget,
  run: GcloudRunner,
): Promise<{ ok: true; deleted: boolean } | { ok: false; error: string }> {
  const scope = [`--domain=${t.stagingHost}`, `--region=${t.region}`, `--project=${t.projectId}`];
  const described = await run([
    "beta",
    "run",
    "domain-mappings",
    "describe",
    ...scope,
    "--format=value(metadata.name)",
  ]);
  if (!described.ok) {
    if (isGcloudNotFound(described.stderr)) {
      return { ok: true, deleted: false };
    }
    return {
      ok: false,
      error: `read the Cloud Run domain mapping of ${t.stagingHost}: ${described.stderr.trim()}`,
    };
  }
  const deleted = await run(["beta", "run", "domain-mappings", "delete", ...scope, "--quiet"]);
  return deleted.ok
    ? { ok: true, deleted: true }
    : {
        ok: false,
        error: `delete the Cloud Run domain mapping of ${t.stagingHost}: ${deleted.stderr.trim()}`,
      };
}

async function readAdminEnv(
  run: GcloudRunner,
  t: StagingGatewayTarget,
  name: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const prefix = cloudRunServicePrefix(t.provider, t.env, "admin");
  const admin = await resolveGcpResourceName(run, "run-service", prefix, t.projectId, t.region);
  if (admin.status !== "found") {
    return { ok: false, error: lookupFailure(admin, `${prefix}* Cloud Run service`, "operator") };
  }
  const described = await run([
    "run",
    "services",
    "describe",
    admin.name,
    `--region=${t.region}`,
    `--project=${t.projectId}`,
    "--format=json",
  ]);
  if (!described.ok) {
    return { ok: false, error: `describe ${admin.name}: ${described.stderr.trim()}` };
  }
  let value: string | undefined;
  try {
    const v = liveContainerEnv(described.stdout).get(name);
    value = v?.kind === "value" ? v.value : undefined;
  } catch {
    return { ok: false, error: `describe ${admin.name}: output is not JSON` };
  }
  return value
    ? { ok: true, value }
    : { ok: false, error: `the admin service has no ${name}; run \`cms-provision upgrade\`` };
}

// --- gcp -------------------------------------------------------------------

/** The URL map's host rule + path matcher for the staging host, all paths to `backend`. */
export interface LiveUrlMap {
  readonly name: string;
  readonly hostRules?: { readonly hosts: string[]; readonly pathMatcher: string }[];
  readonly pathMatchers?: { readonly name: string; readonly defaultService?: string }[];
  readonly [field: string]: unknown;
}

/**
 * The URL map with the staging host routed in full to the staging gateway's
 * backend: its own host rule and path matcher ({@link stagingGatewayEdgeNames}),
 * every other host rule and matcher kept as it is. Null when it already is.
 *
 * @throws when the map has no host rule for the site (not this install's map)
 */
export function planStagingHostRule(
  map: LiveUrlMap,
  t: Pick<StagingGatewayTarget, "env" | "domain" | "stagingHost">,
  backend: string,
): LiveUrlMap | null {
  const { pathMatcher } = stagingGatewayEdgeNames(t.env);
  const host = t.stagingHost.toLowerCase();
  const rules = map.hostRules ?? [];
  const matchers = map.pathMatchers ?? [];
  const otherRules = rules
    .map((r) => ({ ...r, hosts: r.hosts.filter((h) => h.toLowerCase() !== host) }))
    .filter((r) => r.pathMatcher !== pathMatcher && r.hosts.length > 0);
  const current = rules.find((r) => r.pathMatcher === pathMatcher);
  const currentMatcher = matchers.find((m) => m.name === pathMatcher);
  const sameRule =
    current !== undefined &&
    current.hosts.length === 1 &&
    current.hosts[0]?.toLowerCase() === host &&
    otherRules.length === rules.length - 1;
  if (sameRule && currentMatcher?.defaultService === backend) return null;
  return {
    ...map,
    hostRules: [...otherRules, { hosts: [host], pathMatcher }],
    pathMatchers: [
      ...matchers.filter((m) => m.name !== pathMatcher),
      { name: pathMatcher, defaultService: backend },
    ],
  };
}

const COMPUTE_API = "https://compute.googleapis.com/compute/v1";
const OPERATION_POLLS = 60;

async function ensureGcpEdge(
  t: StagingGatewayTarget,
  deps: StagingEdgeDeps,
): Promise<StagingEdgeResult> {
  const run = deps.run ?? defaultGcloud;
  const http = deps.http ?? (fetch as unknown as HttpFetch);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const done: string[] = [];
  const fail = (error: string): StagingEdgeResult => ({ ok: false, error, done });
  const project = `--project=${t.projectId}`;
  const names = stagingGatewayEdgeNames(t.env);
  const service = stagingGatewayServiceName(t.env);

  // 1. Serverless NEG → the staging gateway.
  const neg = await run([
    "compute",
    "network-endpoint-groups",
    "describe",
    names.neg,
    `--region=${t.region}`,
    project,
    "--format=value(name)",
  ]);
  if (!neg.ok) {
    if (!isGcloudNotFound(neg.stderr)) return fail(`describe ${names.neg}: ${neg.stderr.trim()}`);
    const created = await run([
      "compute",
      "network-endpoint-groups",
      "create",
      names.neg,
      `--region=${t.region}`,
      project,
      "--network-endpoint-type=serverless",
      `--cloud-run-service=${service}`,
      "--quiet",
    ]);
    if (!created.ok) return fail(`create ${names.neg}: ${created.stderr.trim()}`);
    done.push(`created serverless NEG ${names.neg} → ${service}`);
  }

  // 2. Its backend service, behind the gateway's Cloud Armor policy (an
  // extra layer: the staging gate protects without it, E3).
  const policies = await run([
    "compute",
    "security-policies",
    "list",
    project,
    `--filter=name~^${gcpNamePrefix(t.env)}-waf`,
    "--format=value(name)",
  ]);
  if (!policies.ok) return fail(`list security policies: ${policies.stderr.trim()}`);
  const policyNames = policies.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (policyNames.length !== 1) {
    return fail(
      `expected exactly one ${gcpNamePrefix(t.env)}-waf* Cloud Armor policy, found ${policyNames.length}`,
    );
  }
  const policy = policyNames[0] as string;
  const backend = await run([
    "compute",
    "backend-services",
    "describe",
    names.backend,
    "--global",
    project,
    "--format=json",
  ]);
  let backendJson: { selfLink?: string; backends?: { group?: string }[] } = {};
  if (!backend.ok) {
    if (!isGcloudNotFound(backend.stderr)) {
      return fail(`describe ${names.backend}: ${backend.stderr.trim()}`);
    }
    const created = await run([
      "compute",
      "backend-services",
      "create",
      names.backend,
      "--global",
      project,
      "--load-balancing-scheme=EXTERNAL_MANAGED",
      "--protocol=HTTPS",
      `--security-policy=${policy}`,
      "--format=json",
      "--quiet",
    ]);
    if (!created.ok) return fail(`create ${names.backend}: ${created.stderr.trim()}`);
    done.push(`created backend service ${names.backend} (Cloud Armor ${policy})`);
    const parsed = safeJson(created.stdout);
    backendJson = ((Array.isArray(parsed) ? parsed[0] : parsed) ?? {}) as typeof backendJson;
  } else {
    backendJson = (safeJson(backend.stdout) ?? {}) as typeof backendJson;
  }
  if (
    !(backendJson.backends ?? []).some((b) =>
      b.group?.endsWith(`/networkEndpointGroups/${names.neg}`),
    )
  ) {
    const added = await run([
      "compute",
      "backend-services",
      "add-backend",
      names.backend,
      "--global",
      project,
      `--network-endpoint-group=${names.neg}`,
      `--network-endpoint-group-region=${t.region}`,
      "--quiet",
    ]);
    if (!added.ok) return fail(`add ${names.neg} to ${names.backend}: ${added.stderr.trim()}`);
    done.push(`added ${names.neg} to ${names.backend}`);
  }
  const backendLink =
    backendJson.selfLink ??
    `${COMPUTE_API}/projects/${t.projectId}/global/backendServices/${names.backend}`;

  // 3. The staging host's own managed certificate on the HTTPS proxy. Named
  // after the host: a managed certificate's domains are fixed, so a new
  // staging host gets a new certificate and the old one leaves the proxy.
  const certName = stagingCertName(t.env, t.stagingHost);
  const cert = await run([
    "compute",
    "ssl-certificates",
    "describe",
    certName,
    "--global",
    project,
    "--format=value(name)",
  ]);
  if (!cert.ok) {
    if (!isGcloudNotFound(cert.stderr)) return fail(`describe ${certName}: ${cert.stderr.trim()}`);
    const created = await run([
      "compute",
      "ssl-certificates",
      "create",
      certName,
      "--global",
      project,
      `--domains=${t.stagingHost}`,
      "--quiet",
    ]);
    if (!created.ok) return fail(`create ${certName}: ${created.stderr.trim()}`);
    done.push(`created managed certificate ${certName} for ${t.stagingHost}`);
  }
  const proxies = await run([
    "compute",
    "target-https-proxies",
    "list",
    project,
    `--filter=name~^${gcpNamePrefix(t.env)}`,
    "--format=json",
  ]);
  if (!proxies.ok) return fail(`list HTTPS proxies: ${proxies.stderr.trim()}`);
  const proxyList = (safeJson(proxies.stdout) ?? []) as {
    name?: string;
    sslCertificates?: string[];
  }[];
  if (proxyList.length !== 1 || !proxyList[0]?.name) {
    return fail(
      `expected exactly one ${gcpNamePrefix(t.env)}* HTTPS proxy, found ${proxyList.length}`,
    );
  }
  const proxy = proxyList[0];
  const certs = (proxy.sslCertificates ?? []).map((c) => c.slice(c.lastIndexOf("/") + 1));
  const wanted = [...certs.filter((c) => !c.startsWith(`${names.cert}-`)), certName];
  if (wanted.length !== certs.length || !certs.includes(certName)) {
    const set = await run([
      "compute",
      "target-https-proxies",
      "update",
      proxy.name as string,
      project,
      `--ssl-certificates=${wanted.join(",")}`,
      "--global-ssl-certificates",
      "--quiet",
    ]);
    if (!set.ok) return fail(`attach ${certName} to ${proxy.name}: ${set.stderr.trim()}`);
    done.push(`attached ${certName} to ${proxy.name}`);
  }

  // 4. The URL map: the staging host to the staging gateway, every path.
  const maps = await run(["compute", "url-maps", "list", "--global", project, "--format=json"]);
  if (!maps.ok) return fail(`list URL maps: ${maps.stderr.trim()}`);
  const all = (safeJson(maps.stdout) ?? []) as LiveUrlMap[];
  const site = all.filter((m) => (m.hostRules ?? []).some((h) => h.hosts.includes(t.domain)));
  if (site.length !== 1) {
    return fail(`expected exactly one URL map routing ${t.domain}, found ${site.length}`);
  }
  const next = planStagingHostRule(site[0] as LiveUrlMap, t, backendLink);
  if (next) {
    const bearer = await accessToken(run);
    if (!bearer.ok) return fail(bearer.error);
    if (!URL_MAP_NAME.test(next.name)) return fail(`"${next.name}" is not a URL map name`);
    const headers = {
      Authorization: `Bearer ${bearer.token}`,
      "Content-Type": "application/json",
    };
    const base = `${COMPUTE_API}/projects/${encodeURIComponent(t.projectId)}/global`;
    // `urlMaps.update` carries the fingerprint: a concurrent write (the
    // admin publishing redirects) fails it instead of being lost.
    const put = await http(`${base}/urlMaps/${encodeURIComponent(next.name)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(next),
    });
    const text = await put.text();
    if (!put.ok)
      return fail(`update URL map ${next.name}: HTTP ${put.status} ${text.slice(0, 500)}`);
    type Operation = {
      name?: string;
      status?: string;
      error?: { errors?: { message?: string }[] };
    };
    let op = (safeJson(text) ?? {}) as Operation;
    for (let i = 0; op.status !== "DONE" && i < OPERATION_POLLS; i++) {
      await sleep(2_000);
      if (!OPERATION_NAME.test(op.name ?? "")) {
        return fail(`the URL-map update answered no operation name (${op.name ?? "none"})`);
      }
      const poll = await http(`${base}/operations/${encodeURIComponent(op.name ?? "")}`, {
        method: "GET",
        headers,
      });
      if (!poll.ok) return fail(`poll ${op.name}: HTTP ${poll.status}`);
      op = (safeJson(await poll.text()) ?? {}) as Operation;
    }
    if (op.status !== "DONE") return fail(`URL-map update ${op.name} did not finish`);
    const errors = op.error?.errors ?? [];
    if (errors.length > 0)
      return fail(`URL-map update failed: ${errors.map((e) => e.message).join("; ")}`);
    done.push(`URL map ${next.name}: ${t.stagingHost} → ${names.backend}`);
  }

  // The staging host answers on the load balancer's address, like the site.
  const address = await run([
    "compute",
    "addresses",
    "list",
    "--global",
    project,
    `--filter=name~^${gcpNamePrefix(t.env)}`,
    "--format=value(address)",
  ]);
  const ips = address.ok
    ? address.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return {
    ok: true,
    done,
    dnsRecords:
      ips.length === 1 ? [{ name: t.stagingHost, type: "A", value: ips[0] as string }] : [],
  };
}

/** An OAuth access token as gcloud prints one: base64url-ish characters only. */
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/=-]{1,4096}$/;
/** A Compute resource name (RFC 1035 label). */
const URL_MAP_NAME = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
/** A Compute operation name. */
const OPERATION_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The caller's gcloud access token, checked to be one before it goes into
 * a request header: gcloud's output is never forwarded as it came.
 */
async function accessToken(
  run: GcloudRunner,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const r = await run(["auth", "print-access-token"]);
  const token = r.ok ? r.stdout.trim() : "";
  if (!ACCESS_TOKEN.test(token)) {
    return {
      ok: false,
      error: `gcloud auth print-access-token gave no access token${r.ok ? "" : `: ${r.stderr.trim()}`}`,
    };
  }
  return { ok: true, token };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

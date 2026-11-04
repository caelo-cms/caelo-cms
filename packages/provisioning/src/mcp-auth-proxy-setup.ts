// SPDX-License-Identifier: MPL-2.0

/**
 * #1328 — the Cloud Run services an upgrade to the MCP-Auth-Proxy release
 * must find before it plans its rolls, created through gcloud on installs
 * whose stack predates them (`cms-provision upgrade` and the converge job
 * never run Pulumi). Run as the operator's or the provisioner's identity,
 * before the upgrade's plan: each step only ADDS a service, account or grant
 * that serves no traffic yet, so a failure leaves the running install as it
 * was (converge release 1 of the hardening plan, #763, is additive).
 *
 *   - Both providers: the proxy's own service account and its
 *     `secretAccessor` on exactly its two secrets — before any service runs
 *     as it, because Cloud Run checks a revision's secret access at deploy.
 *   - `gcp-firebase` (E13 a): the visitor gateway's new service
 *     `caelo-<env>-data-gateway`, a copy of the service that was the gateway
 *     (same image, env, secrets, VPC, account), so the app-roll can then roll
 *     it like any other service and turn the old one into the proxy. Copied,
 *     not built from the contract, so the health baseline sees the release
 *     that serves today on all three services.
 *   - `gcp`: the proxy's own service `caelo-<env>-mcp-auth-proxy`, deployed
 *     with the release's proxy image (there is no older proxy to copy). Its
 *     load-balancer part is remote-mcp.ts `ensureRemoteMcpEdge`, later in
 *     the converge.
 *
 * Fresh installs get the same from their stack (gcp-firebase) or from the
 * wizard after the first `pulumi up` (gcp, like the jobs: CLI-owned).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcloud as defaultGcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import { gcpSecretId, mcpAuthProxyServiceAccountEmail } from "./gcp-names.js";
import { type EnsureOutcome, ensureMcpAuthProxyServiceAccount } from "./runtime-secrets.js";
import {
  type CloudRunEnvVar,
  cloudRunServicePrefix,
  DEFAULT_MCP_AUTH_PROXY_MAX_INSTANCES,
  fixedCloudRunServiceName,
  type GcpProvider,
  MCP_AUTH_PROXY_TIMEOUT_SECONDS,
  mcpAuthProxyEnvContract,
  OPERATOR_OAUTH_CLIENT_FILE,
  remoteMcpIdentity,
  remoteMcpIdentityEnv,
  secretFilePath,
  serviceSecrets,
} from "./stack-contract.js";
import { listFlag } from "./stack-converge.js";
import { ensureStagingGatewayFromLiveGateway } from "./staging-gateway-setup.js";
import { lookupFailure, resolveGcpResourceName } from "./upgrade/gcp-lookup.js";

/** The install the services are ensured on. */
export interface ReleaseServicesTarget {
  readonly provider: GcpProvider;
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  readonly domain: string;
  /** The release's digest-pinned MCP-Auth-Proxy image (`…/mcp-auth-proxy@sha256:…`). */
  readonly mcpAuthProxyImageRef: string;
  /** #1330 — the release's digest-pinned gateway image, which the staging gateway runs too. */
  readonly gatewayImageRef: string;
  /** #1330 — the staging host (install.json `stagingDomain`). */
  readonly stagingHost: string;
}

/** What the `gcp` proxy's own service needs. */
export type ProxyServiceTarget = Omit<ReleaseServicesTarget, "gatewayImageRef" | "stagingHost">;

export interface ReleaseServicesDeps {
  readonly run?: GcloudRunner;
  /** Writes a service spec for `gcloud run services replace`; returns its path and a cleanup. */
  readonly writeSpecFile?: (json: string) => {
    readonly path: string;
    readonly cleanup: () => void;
  };
  /** Waits between retries of a grant on the account created a moment ago. */
  readonly sleep?: Sleep;
}

// gcloud words a missing Cloud Run service "Cannot find service [<name>]."
// with no NOT_FOUND code (searchVIU upgrade to v0.11.10, 2026-11-03).
const NOT_FOUND = /NOT_FOUND|not found|cannot find|does not exist|could not be found/i;

/** Ensure everything {@link ReleaseServicesTarget} needs; outcomes in order, failures included. */
export async function ensureReleaseServices(
  target: ReleaseServicesTarget,
  deps: ReleaseServicesDeps = {},
): Promise<EnsureOutcome[]> {
  const run = deps.run ?? defaultGcloud;
  const outcomes: EnsureOutcome[] = [];
  const account = await ensureMcpAuthProxyServiceAccount(target, { run });
  outcomes.push(account);
  if (account.status === "failed") return outcomes;
  outcomes.push(...(await ensureMcpAuthProxySecretAccess(target, run, deps.sleep ?? realSleep)));
  if (outcomes.some((o) => o.status === "failed")) return outcomes;
  outcomes.push(
    target.provider === "gcp-firebase"
      ? await ensureDataGatewayService(target, run, deps.writeSpecFile ?? writeTempSpec)
      : await ensureMcpAuthProxyServiceGcp(target, run),
  );
  if (outcomes.some((o) => o.status === "failed")) return outcomes;
  outcomes.push(
    ...(await ensureStagingGatewayFromLiveGateway(target, { run, sleep: deps.sleep ?? realSleep })),
  );
  return outcomes;
}

/**
 * `secretAccessor` for the proxy's account on each secret it reads
 * (stack-contract.ts `serviceSecrets("mcp-auth-proxy")`) and nothing else.
 * `add-iam-policy-binding` is idempotent; the stack invariants ensure the
 * same bindings again later in the converge.
 */
async function ensureMcpAuthProxySecretAccess(
  target: Pick<ReleaseServicesTarget, "projectId" | "env">,
  run: GcloudRunner,
  sleep: Sleep,
): Promise<EnsureOutcome[]> {
  const member = `serviceAccount:${mcpAuthProxyServiceAccountEmail(target.projectId, target.env)}`;
  const outcomes: EnsureOutcome[] = [];
  for (const secret of serviceSecrets("mcp-auth-proxy")) {
    const id = `secretAccessor → MCP-Auth-Proxy on ${secret}`;
    // The account was usually created a moment ago, and IAM answers "does
    // not exist" until it has propagated: retried, not failed.
    const r = await runWithRetry(run, sleep, [
      "secrets",
      "add-iam-policy-binding",
      gcpSecretId(target.env, secret),
      `--project=${target.projectId}`,
      `--member=${member}`,
      "--role=roles/secretmanager.secretAccessor",
      "--condition=None",
      "--quiet",
    ]);
    outcomes.push(
      r.ok ? { id, status: "present" } : { id, status: "failed", error: r.stderr.trim() },
    );
  }
  return outcomes;
}

// ===========================================================================
// gcp-firebase: the data gateway
// ===========================================================================

/**
 * The Knative service spec of `serviceJson` (`gcloud run services describe
 * --format=json`) as a new service named `name`, for `gcloud run services
 * replace`: the configuration only — image, env, secrets, volumes, VPC,
 * scaling, account, ingress — without the source's identity (uid, revision
 * names, status), its tool stamps or its traffic pins.
 *
 * @throws when the source is not a gateway image (a re-run must never copy
 *   the MCP-Auth-Proxy the old service became)
 */
export function cloneServiceSpec(serviceJson: string, name: string): string {
  const svc = JSON.parse(serviceJson) as {
    apiVersion?: string;
    kind?: string;
    metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
    spec?: {
      template?: {
        metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> };
        spec?: { containers?: { image?: string }[] } & Record<string, unknown>;
      };
    };
  };
  const image = svc.spec?.template?.spec?.containers?.[0]?.image ?? "";
  if (!/\/gateway[@:]/.test(image)) {
    throw new Error(
      `the source service runs ${image || "no image"}, not a Caelo gateway image — the visitor gateway cannot be copied from it`,
    );
  }
  const keepLabels = (labels: Record<string, string> | undefined) =>
    Object.fromEntries(
      Object.entries(labels ?? {}).filter(
        ([k]) =>
          !k.startsWith("cloud.googleapis.com/") &&
          !k.startsWith("run.googleapis.com/") &&
          !k.startsWith("client.knative.dev/") &&
          !k.startsWith("serving.knative.dev/") &&
          !k.startsWith("goog-"),
      ),
    );
  // Service-level: only the settings; the rest are server stamps.
  const KEEP_SERVICE_ANNOTATIONS = [
    "run.googleapis.com/ingress",
    "run.googleapis.com/launch-stage",
  ];
  const annotations = Object.fromEntries(
    Object.entries(svc.metadata?.annotations ?? {}).filter(([k]) =>
      KEEP_SERVICE_ANNOTATIONS.includes(k),
    ),
  );
  const templateAnnotations = Object.fromEntries(
    Object.entries(svc.spec?.template?.metadata?.annotations ?? {}).filter(
      ([k]) => k !== "run.googleapis.com/client-name" && k !== "run.googleapis.com/client-version",
    ),
  );
  return JSON.stringify({
    apiVersion: svc.apiVersion ?? "serving.knative.dev/v1",
    kind: svc.kind ?? "Service",
    metadata: { name, labels: keepLabels(svc.metadata?.labels), annotations },
    spec: {
      template: {
        metadata: {
          labels: keepLabels(svc.spec?.template?.metadata?.labels),
          annotations: templateAnnotations,
        },
        spec: svc.spec?.template?.spec ?? {},
      },
      traffic: [{ percent: 100, latestRevision: true }],
    },
  });
}

function writeTempSpec(json: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "caelo-service-"));
  const path = join(dir, "service.json");
  writeFileSync(path, json, { mode: 0o600 });
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The gcp-firebase data gateway (`caelo-<env>-data-gateway`): present, or
 * created as a copy of the `caelo-<env>-gateway*` service. Its public invoker
 * and the admin's `run.viewer` (the Firebase rewrite) follow from the stack
 * invariants later in the converge.
 */
async function ensureDataGatewayService(
  target: ReleaseServicesTarget,
  run: GcloudRunner,
  writeSpecFile: NonNullable<ReleaseServicesDeps["writeSpecFile"]>,
): Promise<EnsureOutcome> {
  const name = fixedCloudRunServiceName(target.provider, target.env, "gateway") as string;
  const id = `Cloud Run service ${name} (the visitor gateway)`;
  const where = [`--region=${target.region}`, `--project=${target.projectId}`];
  const existing = await run([
    "run",
    "services",
    "describe",
    name,
    ...where,
    "--format=value(metadata.name)",
  ]);
  if (existing.ok) return { id, status: "present" };
  if (!NOT_FOUND.test(existing.stderr)) {
    return { id, status: "failed", error: existing.stderr.trim() };
  }
  // The source: the service that was the gateway and becomes the proxy.
  const sourcePrefix = cloudRunServicePrefix(target.provider, target.env, "mcp-auth-proxy");
  const source = await resolveGcpResourceName(
    run,
    "run-service",
    sourcePrefix,
    target.projectId,
    target.region,
  );
  if (source.status !== "found") {
    return {
      id,
      status: "failed",
      error: lookupFailure(source, `${sourcePrefix}* Cloud Run service`, "operator"),
    };
  }
  const described = await run([
    "run",
    "services",
    "describe",
    source.name,
    ...where,
    "--format=json",
  ]);
  if (!described.ok) {
    return { id, status: "failed", error: `describe ${source.name}: ${described.stderr.trim()}` };
  }
  let spec: string;
  try {
    spec = cloneServiceSpec(described.stdout, name);
  } catch (e) {
    return {
      id,
      status: "failed",
      error: `${e instanceof Error ? e.message : String(e)}. Re-run the installer (it creates ${name} from the stack), then upgrade again.`,
    };
  }
  const file = writeSpecFile(spec);
  try {
    const replaced = await run(["run", "services", "replace", file.path, ...where, "--quiet"]);
    return replaced.ok
      ? { id, status: "applied", detail: `copied from ${source.name}` }
      : { id, status: "failed", error: replaced.stderr.trim() };
  } finally {
    file.cleanup();
  }
}

// ===========================================================================
// gcp: the proxy's service
// ===========================================================================

/**
 * The full env the `gcp` proxy is deployed with: its contract plus the
 * remote-MCP identity it can derive without a lookup (its public origin is
 * the site's host, the admin's is `admin.<domain>`). The IAP audience is
 * the admin's alone.
 */
function gcpProxyEnv(target: Pick<ReleaseServicesTarget, "env" | "domain">): CloudRunEnvVar[] {
  const identity = remoteMcpIdentityEnv(
    remoteMcpIdentity({
      provider: "gcp",
      domain: target.domain,
      // Only the admin's audience uses these; the proxy's env does not.
      projectNumber: "0",
      adminBackendServiceId: "0",
    }),
  )["mcp-auth-proxy"];
  return [...mcpAuthProxyEnvContract({ provider: "gcp", env: target.env }), ...identity];
}

/**
 * The `gcloud run deploy` argv of the `gcp` proxy: load-balancer-only
 * ingress (its two hops, stack-contract.ts MCP_AUTH_PROXY_TRUSTED_PROXY_HOPS),
 * invokable without a Google identity (MCP clients have none), request-based
 * CPU, no VPC, and its Google sign-in client file as a secret volume.
 */
export function gcpProxyDeployArgs(target: ProxyServiceTarget): string[] {
  const name = fixedCloudRunServiceName("gcp", target.env, "mcp-auth-proxy") as string;
  const env = gcpProxyEnv(target);
  const plain = env.flatMap((e) => ("value" in e ? [`${e.name}=${e.value}`] : []));
  const secrets = [
    ...env.flatMap((e) =>
      "valueSource" in e
        ? [`${e.name}=${e.valueSource.secretKeyRef.secret}:${e.valueSource.secretKeyRef.version}`]
        : [],
    ),
    `${secretFilePath(OPERATOR_OAUTH_CLIENT_FILE)}=${gcpSecretId(target.env, OPERATOR_OAUTH_CLIENT_FILE.secret)}:${OPERATOR_OAUTH_CLIENT_FILE.version}`,
  ];
  return [
    "run",
    "deploy",
    name,
    `--image=${target.mcpAuthProxyImageRef}`,
    `--region=${target.region}`,
    `--project=${target.projectId}`,
    `--service-account=${mcpAuthProxyServiceAccountEmail(target.projectId, target.env)}`,
    "--ingress=internal-and-cloud-load-balancing",
    "--allow-unauthenticated",
    "--min-instances=0",
    `--max-instances=${DEFAULT_MCP_AUTH_PROXY_MAX_INSTANCES}`,
    "--cpu=1",
    "--memory=512Mi",
    "--cpu-throttling",
    `--timeout=${MCP_AUTH_PROXY_TIMEOUT_SECONDS}`,
    listFlag("--set-env-vars", plain),
    listFlag("--set-secrets", secrets),
    "--quiet",
  ];
}

/**
 * The `gcp` proxy service: present, or deployed. Deployed once; the
 * app-roll moves it onto each release's image after that.
 */
export async function ensureMcpAuthProxyServiceGcp(
  target: ProxyServiceTarget,
  run: GcloudRunner,
): Promise<EnsureOutcome> {
  const name = fixedCloudRunServiceName("gcp", target.env, "mcp-auth-proxy") as string;
  const id = `Cloud Run service ${name} (the MCP-Auth-Proxy)`;
  const existing = await run([
    "run",
    "services",
    "describe",
    name,
    `--region=${target.region}`,
    `--project=${target.projectId}`,
    "--format=value(metadata.name)",
  ]);
  if (existing.ok) return { id, status: "present" };
  if (!NOT_FOUND.test(existing.stderr)) {
    return { id, status: "failed", error: existing.stderr.trim() };
  }
  const deployed = await run(gcpProxyDeployArgs(target));
  return deployed.ok
    ? { id, status: "applied" }
    : { id, status: "failed", error: deployed.stderr.trim() };
}

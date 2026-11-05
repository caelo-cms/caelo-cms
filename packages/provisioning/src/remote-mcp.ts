// SPDX-License-Identifier: MPL-2.0

/**
 * #806 — the CLI's part of remote MCP on a Google IAP install (`gcp`,
 * `gcp-firebase`), run as the operator's (or the provisioner's) gcloud
 * identity by the wizard around `pulumi up`, by `state migrate`'s preview
 * and by `cms-provision upgrade` around the roll. Every step is idempotent.
 *
 *   - {@link resolveStackRemoteMcpIdentity}: the env vars that name
 *     generated identities ({@link RemoteMcpIdentity}), resolved from the
 *     live install for the stack config the installer writes before `up`
 *     (#1082: the stack is their one owner — stack-contract.ts says why
 *     they cannot be plain resource inputs), and
 *     {@link checkRemoteMcpIdentityEnv}, the read-only check after it.
 *   - {@link ensureRemoteMcpEdge} (`gcp` only): the MCP-Auth-Proxy's
 *     load-balancer part (#1328) — its service, serverless NEG, backend and
 *     own Cloud Armor policy with the `/api/mcp/*` rule (remote-mcp-edge.ts),
 *     and the URL map's rule sending the remote-MCP paths to it (the stack
 *     ignores `pathRules` after creation, gcp-url-map.ts).
 *
 * The secrets, the IAM bindings, the proxy's secret volume and timeout
 * come through the shared contract like everything else
 * (runtime-secrets.ts, stack-contract.ts, upgrade/app-roll.ts).
 *
 * The same identity env carries what the admin's Google sign-in needs
 * (#914): its own URL and the project's Google organisation domain
 * ({@link resolveGoogleOrgDomain}).
 *
 * Nothing here enables remote MCP: that happens when the Owner sets up the
 * install's Google sign-in client (Settings → Google sign-in). Until then
 * the MCP-Auth-Proxy answers its fixed 404.
 */

import { GCP_MCP_AUTH_PROXY_PATHS } from "@caelo-cms/shared";
import { gcloud as defaultGcloud, isGcloudNotFound } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { gcpNamePrefix, mcpAuthProxyEdgeNames } from "./gcp-names.js";
import { ensureMcpAuthProxyServiceGcp } from "./mcp-auth-proxy-setup.js";
import {
  isMcpArmorRule,
  type LiveArmorRule,
  MCP_ARMOR_RULE,
  mcpArmorRuleFlags,
} from "./remote-mcp-edge.js";
import type { HttpFetch } from "./runtime-secrets.js";
import {
  CLOUD_RUN_SLUGS,
  type CloudRunSlug,
  cloudRunServicePrefix,
  fixedCloudRunServiceName,
  type GcpProvider,
  REMOTE_MCP_ENV,
  type RemoteMcpIdentity,
  remoteMcpIdentity,
  remoteMcpIdentityEnv,
} from "./stack-contract.js";
import { type EnvChange, liveContainerEnv, planEnvUpdate } from "./stack-converge.js";
import { lookupFailure, resolveGcpResourceName } from "./upgrade/gcp-lookup.js";

/** The install remote MCP is set up on. */
export interface RemoteMcpTarget {
  readonly provider: GcpProvider;
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
  readonly domain: string;
  /** Deployed (Pulumi-suffixed) Cloud Run service names. */
  readonly services: Readonly<Record<CloudRunSlug, string>>;
}

export type RemoteMcpResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly error: string };

/** Parse gcloud JSON output; null (never a throw) when it is not JSON. */
function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function lines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ===========================================================================
// Identity env
// ===========================================================================

/**
 * #914 — the project's Google organisation domain (the organisation's
 * `displayName`, which Cloud Resource Manager sets to its primary domain),
 * or `none` when the project sits in no organisation. Read as the
 * operator's identity: `organizations describe` needs
 * `resourcemanager.organizations.get` on the organisation, which project
 * Owners often have and the admin's service account never does.
 */
export async function resolveGoogleOrgDomain(
  projectId: string,
  deps: { run?: GcloudRunner } = {},
): Promise<RemoteMcpResult<{ readonly domain: string }>> {
  const run = deps.run ?? defaultGcloud;
  const ancestors = await run(["projects", "get-ancestors", projectId, "--format=json"]);
  if (!ancestors.ok) {
    return { ok: false, error: `read the ancestors of ${projectId}: ${ancestors.stderr.trim()}` };
  }
  const list = parseJson(ancestors.stdout || "[]");
  if (!Array.isArray(list)) return { ok: false, error: "get-ancestors: output is not a JSON list" };
  const org = (list as { id?: string; type?: string }[]).find((a) => a.type === "organization");
  if (!org?.id) return { ok: true, domain: NO_GOOGLE_ORGANISATION };
  const describe = await run(["organizations", "describe", org.id, "--format=value(displayName)"]);
  const domain = describe.ok ? describe.stdout.trim().toLowerCase() : "";
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return {
      ok: false,
      error: `read organization ${org.id}: ${describe.stderr.trim() || `unexpected name "${domain}"`} (needs the Organization Viewer role)`,
    };
  }
  return { ok: true, domain };
}

/** `CAELO_GOOGLE_ORG_DOMAIN` value for a project outside any organisation (admin-core identity-gate.ts). */
export const NO_GOOGLE_ORGANISATION = "none";

/**
 * Read the live identities {@link remoteMcpIdentity} derives from: the
 * project number, and the admin's backend service id (`gcp`) or both
 * services' URLs (`gcp-firebase`). Fails naming what it could not read.
 *
 * The organisation domain (#914) is best-effort: when it cannot be read,
 * `orgDomainError` says why and the identity carries none, so the admin's
 * var keeps its value — the admin then reports the organisation as unknown
 * and refuses user creation loudly until the Owner sets up Google sign-in.
 */
export async function resolveRemoteMcpIdentity(
  target: RemoteMcpTarget,
  deps: { run?: GcloudRunner } = {},
): Promise<
  RemoteMcpResult<{ readonly identity: RemoteMcpIdentity; readonly orgDomainError?: string }>
> {
  const resolved = await resolveServiceIdentity(target, deps);
  if (!resolved.ok) return resolved;
  const org = await resolveGoogleOrgDomain(target.projectId, deps);
  return org.ok
    ? { ok: true, identity: { ...resolved.identity, googleOrgDomain: org.domain } }
    : { ok: true, identity: resolved.identity, orgDomainError: org.error };
}

async function resolveServiceIdentity(
  target: RemoteMcpTarget,
  deps: { run?: GcloudRunner } = {},
): Promise<RemoteMcpResult<{ readonly identity: RemoteMcpIdentity }>> {
  const run = deps.run ?? defaultGcloud;
  const project = `--project=${target.projectId}`;
  const num = await run([
    "projects",
    "describe",
    target.projectId,
    "--format=value(projectNumber)",
  ]);
  const projectNumber = num.ok ? num.stdout.trim() : "";
  if (!/^\d+$/.test(projectNumber)) {
    return {
      ok: false,
      error: `read the project number of ${target.projectId}: ${num.stderr.trim() || "empty"}`,
    };
  }
  if (target.provider === "gcp") {
    const prefix = `${gcpNamePrefix(target.env)}-admin-backend`;
    const list = await run([
      "compute",
      "backend-services",
      "list",
      "--global",
      project,
      `--filter=name~^${prefix} AND iap.enabled=true`,
      "--format=value(id)",
    ]);
    if (!list.ok) return { ok: false, error: `list backend services: ${list.stderr.trim()}` };
    const ids = lines(list.stdout);
    if (ids.length !== 1 || !/^\d+$/.test(ids[0] ?? "")) {
      return {
        ok: false,
        error: `expected exactly one IAP-enabled ${prefix}* backend service, found ${ids.length}`,
      };
    }
    return {
      ok: true,
      identity: remoteMcpIdentity({
        provider: "gcp",
        domain: target.domain,
        projectNumber,
        adminBackendServiceId: ids[0] as string,
      }),
    };
  }
  const url = async (service: string) => {
    const r = await run([
      "run",
      "services",
      "describe",
      service,
      `--region=${target.region}`,
      project,
      "--format=value(status.url)",
    ]);
    const value = r.ok ? r.stdout.trim() : "";
    return value.startsWith("https://") ? value : null;
  };
  // #1328 — the broker answers on the MCP-Auth-Proxy's URL: the service
  // that was the gateway before (E13 a), so the URL connectors hold stays.
  const proxyService = target.services["mcp-auth-proxy"];
  const adminUrl = await url(target.services.admin);
  const proxyUrl = await url(proxyService);
  if (!adminUrl || !proxyUrl) {
    return {
      ok: false,
      error: `read the Cloud Run URL of the ${adminUrl ? "MCP-Auth-Proxy" : "admin"} service (${adminUrl ? proxyService : target.services.admin})`,
    };
  }
  return {
    ok: true,
    identity: remoteMcpIdentity({
      provider: "gcp-firebase",
      projectNumber,
      region: target.region,
      adminServiceName: target.services.admin,
      adminServiceUrl: adminUrl,
      mcpAuthProxyServiceUrl: proxyUrl,
    }),
  };
}

/** `gcloud run services describe --format=json` of one service, or why it failed. */
async function describeService(
  target: RemoteMcpTarget,
  service: string,
  run: GcloudRunner,
): Promise<RemoteMcpResult<{ readonly json: string }>> {
  const describe = await run([
    "run",
    "services",
    "describe",
    service,
    `--region=${target.region}`,
    `--project=${target.projectId}`,
    "--format=json",
  ]);
  if (!describe.ok) return { ok: false, error: `describe ${service}: ${describe.stderr.trim()}` };
  if (parseJson(describe.stdout) === null) {
    return { ok: false, error: `describe ${service}: output is not JSON` };
  }
  return { ok: true, json: describe.stdout };
}

/**
 * #1082 — the deployed install remote MCP is resolved on: the Pulumi-suffixed
 * admin and gateway Cloud Run services found by prefix. Read-only.
 */
export async function findRemoteMcpTarget(
  base: Omit<RemoteMcpTarget, "services">,
  deps: { run?: GcloudRunner } = {},
): Promise<RemoteMcpResult<{ readonly target: RemoteMcpTarget }>> {
  const run = deps.run ?? defaultGcloud;
  const services: Partial<Record<CloudRunSlug, string>> = {};
  for (const slug of CLOUD_RUN_SLUGS) {
    // A service created under a fixed name needs no lookup — and on `gcp`
    // the MCP-Auth-Proxy is created after the stack's first `up`.
    const fixed = fixedCloudRunServiceName(base.provider, base.env, slug);
    if (fixed) {
      services[slug] = fixed;
      continue;
    }
    const prefix = cloudRunServicePrefix(base.provider, base.env, slug);
    const lookup = await resolveGcpResourceName(
      run,
      "run-service",
      prefix,
      base.projectId,
      base.region,
    );
    if (lookup.status !== "found") {
      return {
        ok: false,
        error: lookupFailure(lookup, `${prefix}* Cloud Run service`, "operator"),
      };
    }
    services[slug] = lookup.name;
  }
  return {
    ok: true,
    target: { ...base, services: services as Record<CloudRunSlug, string> },
  };
}

/**
 * #1082 — the identity the installer writes into the stack config before
 * `up` (stack-contract.ts REMOTE_MCP_IDENTITY_CONFIG), so the stack declares
 * the vars the services carry and `up` keeps them.
 *
 * {@link resolveRemoteMcpIdentity}, except for the organisation domain when
 * it cannot be read: then the admin's live `CAELO_GOOGLE_ORG_DOMAIN` is
 * carried over (an earlier run as an account with the Organization Viewer
 * role set it). The stack would otherwise remove it, where a gcloud roll
 * leaves it as it is. `orgDomainError` still says why it was not read.
 */
export async function resolveStackRemoteMcpIdentity(
  target: RemoteMcpTarget,
  deps: { run?: GcloudRunner } = {},
): Promise<
  RemoteMcpResult<{ readonly identity: RemoteMcpIdentity; readonly orgDomainError?: string }>
> {
  const run = deps.run ?? defaultGcloud;
  const resolved = await resolveRemoteMcpIdentity(target, { run });
  if (!resolved.ok || !resolved.orgDomainError) return resolved;
  const admin = await describeService(target, target.services.admin, run);
  if (!admin.ok) return admin;
  const live = liveContainerEnv(admin.json).get(REMOTE_MCP_ENV.googleOrgDomain);
  return {
    ok: true,
    identity:
      live?.kind === "value"
        ? { ...resolved.identity, googleOrgDomain: live.value }
        : resolved.identity,
    orgDomainError: resolved.orgDomainError,
  };
}

/**
 * #1082 — what each service's identity env lacks against `identity`
 * (read-only). The stack owns these vars now; this is the installer's check
 * that the `up` it just ran put them in place. An empty list per service is
 * the expected answer.
 */
export async function checkRemoteMcpIdentityEnv(
  target: RemoteMcpTarget,
  identity: RemoteMcpIdentity,
  deps: { run?: GcloudRunner } = {},
): Promise<RemoteMcpResult<{ readonly drift: Record<CloudRunSlug, EnvChange[]> }>> {
  const run = deps.run ?? defaultGcloud;
  const desired = remoteMcpIdentityEnv(identity);
  const drift: Record<CloudRunSlug, EnvChange[]> = {
    admin: [],
    gateway: [],
    "staging-gateway": [],
    "mcp-auth-proxy": [],
  };
  for (const slug of CLOUD_RUN_SLUGS) {
    // Nothing to check where the identity names nothing (the visitor
    // gateways), and the staging gateway is the CLI's (#1330), not the
    // stack's: it may not exist yet right after a first `up`.
    if (desired[slug].length === 0) continue;
    const described = await describeService(target, target.services[slug], run);
    if (!described.ok) return described;
    const plan = planEnvUpdate(liveContainerEnv(described.json), desired[slug]);
    if (!plan.ok) return { ok: false, error: `${slug}: ${plan.error}` };
    drift[slug] = plan.changes;
  }
  return { ok: true, drift };
}

// ===========================================================================
// Load balancer (gcp)
// ===========================================================================

/** A path rule / matcher / URL map as the Compute API returns them (the parts used here). */
interface UrlMapPathRule {
  readonly paths: string[];
  readonly service?: string;
  readonly urlRedirect?: unknown;
}
interface UrlMapPathMatcher {
  readonly name: string;
  readonly pathRules?: UrlMapPathRule[];
}
export interface LiveUrlMap {
  readonly name: string;
  readonly hostRules?: { readonly hosts: string[]; readonly pathMatcher: string }[];
  readonly pathMatchers?: UrlMapPathMatcher[];
  readonly [field: string]: unknown;
}

export type UrlMapPathsPlan =
  | {
      readonly ok: true;
      readonly map: LiveUrlMap;
      /** What changed, for the log; empty when the map was already right. */
      readonly changes: string[];
    }
  | { readonly ok: false; readonly error: string };

/** Whether a rule's `service` (a full self-link) is the backend service named `name`. */
function targetsBackend(rule: UrlMapPathRule, name: string): boolean {
  return rule.service?.endsWith(`/backendServices/${name}`) ?? false;
}

/**
 * #1328 — the URL map with the remote-MCP paths ({@link GCP_MCP_AUTH_PROXY_PATHS})
 * on their own rule to the MCP-Auth-Proxy's backend, and none of them left
 * on the gateway's `/api/*` rule (#806 put the discovery paths there). Only
 * those two rules change; redirect rules the admin wrote stay as they are.
 *
 * @param proxyBackend the proxy backend's self-link
 */
export function planUrlMapPaths(
  maps: readonly LiveUrlMap[],
  siteHost: string,
  proxyBackend: string,
): UrlMapPathsPlan {
  const routing = maps.flatMap((m) =>
    (m.hostRules ?? [])
      .filter((h) => h.hosts.includes(siteHost))
      .map((h) => ({ map: m, pathMatcher: h.pathMatcher })),
  );
  if (routing.length !== 1) {
    return {
      ok: false,
      error: `expected exactly one URL map routing ${siteHost}, found ${routing.length}`,
    };
  }
  const { map, pathMatcher } = routing[0] as (typeof routing)[number];
  const matcher = (map.pathMatchers ?? []).find((m) => m.name === pathMatcher);
  const isGatewayRule = (r: UrlMapPathRule) =>
    r.service !== undefined && r.urlRedirect === undefined && r.paths.includes("/api/*");
  if (!matcher || !(matcher.pathRules ?? []).some(isGatewayRule)) {
    return {
      ok: false,
      error: `URL map ${map.name} has no /api/* rule to the gateway in path matcher ${pathMatcher}; re-run the installer to restore the load balancer`,
    };
  }
  const proxyName = proxyBackend.slice(proxyBackend.lastIndexOf("/") + 1);
  const changes: string[] = [];
  const rules: UrlMapPathRule[] = [];
  let proxyRule = false;
  for (const r of matcher.pathRules ?? []) {
    if (isGatewayRule(r)) {
      const moved = r.paths.filter((p) => GCP_MCP_AUTH_PROXY_PATHS.includes(p));
      if (moved.length > 0) changes.push(`moved ${moved.join(", ")} off the gateway's rule`);
      rules.push({ ...r, paths: r.paths.filter((p) => !GCP_MCP_AUTH_PROXY_PATHS.includes(p)) });
      continue;
    }
    if (targetsBackend(r, proxyName)) {
      proxyRule = true;
      const same =
        r.paths.length === GCP_MCP_AUTH_PROXY_PATHS.length &&
        GCP_MCP_AUTH_PROXY_PATHS.every((p) => r.paths.includes(p));
      if (!same)
        changes.push(`set the MCP-Auth-Proxy rule to ${GCP_MCP_AUTH_PROXY_PATHS.join(", ")}`);
      rules.push({ ...r, paths: [...GCP_MCP_AUTH_PROXY_PATHS] });
      continue;
    }
    rules.push(r);
  }
  if (!proxyRule) {
    changes.push(`routed ${GCP_MCP_AUTH_PROXY_PATHS.join(", ")} to the MCP-Auth-Proxy`);
    // Before the admin's redirect rules: GCP orders nothing by position for
    // path rules (the longest match wins), but a stable place keeps diffs small.
    const at = rules.findIndex(isGatewayRule) + 1;
    rules.splice(at, 0, { paths: [...GCP_MCP_AUTH_PROXY_PATHS], service: proxyBackend });
  }
  if (changes.length === 0) return { ok: true, map, changes };
  const next: LiveUrlMap = {
    ...map,
    pathMatchers: (map.pathMatchers ?? []).map((m) =>
      m !== matcher ? m : { ...m, pathRules: rules },
    ),
  };
  return { ok: true, map: next, changes };
}

const COMPUTE_API = "https://compute.googleapis.com/compute/v1";
const OPERATION_POLLS = 60;

/**
 * Route the remote-MCP paths to the MCP-Auth-Proxy on a `gcp` install: read
 * the URL map, apply {@link planUrlMapPaths} and write it back through the
 * Compute API (`urlMaps.update` carries the map's fingerprint, so a
 * concurrent write — the admin publishing redirects — fails instead of
 * being lost; a re-run then succeeds).
 */
export async function ensureUrlMapRemoteMcpPaths(
  target: Pick<RemoteMcpTarget, "projectId" | "domain">,
  proxyBackend: string,
  deps: { run?: GcloudRunner; http?: HttpFetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RemoteMcpResult<{ readonly changes: string[] }>> {
  const run = deps.run ?? defaultGcloud;
  const http = deps.http ?? (fetch as unknown as HttpFetch);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const list = await run([
    "compute",
    "url-maps",
    "list",
    "--global",
    `--project=${target.projectId}`,
    "--format=json",
  ]);
  if (!list.ok) return { ok: false, error: `list URL maps: ${list.stderr.trim()}` };
  const maps = parseJson(list.stdout || "[]");
  if (!Array.isArray(maps)) return { ok: false, error: "list URL maps: output is not a JSON list" };
  const plan = planUrlMapPaths(maps as LiveUrlMap[], target.domain, proxyBackend);
  if (!plan.ok) return plan;
  if (plan.changes.length === 0) return { ok: true, changes: [] };
  const token = await run(["auth", "print-access-token"]);
  const bearer = token.ok ? token.stdout.trim() : "";
  if (!bearer)
    return { ok: false, error: `gcloud auth print-access-token: ${token.stderr.trim()}` };
  const headers = { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" };
  const base = `${COMPUTE_API}/projects/${encodeURIComponent(target.projectId)}/global`;
  const put = await http(`${base}/urlMaps/${encodeURIComponent(plan.map.name)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(plan.map),
  });
  if (!put.ok) {
    return {
      ok: false,
      error: `update URL map ${plan.map.name}: HTTP ${put.status} ${(await put.text()).slice(0, 500)}`,
    };
  }
  type Operation = { name?: string; status?: string; error?: { errors?: { message?: string }[] } };
  let op = (parseJson(await put.text()) ?? {}) as Operation;
  for (let i = 0; op.status !== "DONE" && i < OPERATION_POLLS; i++) {
    await sleep(2_000);
    const poll = await http(`${base}/operations/${encodeURIComponent(op.name ?? "")}`, {
      method: "GET",
      headers,
    });
    if (!poll.ok) return { ok: false, error: `poll ${op.name}: HTTP ${poll.status}` };
    op = (parseJson(await poll.text()) ?? {}) as Operation;
  }
  if (op.status !== "DONE") return { ok: false, error: `URL-map update ${op.name} did not finish` };
  const errors = op.error?.errors ?? [];
  if (errors.length > 0) {
    return {
      ok: false,
      error: `URL-map update failed: ${errors.map((e) => e.message).join("; ")}`,
    };
  }
  return { ok: true, changes: plan.changes };
}

/** A Cloud Armor policy's rules, or why they could not be read; `missing` when it does not exist. */
async function describePolicyRules(
  run: GcloudRunner,
  policy: string,
  project: string,
): Promise<
  | { readonly ok: true; readonly rules: LiveArmorRule[] }
  | { readonly ok: false; readonly missing: boolean; readonly error: string }
> {
  const describe = await run([
    "compute",
    "security-policies",
    "describe",
    policy,
    project,
    "--format=json",
  ]);
  if (!describe.ok) {
    return { ok: false, missing: isGcloudNotFound(describe.stderr), error: describe.stderr.trim() };
  }
  const described = parseJson(describe.stdout) as { rules?: LiveArmorRule[] } | null;
  if (!described)
    return { ok: false, missing: false, error: `describe ${policy}: output is not JSON` };
  return { ok: true, rules: described.rules ?? [] };
}

/**
 * #1328 — the MCP-Auth-Proxy's own Cloud Armor policy with the `/api/mcp/*`
 * rule ({@link MCP_ARMOR_RULE}; remote-mcp-edge.ts says why): created when
 * missing, a rule at its priority brought back to spec. Everything else the
 * policy's default rule allows: the proxy rate-limits every route itself
 * (apps/mcp-auth-proxy rate-limit.ts).
 */
export async function ensureMcpArmorRule(
  target: Pick<RemoteMcpTarget, "projectId" | "env">,
  deps: { run?: GcloudRunner } = {},
): Promise<
  RemoteMcpResult<{ readonly policy: string; readonly action: "present" | "created" | "updated" }>
> {
  const run = deps.run ?? defaultGcloud;
  const project = `--project=${target.projectId}`;
  const { policy } = mcpAuthProxyEdgeNames(target.env);
  let described = await describePolicyRules(run, policy, project);
  if (!described.ok && described.missing) {
    const created = await run([
      "compute",
      "security-policies",
      "create",
      policy,
      project,
      `--description=Caelo ${target.env} MCP-Auth-Proxy — remote-MCP throttle`,
      "--quiet",
    ]);
    if (!created.ok) return { ok: false, error: `create ${policy}: ${created.stderr.trim()}` };
    described = await describePolicyRules(run, policy, project);
  }
  if (!described.ok) return { ok: false, error: `describe ${policy}: ${described.error}` };
  const existing = described.rules.find((r) => r.priority === MCP_ARMOR_RULE.priority);
  if (existing && isMcpArmorRule(existing)) return { ok: true, policy, action: "present" };
  const verb = existing ? "update" : "create";
  const r = await run([
    "compute",
    "security-policies",
    "rules",
    verb,
    String(MCP_ARMOR_RULE.priority),
    `--security-policy=${policy}`,
    project,
    ...mcpArmorRuleFlags(),
    "--quiet",
  ]);
  if (!r.ok)
    return {
      ok: false,
      error: `${verb} rule ${MCP_ARMOR_RULE.priority} on ${policy}: ${r.stderr.trim()}`,
    };
  return { ok: true, policy, action: existing ? "updated" : "created" };
}

/**
 * #1328 — drop the `/api/mcp/*` rule #806 put on the gateway's policy, once
 * the URL map no longer sends those paths to the gateway: there it would
 * only exempt matching paths from the OWASP packs and the ban. A rule at the
 * priority that is not exactly the MCP rule is someone's own and stays.
 */
export async function retireGatewayMcpArmorRule(
  target: Pick<RemoteMcpTarget, "projectId" | "env">,
  deps: { run?: GcloudRunner } = {},
): Promise<RemoteMcpResult<{ readonly removed: string | null }>> {
  const run = deps.run ?? defaultGcloud;
  const project = `--project=${target.projectId}`;
  const prefix = `${gcpNamePrefix(target.env)}-waf`;
  const list = await run([
    "compute",
    "security-policies",
    "list",
    project,
    `--filter=name~^${prefix}`,
    "--format=value(name)",
  ]);
  if (!list.ok) return { ok: false, error: `list security policies: ${list.stderr.trim()}` };
  const names = lines(list.stdout);
  if (names.length !== 1) {
    return {
      ok: false,
      error: `expected exactly one ${prefix}* Cloud Armor policy, found ${names.length}`,
    };
  }
  const policy = names[0] as string;
  const described = await describePolicyRules(run, policy, project);
  if (!described.ok) return { ok: false, error: `describe ${policy}: ${described.error}` };
  const rule = described.rules.find((r) => r.priority === MCP_ARMOR_RULE.priority);
  if (!rule || !isMcpArmorRule(rule)) return { ok: true, removed: null };
  const r = await run([
    "compute",
    "security-policies",
    "rules",
    "delete",
    String(MCP_ARMOR_RULE.priority),
    `--security-policy=${policy}`,
    project,
    "--quiet",
  ]);
  if (!r.ok) {
    return {
      ok: false,
      error: `delete rule ${MCP_ARMOR_RULE.priority} on ${policy}: ${r.stderr.trim()}`,
    };
  }
  return { ok: true, removed: policy };
}

/**
 * #1328 — the proxy's serverless NEG and backend service (EXTERNAL_MANAGED,
 * its own Cloud Armor policy), created when missing. Returns the backend's
 * self-link for the URL map.
 */
export async function ensureMcpAuthProxyBackend(
  target: Pick<RemoteMcpTarget, "projectId" | "region" | "env">,
  deps: { run?: GcloudRunner } = {},
): Promise<RemoteMcpResult<{ readonly backend: string; readonly done: string[] }>> {
  const run = deps.run ?? defaultGcloud;
  const project = `--project=${target.projectId}`;
  const names = mcpAuthProxyEdgeNames(target.env);
  const service = fixedCloudRunServiceName("gcp", target.env, "mcp-auth-proxy") as string;
  const done: string[] = [];
  const neg = await run([
    "compute",
    "network-endpoint-groups",
    "describe",
    names.neg,
    `--region=${target.region}`,
    project,
    "--format=value(name)",
  ]);
  if (!neg.ok) {
    if (!isGcloudNotFound(neg.stderr))
      return { ok: false, error: `describe ${names.neg}: ${neg.stderr.trim()}` };
    const created = await run([
      "compute",
      "network-endpoint-groups",
      "create",
      names.neg,
      `--region=${target.region}`,
      project,
      "--network-endpoint-type=serverless",
      `--cloud-run-service=${service}`,
      "--quiet",
    ]);
    if (!created.ok) return { ok: false, error: `create ${names.neg}: ${created.stderr.trim()}` };
    done.push(`created serverless NEG ${names.neg} → ${service}`);
  }
  const backend = await run([
    "compute",
    "backend-services",
    "describe",
    names.backend,
    "--global",
    project,
    "--format=json",
  ]);
  let backendJson: { selfLink?: string; securityPolicy?: string; backends?: { group?: string }[] };
  if (!backend.ok) {
    if (!isGcloudNotFound(backend.stderr)) {
      return { ok: false, error: `describe ${names.backend}: ${backend.stderr.trim()}` };
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
      "--format=json",
      "--quiet",
    ]);
    if (!created.ok)
      return { ok: false, error: `create ${names.backend}: ${created.stderr.trim()}` };
    done.push(`created backend service ${names.backend}`);
    const parsed = parseJson(created.stdout);
    backendJson = (Array.isArray(parsed) ? parsed[0] : parsed) ?? {};
  } else {
    backendJson = (parseJson(backend.stdout) ?? {}) as typeof backendJson;
  }
  // `backend-services create` has no --security-policy: `update` attaches it,
  // here and on a backend an earlier run left without one.
  if (!backendJson.securityPolicy?.endsWith(`/securityPolicies/${names.policy}`)) {
    const set = await run([
      "compute",
      "backend-services",
      "update",
      names.backend,
      "--global",
      project,
      `--security-policy=${names.policy}`,
      "--quiet",
    ]);
    if (!set.ok) return { ok: false, error: `attach ${names.policy}: ${set.stderr.trim()}` };
    done.push(`attached Cloud Armor ${names.policy} to ${names.backend}`);
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
      `--network-endpoint-group-region=${target.region}`,
      "--quiet",
    ]);
    if (!added.ok)
      return { ok: false, error: `add ${names.neg} to ${names.backend}: ${added.stderr.trim()}` };
    done.push(`added ${names.neg} to ${names.backend}`);
  }
  const selfLink =
    backendJson.selfLink ??
    `https://www.googleapis.com/compute/v1/projects/${target.projectId}/global/backendServices/${names.backend}`;
  return { ok: true, backend: selfLink, done };
}

/**
 * The MCP-Auth-Proxy's load-balancer part on `gcp`, in the order that never
 * routes a request to something that is not there yet: its service (created
 * once with the release's image; mcp-auth-proxy-setup.ts), its Cloud Armor
 * policy, NEG and backend, the URL map's MCP rule, and last the old MCP rule
 * off the gateway's policy. A no-op success on `gcp-firebase`, where the
 * proxy is reached on its own run.app URL.
 */
export async function ensureRemoteMcpEdge(
  target: Pick<RemoteMcpTarget, "provider" | "projectId" | "region" | "env" | "domain"> & {
    /** The release's digest-pinned proxy image, for a proxy service that does not exist yet. */
    readonly mcpAuthProxyImageRef: string;
  },
  deps: { run?: GcloudRunner; http?: HttpFetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RemoteMcpResult<{ readonly done: string[] }>> {
  if (target.provider !== "gcp") return { ok: true, done: [] };
  const run = deps.run ?? defaultGcloud;
  const done: string[] = [];
  const service = await ensureMcpAuthProxyServiceGcp({ ...target, provider: "gcp" }, run);
  if (service.status === "failed")
    return { ok: false, error: `${service.id}: ${service.error ?? ""}` };
  done.push(`${service.id}: ${service.status}`);
  const armor = await ensureMcpArmorRule(target, { run });
  if (!armor.ok) return { ok: false, error: `Cloud Armor: ${armor.error}` };
  done.push(`Cloud Armor rule ${MCP_ARMOR_RULE.priority} on ${armor.policy}: ${armor.action}`);
  const backend = await ensureMcpAuthProxyBackend(target, { run });
  if (!backend.ok) return { ok: false, error: `backend: ${backend.error}` };
  done.push(...backend.done);
  const paths = await ensureUrlMapRemoteMcpPaths(target, backend.backend, deps);
  if (!paths.ok) return { ok: false, error: `URL map: ${paths.error}` };
  done.push(
    paths.changes.length > 0
      ? `URL map: ${paths.changes.join("; ")}`
      : "URL map: remote-MCP paths already routed to the MCP-Auth-Proxy",
  );
  const retired = await retireGatewayMcpArmorRule(target, { run });
  if (!retired.ok) return { ok: false, error: `gateway Cloud Armor: ${retired.error}` };
  if (retired.removed) {
    done.push(`removed the remote-MCP rule ${MCP_ARMOR_RULE.priority} from ${retired.removed}`);
  }
  return { ok: true, done };
}

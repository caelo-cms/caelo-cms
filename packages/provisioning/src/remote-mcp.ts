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
 *   - {@link ensureRemoteMcpEdge} (`gcp` only): the load balancer's part for
 *     installs whose URL map / Cloud Armor policy predate it — the
 *     `/.well-known/oauth-*` path rules (the stack ignores `pathRules` after
 *     creation, gcp-url-map.ts) and the `/api/mcp/*` Cloud Armor rule
 *     (remote-mcp-edge.ts).
 *
 * The secrets, the IAM bindings, the gateway's secret volume and timeout
 * come through the shared contract like everything else
 * (runtime-secrets.ts, stack-contract.ts, upgrade/app-roll.ts).
 *
 * The same identity env carries what the admin's Google sign-in needs
 * (#914): its own URL and the project's Google organisation domain
 * ({@link resolveGoogleOrgDomain}).
 *
 * Nothing here enables remote MCP: that happens when the Owner sets up the
 * install's Google sign-in client (Settings → Google sign-in). Until then
 * the gateway answers 503 `remote_mcp_not_configured`.
 */

import { GCP_PUBLIC_BASE_PATHS } from "@caelo-cms/shared";
import { gcloud as defaultGcloud } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { gcpNamePrefix } from "./gcp-names.js";
import {
  isMcpArmorRule,
  type LiveArmorRule,
  MCP_ARMOR_RULE,
  mcpArmorRuleFlags,
} from "./remote-mcp-edge.js";
import type { HttpFetch } from "./runtime-secrets.js";
import {
  type CloudRunSlug,
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
  const adminUrl = await url(target.services.admin);
  const gatewayUrl = await url(target.services.gateway);
  if (!adminUrl || !gatewayUrl) {
    return {
      ok: false,
      error: `read the Cloud Run URL of the ${adminUrl ? "gateway" : "admin"} service (${adminUrl ? target.services.gateway : target.services.admin})`,
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
      gatewayServiceUrl: gatewayUrl,
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
  for (const slug of ["admin", "gateway"] as const) {
    const prefix = `${gcpNamePrefix(base.env)}-${slug}`;
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
  const drift: Record<CloudRunSlug, EnvChange[]> = { admin: [], gateway: [] };
  for (const slug of ["admin", "gateway"] as const) {
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
  | { readonly ok: true; readonly map: LiveUrlMap; readonly added: string[] }
  | { readonly ok: false; readonly error: string };

/**
 * The URL map with every {@link GCP_PUBLIC_BASE_PATHS} entry routed like
 * `/api/*` (to the gateway). Only the rule that carries `/api/*` changes;
 * redirect rules the admin wrote stay as they are. `added` is empty when the
 * map is already complete.
 */
export function planUrlMapPaths(maps: readonly LiveUrlMap[], siteHost: string): UrlMapPathsPlan {
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
  const gatewayRule = matcher?.pathRules?.find(
    (r) => r.service !== undefined && r.urlRedirect === undefined && r.paths.includes("/api/*"),
  );
  if (!matcher || !gatewayRule) {
    return {
      ok: false,
      error: `URL map ${map.name} has no /api/* rule to the gateway in path matcher ${pathMatcher}; re-run the installer to restore the load balancer`,
    };
  }
  const added = GCP_PUBLIC_BASE_PATHS.filter((p) => !gatewayRule.paths.includes(p));
  if (added.length === 0) return { ok: true, map, added };
  const next: LiveUrlMap = {
    ...map,
    pathMatchers: (map.pathMatchers ?? []).map((m) =>
      m !== matcher
        ? m
        : {
            ...m,
            pathRules: (m.pathRules ?? []).map((r) =>
              r === gatewayRule ? { ...r, paths: [...r.paths, ...added] } : r,
            ),
          },
    ),
  };
  return { ok: true, map: next, added };
}

const COMPUTE_API = "https://compute.googleapis.com/compute/v1";
const OPERATION_POLLS = 60;

/**
 * Route the remote-MCP discovery paths to the gateway on an existing `gcp`
 * install: read the URL map, add the missing paths to its `/api/*` rule and
 * write it back through the Compute API (`urlMaps.update` carries the map's
 * fingerprint, so a concurrent write — the admin publishing redirects —
 * fails instead of being lost; a re-run then succeeds).
 */
export async function ensureUrlMapRemoteMcpPaths(
  target: Pick<RemoteMcpTarget, "projectId" | "domain">,
  deps: { run?: GcloudRunner; http?: HttpFetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RemoteMcpResult<{ readonly added: string[] }>> {
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
  const plan = planUrlMapPaths(maps as LiveUrlMap[], target.domain);
  if (!plan.ok) return plan;
  if (plan.added.length === 0) return { ok: true, added: [] };
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
  return { ok: true, added: plan.added };
}

/**
 * Give the gateway's Cloud Armor policy the `/api/mcp/*` rule
 * ({@link MCP_ARMOR_RULE}): create it, or bring a rule at its priority back
 * to spec.
 */
export async function ensureMcpArmorRule(
  target: Pick<RemoteMcpTarget, "projectId" | "env">,
  deps: { run?: GcloudRunner } = {},
): Promise<
  RemoteMcpResult<{ readonly policy: string; readonly action: "present" | "created" | "updated" }>
> {
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
  const describe = await run([
    "compute",
    "security-policies",
    "describe",
    policy,
    project,
    "--format=json",
  ]);
  if (!describe.ok) return { ok: false, error: `describe ${policy}: ${describe.stderr.trim()}` };
  const described = parseJson(describe.stdout) as { rules?: LiveArmorRule[] } | null;
  if (!described) return { ok: false, error: `describe ${policy}: output is not JSON` };
  const rules = described.rules ?? [];
  const existing = rules.find((r) => r.priority === MCP_ARMOR_RULE.priority);
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

/** Both load-balancer parts on `gcp`; a no-op success on `gcp-firebase`. */
export async function ensureRemoteMcpEdge(
  target: Pick<RemoteMcpTarget, "provider" | "projectId" | "env" | "domain">,
  deps: { run?: GcloudRunner; http?: HttpFetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RemoteMcpResult<{ readonly done: string[] }>> {
  if (target.provider !== "gcp") return { ok: true, done: [] };
  const done: string[] = [];
  const armor = await ensureMcpArmorRule(target, deps);
  if (!armor.ok) return { ok: false, error: `Cloud Armor: ${armor.error}` };
  done.push(`Cloud Armor rule ${MCP_ARMOR_RULE.priority} on ${armor.policy}: ${armor.action}`);
  const paths = await ensureUrlMapRemoteMcpPaths(target, deps);
  if (!paths.ok) return { ok: false, error: `URL map: ${paths.error}` };
  done.push(
    paths.added.length > 0
      ? `URL map: routed ${paths.added.join(", ")} to the gateway`
      : "URL map: discovery paths already routed to the gateway",
  );
  return { ok: true, done };
}

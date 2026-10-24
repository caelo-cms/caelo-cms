// SPDX-License-Identifier: MPL-2.0

/**
 * `cms-provision admin-domain enable` — serve a gcp-firebase admin at
 * `admin.<domain>` instead of its `*.run.app` URL — and, the same way,
 * `cms-provision staging-domain enable` (#650): serve the protected staging
 * site at `staging.<domain>` from the gateway, which gates and proxies it.
 *
 * The gcp-firebase stack only creates that Cloud Run domain mapping behind
 * `provisionAdminDomain=true`, off by default: Google refuses a mapping
 * unless the CALLER is a verified owner of the domain in Search Console, and
 * the stack runs as the provisioner service account, which never is. So the
 * mapping is created here, as the operator's own gcloud identity — the one
 * that verified (or now verifies) the domain:
 *
 *   1. find the admin Cloud Run service (`caelo-production-admin*`);
 *   2. if the mapping exists already, just report its DNS records;
 *   3. check `gcloud domains list-user-verified`; if neither the apex nor
 *      `admin.<domain>` is verified, start `gcloud domains verify <apex>`
 *      (opens Search Console) and stop — verifying means adding a TXT record,
 *      the one step only the domain's owner can take;
 *   4. create the mapping and print the DNS records to add.
 *
 * The mapping is then owned by this command, not by Pulumi: leave
 * `provisionAdminDomain` false, or the next `pulumi up` tries to create a
 * second one and fails with "already exists".
 *
 * `gcp` installs need none of this — the load balancer serves admin.<domain>
 * from the start.
 */

import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";
import { ensureGcloudComponent } from "./gcloud-components.js";
import { STAGING_HOST_ENV } from "./stack-contract.js";
import { liveContainerEnv } from "./stack-converge.js";

type Run = (args: string[]) => Promise<GcloudResult>;

export interface DnsRecordToAdd {
  readonly name: string;
  readonly type: string;
  readonly value: string;
}

export type AdminDomainResult =
  | { status: "mapped"; hostname: string; created: boolean; records: DnsRecordToAdd[] }
  | { status: "needs-verification"; hostname: string; verifyDomain: string }
  | { status: "failed"; error: string };

/** What `staging-domain enable` reports; same shape as the admin's. */
export type StagingDomainResult = AdminDomainResult;

interface DomainMappingJson {
  status?: { resourceRecords?: { name?: string; type?: string; rrdata?: string }[] };
}

function recordsOf(json: string, hostname: string): DnsRecordToAdd[] {
  const parsed = JSON.parse(json) as DomainMappingJson;
  return (parsed.status?.resourceRecords ?? []).map((r) => ({
    name: r.name ? `${r.name}.${hostname.split(".").slice(1).join(".")}` : hostname,
    type: r.type ?? "CNAME",
    value: r.rrdata ?? "",
  }));
}

interface DomainOpts {
  projectId: string;
  region: string;
  domain: string;
  run?: Run;
  /** Progress lines (the one-time `beta` component install); defaults to stdout. */
  log?: (message: string) => void;
}

function logOf(opts: DomainOpts): (message: string) => void {
  return opts.log ?? ((message: string) => console.log(message));
}

/** The one deployed Cloud Run service of `slug` (Pulumi-suffixed name); also used by staging-admin.ts. */
export async function findService(
  run: Run,
  scope: string[],
  slug: "admin" | "gateway",
): Promise<{ ok: true; service: string } | { ok: false; error: string }> {
  const prefix = `caelo-production-${slug}`;
  const services = await run([
    "run",
    "services",
    "list",
    ...scope,
    `--filter=metadata.name~^${prefix}`,
    "--format=value(metadata.name)",
  ]);
  if (!services.ok) {
    return { ok: false, error: `list Cloud Run services: ${services.stderr.trim()}` };
  }
  const matches = services.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  // Fail closed like the other service lookups: with a leftover service from
  // a failed deploy, picking one would bind the domain to the wrong revision.
  const service = matches.length === 1 ? matches[0] : undefined;
  if (!service) {
    return {
      ok: false,
      error:
        matches.length === 0
          ? `${slug} Cloud Run service not found: no ${prefix}* service`
          : `expected exactly one ${prefix}* Cloud Run service, found ${matches.length} (${matches.join(", ")}); delete the stale one first`,
    };
  }
  return { ok: true, service };
}

export async function enableAdminDomain(opts: DomainOpts): Promise<AdminDomainResult> {
  const run = opts.run ?? defaultGcloud;
  const scope = [`--region=${opts.region}`, `--project=${opts.projectId}`];
  const found = await findService(run, scope, "admin");
  if (!found.ok) return { status: "failed", error: found.error };
  return mapDomain(run, logOf(opts), scope, opts.domain, `admin.${opts.domain}`, found.service);
}

/**
 * #650 — map the install's staging host (its setting, default
 * `staging.<domain>`; any FQDN) to the gateway, which serves the protected
 * staging site. Cloud Run refuses domain-mapped requests while a service's
 * ingress is internal-only, so the gateway's ingress is opened first (the
 * stack declares the same since #650; installs from before keep the old
 * value until this runs). Idempotent like the admin mapping.
 */
export async function enableStagingDomain(
  opts: DomainOpts & { stagingHost: string },
): Promise<StagingDomainResult> {
  const run = opts.run ?? defaultGcloud;
  const scope = [`--region=${opts.region}`, `--project=${opts.projectId}`];
  const found = await findService(run, scope, "gateway");
  if (!found.ok) return { status: "failed", error: found.error };
  const ingress = await run([
    "run",
    "services",
    "describe",
    found.service,
    ...scope,
    '--format=value(metadata.annotations["run.googleapis.com/ingress"])',
  ]);
  if (!ingress.ok) {
    return { status: "failed", error: `read the gateway's ingress: ${ingress.stderr.trim()}` };
  }
  if (ingress.stdout.trim() !== "all") {
    const update = await run([
      "run",
      "services",
      "update",
      found.service,
      ...scope,
      "--ingress=all",
      "--quiet",
    ]);
    if (!update.ok) {
      return {
        status: "failed",
        error: `open the gateway's ingress for the domain mapping: ${update.stderr.trim()}`,
      };
    }
  }
  // Search Console verification: the install domain covers its own
  // subdomains; a host on another domain is verified itself.
  const verifyDomain =
    opts.stagingHost === opts.domain || opts.stagingHost.endsWith(`.${opts.domain}`)
      ? opts.domain
      : opts.stagingHost;
  return mapDomain(run, logOf(opts), scope, verifyDomain, opts.stagingHost, found.service);
}

/** What {@link setAdminStagingHostEnv} did. */
export type AdminStagingEnvResult =
  | { readonly status: "set"; readonly service: string; readonly previous: string | null }
  | { readonly status: "unchanged"; readonly service: string }
  | { readonly status: "failed"; readonly error: string };

/**
 * #1058 — point the admin's `CAELO_STAGING_HOST` at the host
 * `staging-domain enable` just mapped. The database row
 * (`staging_access.staging_host`) is the admin's truth and is set through
 * `staging_access.provision` (staging-admin.ts), but the env var is what
 * provisioning recorded: left on the old host, the seed would restore the
 * old host on a fresh database, and the converge job refuses every
 * cloud-setup update because install.json and the deployed admin disagree
 * (converge-job-gcp.ts `deployedSiteMismatch`). Same variable the upgrade's
 * env contract sets (stack-contract.ts STAGING_HOST_ENV); updating only it
 * keeps every other var exactly as deployed. A new revision only when the
 * value differs, so a re-run is a no-op.
 */
export async function setAdminStagingHostEnv(
  opts: Pick<DomainOpts, "projectId" | "region" | "run"> & { stagingHost: string },
): Promise<AdminStagingEnvResult> {
  const run = opts.run ?? defaultGcloud;
  const scope = [`--region=${opts.region}`, `--project=${opts.projectId}`];
  const found = await findService(run, scope, "admin");
  if (!found.ok) return { status: "failed", error: found.error };
  const described = await run([
    "run",
    "services",
    "describe",
    found.service,
    ...scope,
    "--format=json",
  ]);
  if (!described.ok) {
    return { status: "failed", error: `read the admin's env: ${described.stderr.trim()}` };
  }
  let live: ReturnType<typeof liveContainerEnv>;
  try {
    live = liveContainerEnv(described.stdout);
  } catch {
    return { status: "failed", error: "read the admin's env: gcloud's answer is not JSON" };
  }
  const current = live.get(STAGING_HOST_ENV);
  if (current?.kind === "secret") {
    return {
      status: "failed",
      error: `the admin reads ${STAGING_HOST_ENV} from secret ${current.secret}, not a plain value; run \`cms-provision upgrade\` to bring its env back to the contract, then re-run`,
    };
  }
  if (current?.value === opts.stagingHost) return { status: "unchanged", service: found.service };
  const update = await run([
    "run",
    "services",
    "update",
    found.service,
    ...scope,
    `--update-env-vars=${STAGING_HOST_ENV}=${opts.stagingHost}`,
    "--quiet",
  ]);
  if (!update.ok) {
    return {
      status: "failed",
      error: `set ${STAGING_HOST_ENV} on the admin: ${update.stderr.trim()}`,
    };
  }
  return { status: "set", service: found.service, previous: current?.value ?? null };
}

/** Steps 2–4 of the module doc for `hostname` → `service`. */
async function mapDomain(
  run: Run,
  log: (message: string) => void,
  scope: string[],
  domain: string,
  hostname: string,
  service: string,
): Promise<AdminDomainResult> {
  // Fully managed Cloud Run domain mappings exist only on the beta track: the
  // GA `gcloud run domain-mappings` is Cloud Run for Anthos only. Install the
  // component up front instead of letting gcloud ask for it mid-command.
  const beta = await ensureGcloudComponent("beta", { run, log });
  if (!beta.ok) return { status: "failed", error: beta.error };

  const describeArgs = [
    "beta",
    "run",
    "domain-mappings",
    "describe",
    `--domain=${hostname}`,
    ...scope,
    "--format=json",
  ];
  const existing = await run(describeArgs);
  if (existing.ok) {
    return {
      status: "mapped",
      hostname,
      created: false,
      records: recordsOf(existing.stdout, hostname),
    };
  }

  const verified = await run(["domains", "list-user-verified", "--format=value(id)"]);
  if (!verified.ok) {
    // Expired credentials or a missing gcloud component — not "unverified".
    return { status: "failed", error: `list verified domains: ${verified.stderr.trim()}` };
  }
  const verifiedIds = verified.stdout.split("\n").map((s) => s.trim());
  if (!verifiedIds.includes(domain) && !verifiedIds.includes(hostname)) {
    const verify = await run(["domains", "verify", domain]);
    if (!verify.ok) {
      return {
        status: "failed",
        error: `start domain verification for ${domain}: ${verify.stderr.trim()}`,
      };
    }
    return { status: "needs-verification", hostname, verifyDomain: domain };
  }

  const create = await run([
    "beta",
    "run",
    "domain-mappings",
    "create",
    `--service=${service}`,
    `--domain=${hostname}`,
    ...scope,
    "--quiet",
  ]);
  if (!create.ok) {
    return { status: "failed", error: `create domain mapping: ${create.stderr.trim()}` };
  }
  const created = await run(describeArgs);
  return {
    status: "mapped",
    hostname,
    created: true,
    records: created.ok ? recordsOf(created.stdout, hostname) : [],
  };
}

// SPDX-License-Identifier: MPL-2.0

/**
 * `cms-provision admin-domain enable` — serve a gcp-firebase admin at
 * `admin.<domain>` instead of its `*.run.app` URL.
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

export async function enableAdminDomain(opts: {
  projectId: string;
  region: string;
  domain: string;
  run?: Run;
}): Promise<AdminDomainResult> {
  const run = opts.run ?? defaultGcloud;
  const hostname = `admin.${opts.domain}`;
  const scope = [`--region=${opts.region}`, `--project=${opts.projectId}`];

  const services = await run([
    "run",
    "services",
    "list",
    ...scope,
    "--filter=metadata.name~^caelo-production-admin",
    "--format=value(metadata.name)",
  ]);
  const service = services.ok ? services.stdout.trim().split("\n")[0]?.trim() : "";
  if (!service) {
    return {
      status: "failed",
      error: `admin Cloud Run service not found: ${services.stderr.trim() || "no caelo-production-admin* service"}`,
    };
  }

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
  const verifiedIds = verified.ok ? verified.stdout.split("\n").map((s) => s.trim()) : [];
  if (!verifiedIds.includes(opts.domain) && !verifiedIds.includes(hostname)) {
    await run(["domains", "verify", opts.domain]);
    return { status: "needs-verification", hostname, verifyDomain: opts.domain };
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

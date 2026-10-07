// SPDX-License-Identifier: MPL-2.0

/**
 * MCP access through IAP (issue #37), for installs that exist already.
 *
 * External MCP clients reach the IAP-protected admin with a JWT signed by a
 * dedicated service account (see packages/mcp-server/src/ingress-auth.ts).
 * New installs get that SA from the Pulumi stacks; `cms-provision upgrade`
 * calls {@link ensureMcpIapAccess} so installs provisioned before it get the
 * same setup on their next upgrade, with no operator config:
 *
 *   1. service account `caelo-mcp@<project>` (created if missing)
 *   2. `roles/iap.httpsResourceAccessor` for that SA on the admin's IAP
 *      resource (Cloud Run service on gcp-firebase, LB backend on gcp)
 *   3. `roles/iam.serviceAccountTokenCreator` on that SA for every user /
 *      group the IAP policy already lets in — exactly the people who can
 *      open the admin in a browser can also drive it over MCP
 *
 * Every step is an additive IAM binding or a create-if-missing, so re-running
 * is a no-op. The caller puts the returned email into the admin's
 * `CAELO_MCP_IAP_SERVICE_ACCOUNT` env var, which /security/mcp shows in the
 * `claude mcp add` command.
 */

import { gcloud as defaultGcloud, type GcloudResult } from "./gcloud.js";

export const MCP_IAP_SERVICE_ACCOUNT_ID = "caelo-mcp";

export function mcpIapServiceAccountEmail(projectId: string): string {
  return `${MCP_IAP_SERVICE_ACCOUNT_ID}@${projectId}.iam.gserviceaccount.com`;
}

/** The admin's IAP resource, as `gcloud iap web` addresses it. */
export type IapResource =
  | { readonly kind: "cloud-run"; readonly service: string; readonly region: string }
  | { readonly kind: "backend-services"; readonly service: string };

/** `gcloud iap web …` flags addressing {@link IapResource}. */
export function iapResourceArgs(resource: IapResource): string[] {
  return resource.kind === "cloud-run"
    ? ["--resource-type=cloud-run", `--service=${resource.service}`, `--region=${resource.region}`]
    : ["--resource-type=backend-services", `--service=${resource.service}`];
}

/** Users and groups IAP lets into the admin (service accounts excluded). */
export function iapOperators(policyJson: string): string[] {
  const policy = JSON.parse(policyJson) as {
    bindings?: { role: string; members?: string[]; condition?: unknown }[];
  };
  const members = (policy.bindings ?? [])
    .filter((b) => b.role === "roles/iap.httpsResourceAccessor" && !b.condition)
    .flatMap((b) => b.members ?? []);
  return [...new Set(members.filter((m) => m.startsWith("user:") || m.startsWith("group:")))];
}

const SA_NOT_YET_VISIBLE = /does not exist|not found|NOT_FOUND/i;
const RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000];

export async function ensureMcpIapAccess(opts: {
  projectId: string;
  resource: IapResource;
  run?: (args: string[]) => Promise<GcloudResult>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  { ok: true; serviceAccount: string; operators: string[] } | { ok: false; error: string }
> {
  const run = opts.run ?? defaultGcloud;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const project = `--project=${opts.projectId}`;
  const sa = mcpIapServiceAccountEmail(opts.projectId);

  // A freshly created SA takes a few seconds to become bindable.
  const withRetry = async (args: string[]): Promise<GcloudResult> => {
    let r = await run(args);
    for (const delay of RETRY_DELAYS_MS) {
      if (r.ok || !SA_NOT_YET_VISIBLE.test(r.stderr)) break;
      await sleep(delay);
      r = await run(args);
    }
    return r;
  };

  const describe = await run([
    "iam",
    "service-accounts",
    "describe",
    sa,
    project,
    "--format=value(email)",
  ]);
  if (!describe.ok) {
    const create = await run([
      "iam",
      "service-accounts",
      "create",
      MCP_IAP_SERVICE_ACCOUNT_ID,
      "--display-name=Caelo MCP (IAP ingress)",
      "--description=Signs the IAP credential external MCP clients use to reach the admin (issue #37).",
      project,
    ]);
    if (!create.ok && !/already exists/i.test(create.stderr)) {
      return { ok: false, error: `create ${sa}: ${create.stderr.trim()}` };
    }
  }

  const policy = await run([
    "iap",
    "web",
    "get-iam-policy",
    ...iapResourceArgs(opts.resource),
    project,
    "--format=json",
  ]);
  if (!policy.ok) return { ok: false, error: `read IAP policy: ${policy.stderr.trim()}` };
  const operators = iapOperators(policy.stdout);

  const allow = await withRetry([
    "iap",
    "web",
    "add-iam-policy-binding",
    ...iapResourceArgs(opts.resource),
    `--member=serviceAccount:${sa}`,
    "--role=roles/iap.httpsResourceAccessor",
    "--condition=None",
    project,
    "--quiet",
  ]);
  if (!allow.ok) return { ok: false, error: `allow ${sa} on IAP: ${allow.stderr.trim()}` };

  for (const member of operators) {
    const grant = await withRetry([
      "iam",
      "service-accounts",
      "add-iam-policy-binding",
      sa,
      `--member=${member}`,
      "--role=roles/iam.serviceAccountTokenCreator",
      "--condition=None",
      project,
      "--quiet",
    ]);
    if (!grant.ok)
      return { ok: false, error: `let ${member} sign as ${sa}: ${grant.stderr.trim()}` };
  }
  return { ok: true, serviceAccount: sa, operators };
}

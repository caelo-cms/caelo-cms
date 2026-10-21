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
 * is a no-op. Bindings already in place are not written again, and the
 * result names the ones this run added: IAM applies a new binding only
 * after a while (up to 7 minutes), so the upgrade's health check waits for
 * a refusal to clear only when this run just granted something (#734). The caller puts the returned email into the admin's
 * `CAELO_MCP_IAP_SERVICE_ACCOUNT` env var, which /settings/mcp shows in the
 * `claude mcp add` command.
 */

import { gcloud as defaultGcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import { MCP_IAP_SERVICE_ACCOUNT_ID, mcpIapServiceAccountEmail } from "./gcp-names.js";
import { policyGrants } from "./stack-converge.js";

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

/**
 * Whether a policy read (JSON) grants `role` to `member`; false when the
 * policy could not be read or parsed, so the binding is written.
 */
function readGrants(policyJson: string | null, role: string, member: string): boolean {
  if (policyJson === null) return false;
  try {
    return policyGrants(policyJson, role, member);
  } catch {
    return false;
  }
}

export async function ensureMcpIapAccess(opts: {
  projectId: string;
  resource: IapResource;
  run?: GcloudRunner;
  sleep?: Sleep;
}): Promise<
  | {
      ok: true;
      serviceAccount: string;
      operators: string[];
      /** The bindings this run added (empty: everything was in place). */
      granted: string[];
    }
  | { ok: false; error: string }
> {
  const run = opts.run ?? defaultGcloud;
  const sleep = opts.sleep ?? realSleep;
  const project = `--project=${opts.projectId}`;
  const sa = mcpIapServiceAccountEmail(opts.projectId);

  // A freshly created SA takes a few seconds to become bindable.
  const withRetry = (args: string[]) => runWithRetry(run, sleep, args);

  const describe = await run([
    "iam",
    "service-accounts",
    "describe",
    sa,
    project,
    "--format=value(email)",
  ]);
  const created = !describe.ok;
  if (created) {
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
  const granted: string[] = [];

  const ACCESSOR = "roles/iap.httpsResourceAccessor";
  if (!readGrants(policy.stdout, ACCESSOR, `serviceAccount:${sa}`)) {
    const allow = await withRetry([
      "iap",
      "web",
      "add-iam-policy-binding",
      ...iapResourceArgs(opts.resource),
      `--member=serviceAccount:${sa}`,
      `--role=${ACCESSOR}`,
      "--condition=None",
      project,
      "--quiet",
    ]);
    if (!allow.ok) return { ok: false, error: `allow ${sa} on IAP: ${allow.stderr.trim()}` };
    granted.push(`${ACCESSOR} → serviceAccount:${sa}`);
  }

  const TOKEN_CREATOR = "roles/iam.serviceAccountTokenCreator";
  // A just-created account has no policy yet; an unreadable one is rewritten.
  const saPolicy = created
    ? null
    : await run(["iam", "service-accounts", "get-iam-policy", sa, project, "--format=json"]);
  const saPolicyJson = saPolicy?.ok ? saPolicy.stdout : null;
  for (const member of operators) {
    if (readGrants(saPolicyJson, TOKEN_CREATOR, member)) continue;
    const grant = await withRetry([
      "iam",
      "service-accounts",
      "add-iam-policy-binding",
      sa,
      `--member=${member}`,
      `--role=${TOKEN_CREATOR}`,
      "--condition=None",
      project,
      "--quiet",
    ]);
    if (!grant.ok)
      return { ok: false, error: `let ${member} sign as ${sa}: ${grant.stderr.trim()}` };
    granted.push(`${TOKEN_CREATOR} → ${member}`);
  }
  return { ok: true, serviceAccount: sa, operators, granted };
}

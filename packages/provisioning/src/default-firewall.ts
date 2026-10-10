// SPDX-License-Identifier: MPL-2.0

/**
 * Delete the internet-open SSH/RDP firewall rules GCP auto-creates on a
 * project's `default` network ({@link ABSENT_DEFAULT_FIREWALL_RULES}).
 *
 * Why gcloud and not Pulumi: the rules are created by GCP when Compute Engine
 * is enabled, not by our stacks, so Pulumi does not manage them. Pulumi can
 * only delete a resource after importing it into the stack, and then a
 * `pulumi destroy` or a resource rename would put nothing back, while every
 * project that never had them (org policy `compute.skipDefaultNetworkCreation`,
 * or rules already deleted) would fail the import. The removal is a one-way
 * convergence, which is what the provisioner's gcloud steps are for: the
 * wizard runs it on fresh installs and `upgrade` (via ensureStackInvariants)
 * on existing ones.
 *
 * Only a rule in exactly the shape GCP creates is deleted. A rule with the
 * same name but a different shape (narrowed source ranges, other ports,
 * target tags, another network) is a deliberate change by someone, so it is
 * reported with the next step instead of deleted.
 */

import { gcloud as defaultGcloud } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import {
  ABSENT_DEFAULT_FIREWALL_RULES,
  type AbsentDefaultFirewallRule,
  GCP_DEFAULT_NETWORK,
} from "./stack-contract.js";
import type { InvariantOutcome } from "./stack-converge.js";

/** A firewall rule as `gcloud compute firewall-rules list --format=json` returns it. */
export interface LiveFirewallRule {
  readonly name: string;
  readonly network?: string;
  readonly direction?: string;
  readonly sourceRanges?: readonly string[];
  readonly sourceTags?: readonly string[];
  readonly sourceServiceAccounts?: readonly string[];
  readonly targetTags?: readonly string[];
  readonly targetServiceAccounts?: readonly string[];
  readonly destinationRanges?: readonly string[];
  readonly allowed?: readonly { readonly IPProtocol: string; readonly ports?: readonly string[] }[];
  readonly denied?: readonly unknown[];
}

/**
 * gcloud's error when Compute Engine is not enabled on the project. Without
 * Compute Engine there is no `default` network, so there is nothing to remove.
 */
const COMPUTE_DISABLED =
  /SERVICE_DISABLED|accessNotConfigured|has not been used in project|API \[compute\.googleapis\.com\] not enabled|compute\.googleapis\.com.*(?:disabled|not enabled)/i;

const empty = (xs: readonly unknown[] | undefined) => (xs ?? []).length === 0;

/** The last path segment of a network URL (`…/global/networks/default` → `default`). */
function networkName(network: string | undefined): string {
  return (network ?? "").split("/").pop() ?? "";
}

/**
 * Whether `live` is the rule exactly as GCP auto-creates it: ingress on the
 * `default` network, from `0.0.0.0/0` only, allowing only `protocol:port`,
 * applying to every instance. Priority, description, logging and the
 * disabled flag are ignored — changing those does not narrow who can connect.
 */
export function isStockDefaultRule(
  live: LiveFirewallRule,
  expected: AbsentDefaultFirewallRule,
): boolean {
  const allowed = live.allowed ?? [];
  return (
    live.name === expected.name &&
    networkName(live.network) === GCP_DEFAULT_NETWORK &&
    (live.direction ?? "INGRESS") === "INGRESS" &&
    (live.sourceRanges ?? []).length === 1 &&
    live.sourceRanges?.[0] === "0.0.0.0/0" &&
    empty(live.sourceTags) &&
    empty(live.sourceServiceAccounts) &&
    empty(live.targetTags) &&
    empty(live.targetServiceAccounts) &&
    empty(live.destinationRanges) &&
    empty(live.denied) &&
    allowed.length === 1 &&
    allowed[0]?.IPProtocol === expected.protocol &&
    (allowed[0]?.ports ?? []).length === 1 &&
    allowed[0]?.ports?.[0] === expected.port
  );
}

/** One-line description of a live rule, for the "left in place" report. */
function describeRule(live: LiveFirewallRule): string {
  const allowed = (live.allowed ?? [])
    .map((a) => `${a.IPProtocol}${a.ports?.length ? `:${a.ports.join(",")}` : ""}`)
    .join(" ");
  const parts = [
    `network ${networkName(live.network) || "?"}`,
    `${live.direction ?? "INGRESS"}`,
    `allow ${allowed || "(none)"}`,
    `from ${(live.sourceRanges ?? []).join(",") || "(no ranges)"}`,
  ];
  if (!empty(live.sourceTags)) parts.push(`source tags ${live.sourceTags?.join(",")}`);
  if (!empty(live.targetTags)) parts.push(`target tags ${live.targetTags?.join(",")}`);
  if (!empty(live.targetServiceAccounts)) {
    parts.push(`target SAs ${live.targetServiceAccounts?.join(",")}`);
  }
  return parts.join(", ");
}

/**
 * Delete each {@link ABSENT_DEFAULT_FIREWALL_RULES} rule present on the
 * project in its stock shape. Idempotent; never throws for a gcloud failure.
 * One outcome per rule: `present` = the rule is absent (nothing to do, also
 * when Compute Engine is disabled), `applied` = deleted now, `failed` = could
 * not be read or deleted, or exists in a customised shape and was left in
 * place. Every failure is `warn`: the rules open nothing Caelo runs, so they
 * never block an install or upgrade — but the report says what to do.
 *
 * @example
 *   const outcomes = await removeDefaultIngressRules("acme");
 *   // → [{ id: "firewall rule default-allow-ssh (tcp:22 from 0.0.0.0/0)",
 *   //      status: "applied", … }, { id: "… default-allow-rdp …", status: "present", … }]
 */
export async function removeDefaultIngressRules(
  projectId: string,
  deps: { run?: GcloudRunner } = {},
): Promise<InvariantOutcome[]> {
  const run = deps.run ?? defaultGcloud;
  const project = `--project=${projectId}`;
  const names = ABSENT_DEFAULT_FIREWALL_RULES.map((r) => r.name);
  const outcomeBase = (rule: AbsentDefaultFirewallRule) => ({
    id: `firewall rule ${rule.name} (${rule.protocol}:${rule.port} from 0.0.0.0/0)`,
    onFailure: "warn" as const,
    why: rule.why,
  });

  const list = await run([
    "compute",
    "firewall-rules",
    "list",
    project,
    `--filter=name=(${names.join(" ")})`,
    "--format=json",
  ]);
  if (!list.ok && COMPUTE_DISABLED.test(list.stderr)) {
    return ABSENT_DEFAULT_FIREWALL_RULES.map((rule) => ({
      ...outcomeBase(rule),
      status: "present" as const,
    }));
  }
  let live: LiveFirewallRule[] | null = null;
  if (list.ok) {
    try {
      const parsed: unknown = JSON.parse(list.stdout || "[]");
      if (Array.isArray(parsed)) live = parsed as LiveFirewallRule[];
    } catch {
      live = null;
    }
  }
  if (live === null) {
    const error = list.ok
      ? `unexpected output from gcloud compute firewall-rules list: ${list.stdout.slice(0, 200)}`
      : list.stderr.trim();
    return ABSENT_DEFAULT_FIREWALL_RULES.map((rule) => ({
      ...outcomeBase(rule),
      status: "failed" as const,
      error: `${error}\n    Could not check for the rule. Re-run once the cause is fixed, or delete it yourself: gcloud compute firewall-rules delete ${rule.name} ${project}`,
    }));
  }

  const outcomes: InvariantOutcome[] = [];
  for (const rule of ABSENT_DEFAULT_FIREWALL_RULES) {
    const base = outcomeBase(rule);
    const found = live.find((r) => r.name === rule.name);
    if (!found) {
      outcomes.push({ ...base, status: "present" });
      continue;
    }
    if (!isStockDefaultRule(found, rule)) {
      outcomes.push({
        ...base,
        status: "failed",
        error:
          `${rule.name} exists but is not GCP's auto-created rule (${describeRule(found)}), so Caelo left it in place.\n` +
          `    If nothing on this project needs it: gcloud compute firewall-rules delete ${rule.name} ${project}\n` +
          "    If it is intentional, rename it (create a copy under another name, then delete this one) so upgrades stop reporting it.",
      });
      continue;
    }
    const del = await run(["compute", "firewall-rules", "delete", rule.name, project, "--quiet"]);
    if (del.ok) {
      outcomes.push({ ...base, status: "applied" });
      continue;
    }
    // Deleted concurrently between list and delete: the rule is gone either way.
    if (/was not found|NOT_FOUND/i.test(del.stderr)) {
      outcomes.push({ ...base, status: "present" });
      continue;
    }
    outcomes.push({
      ...base,
      status: "failed",
      error: `${del.stderr.trim()}\n    Deleting needs compute.firewalls.delete on the project (roles/compute.securityAdmin). Re-run with an account that has it, or: gcloud compute firewall-rules delete ${rule.name} ${project}`,
    });
  }
  return outcomes;
}

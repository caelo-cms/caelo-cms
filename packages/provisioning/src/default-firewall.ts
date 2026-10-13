// SPDX-License-Identifier: MPL-2.0

/**
 * Delete the firewall rules GCP auto-creates on a project's `default` network
 * (`default-allow-ssh`, `-rdp`, `-icmp`, `-internal`;
 * {@link ABSENT_DEFAULT_FIREWALL_RULES}).
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
 *
 * `default-allow-internal` carries traffic between VMs on the `default`
 * network. Caelo puts nothing there (the stacks attach Cloud Run to their own
 * VPC; default-firewall.test.ts pins that), but someone else may run VMs on
 * it. So that rule is only deleted when the project is not a Shared VPC host
 * (service projects' VMs could sit on its `default` network without showing
 * up in this project) and `gcloud compute instances list` shows no instance
 * on the `default` network; otherwise it is left in place and reported.
 */

import { gcloud as defaultGcloud } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import {
  ABSENT_DEFAULT_FIREWALL_RULES,
  type AbsentDefaultFirewallRule,
  describeFirewallShape,
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

/** A VM instance as `gcloud compute instances list --format=json` returns it. */
interface LiveInstance {
  readonly name?: string;
  readonly zone?: string;
  readonly networkInterfaces?: readonly { readonly network?: string }[];
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

/** Order-insensitive identity of an `allowed` list: `["icmp", "tcp:0-65535", …]`. */
function allowKeys(
  allowed: readonly { readonly IPProtocol: string; readonly ports?: readonly string[] }[],
): string[] {
  return allowed
    .map((a) => `${a.IPProtocol.toLowerCase()}${a.ports?.length ? `:${a.ports.join(",")}` : ""}`)
    .sort();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sortedB = [...b].sort();
  return a.length === b.length && [...a].sort().every((x, i) => x === sortedB[i]);
}

/**
 * Whether `live` is the rule exactly as GCP auto-creates it: ingress on the
 * `default` network, from exactly the expected source ranges, allowing
 * exactly the expected protocols and ports, applying to every instance.
 * Priority, description, logging and the disabled flag are ignored —
 * changing those does not narrow who can connect.
 */
export function isStockDefaultRule(
  live: LiveFirewallRule,
  expected: AbsentDefaultFirewallRule,
): boolean {
  return (
    live.name === expected.name &&
    networkName(live.network) === GCP_DEFAULT_NETWORK &&
    (live.direction ?? "INGRESS") === "INGRESS" &&
    sameSet(live.sourceRanges ?? [], expected.sourceRanges) &&
    empty(live.sourceTags) &&
    empty(live.sourceServiceAccounts) &&
    empty(live.targetTags) &&
    empty(live.targetServiceAccounts) &&
    empty(live.destinationRanges) &&
    empty(live.denied) &&
    sameSet(allowKeys(live.allowed ?? []), allowKeys(expected.allowed))
  );
}

/** One-line description of a live rule, for the "left in place" report. */
function describeRule(live: LiveFirewallRule): string {
  const parts = [
    `network ${networkName(live.network) || "?"}`,
    `${live.direction ?? "INGRESS"}`,
    `allow ${describeFirewallShape(live.allowed ?? [], live.sourceRanges ?? [])}`,
  ];
  if (!empty(live.sourceTags)) parts.push(`source tags ${live.sourceTags?.join(",")}`);
  if (!empty(live.targetTags)) parts.push(`target tags ${live.targetTags?.join(",")}`);
  if (!empty(live.targetServiceAccounts)) {
    parts.push(`target SAs ${live.targetServiceAccounts?.join(",")}`);
  }
  return parts.join(", ");
}

/**
 * Whether the project is a Shared VPC host, from the Compute project's
 * `xpnProjectStatus`. A host's networks can carry VMs of attached service
 * projects that this project's instance list does not show.
 */
async function isSharedVpcHost(
  run: GcloudRunner,
  project: string,
): Promise<{ ok: true; host: boolean } | { ok: false; error: string }> {
  const r = await run([
    "compute",
    "project-info",
    "describe",
    project,
    "--format=value(xpnProjectStatus)",
  ]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() };
  return { ok: true, host: r.stdout.trim() === "HOST" };
}

/**
 * The VM instances on the project's `default` network, as `zone/name`, or an
 * error when they could not be listed. Compute Engine disabled means no VMs.
 */
async function instancesOnDefaultNetwork(
  run: GcloudRunner,
  project: string,
): Promise<{ ok: true; instances: string[] } | { ok: false; error: string }> {
  const r = await run([
    "compute",
    "instances",
    "list",
    project,
    "--format=json(name,zone,networkInterfaces[].network)",
  ]);
  if (!r.ok) {
    if (COMPUTE_DISABLED.test(r.stderr)) return { ok: true, instances: [] };
    return { ok: false, error: r.stderr.trim() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout || "[]");
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: `unexpected output from gcloud compute instances list: ${r.stdout.slice(0, 200)}`,
    };
  }
  const instances = (parsed as LiveInstance[])
    .filter((i) =>
      (i.networkInterfaces ?? []).some((n) => networkName(n.network) === GCP_DEFAULT_NETWORK),
    )
    .map((i) => `${networkName(i.zone) || "?"}/${i.name ?? "?"}`);
  return { ok: true, instances };
}

/**
 * Delete each {@link ABSENT_DEFAULT_FIREWALL_RULES} rule present on the
 * project in its stock shape. Idempotent; never throws for a gcloud failure.
 * One outcome per rule: `present` = the rule is absent (nothing to do, also
 * when Compute Engine is disabled), `applied` = deleted now, `failed` = could
 * not be read or deleted, exists in a customised shape, or (for
 * `default-allow-internal`) VMs on the `default` network may still rely on
 * it (VMs found, Shared VPC host, or either unknown) — and was left in place. Every failure is `warn`: the rules open nothing
 * Caelo runs, so they never block an install or upgrade — but the report
 * says what to do.
 *
 * @example
 *   const outcomes = await removeDefaultFirewallRules("acme");
 *   // → [{ id: "firewall rule default-allow-ssh (tcp:22 from 0.0.0.0/0)",
 *   //      status: "applied", … }, { id: "… default-allow-rdp …", status: "present", … }, …]
 */
export async function removeDefaultFirewallRules(
  projectId: string,
  deps: { run?: GcloudRunner } = {},
): Promise<InvariantOutcome[]> {
  const run = deps.run ?? defaultGcloud;
  const project = `--project=${projectId}`;
  const names = ABSENT_DEFAULT_FIREWALL_RULES.map((r) => r.name);
  const outcomeBase = (rule: AbsentDefaultFirewallRule) => ({
    id: `firewall rule ${rule.name} (${describeFirewallShape(rule.allowed, rule.sourceRanges)})`,
    onFailure: "warn" as const,
    why: rule.why,
  });
  const deleteCommand = (rule: AbsentDefaultFirewallRule) =>
    `gcloud compute firewall-rules delete ${rule.name} ${project}`;

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
      error: `${error}\n    Could not check for the rule. Re-run once the cause is fixed, or delete it yourself: ${deleteCommand(rule)}`,
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
          `    If nothing on this project needs it: ${deleteCommand(rule)}\n` +
          "    If it is intentional, rename it (create a copy under another name, then delete this one) so upgrades stop reporting it.",
      });
      continue;
    }
    if (rule.guardsInstanceTraffic) {
      const xpn = await isSharedVpcHost(run, project);
      if (!xpn.ok || xpn.host) {
        outcomes.push({
          ...base,
          status: "failed",
          error: xpn.ok
            ? `This project is a Shared VPC host: VMs in attached service projects may use its default network and rely on ${rule.name}, so Caelo left it in place.\n` +
              `    Check the service projects (gcloud compute shared-vpc list-associated-resources ${projectId}). If none of their VMs use the default network: ${deleteCommand(rule)}`
            : `${xpn.error}\n    Could not check whether this project is a Shared VPC host, so Caelo left ${rule.name} in place.\n` +
              `    Re-run once the cause is fixed (needs compute.projects.get), or if no VM uses the default network: ${deleteCommand(rule)}`,
        });
        continue;
      }
      const vms = await instancesOnDefaultNetwork(run, project);
      if (!vms.ok) {
        outcomes.push({
          ...base,
          status: "failed",
          error:
            `${vms.error}\n    Could not check whether VMs on the default network still use ${rule.name}, so Caelo left it in place.\n` +
            `    Re-run once the cause is fixed (needs compute.instances.list), or if no VM uses the default network: ${deleteCommand(rule)}`,
        });
        continue;
      }
      if (vms.instances.length > 0) {
        const shown = vms.instances.slice(0, 5).join(", ");
        const more = vms.instances.length > 5 ? ` and ${vms.instances.length - 5} more` : "";
        outcomes.push({
          ...base,
          status: "failed",
          error:
            `${vms.instances.length} VM instance(s) are on the default network (${shown}${more}); deleting ${rule.name} would cut the traffic between them, so Caelo left it in place.\n` +
            "    Caelo provisions nothing on the default network, so these belong to someone else on the project.\n" +
            `    If they do not need to talk to each other: ${deleteCommand(rule)}\n` +
            "    If they do, replace it with a narrower rule under another name (only the ports and target tags they need), then delete this one so upgrades stop reporting it.",
        });
        continue;
      }
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
      error: `${del.stderr.trim()}\n    Deleting needs compute.firewalls.delete on the project (roles/compute.securityAdmin). Re-run with an account that has it, or: ${deleteCommand(rule)}`,
    });
  }
  return outcomes;
}

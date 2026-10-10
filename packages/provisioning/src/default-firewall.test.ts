// SPDX-License-Identifier: MPL-2.0

/**
 * GCP auto-creates `default-allow-ssh` (tcp:22) and `default-allow-rdp`
 * (tcp:3389) from 0.0.0.0/0 on the `default` network when Compute Engine is
 * enabled; audits flag them on every Caelo install. The wizard and `upgrade`
 * delete them — but only in their stock shape. The fake gcloud answers with
 * what `gcloud compute firewall-rules list --format=json` returns.
 */

import { describe, expect, it } from "bun:test";
import {
  isStockDefaultRule,
  type LiveFirewallRule,
  removeDefaultIngressRules,
} from "./default-firewall.js";
import type { GcloudResult } from "./gcloud.js";
import { ABSENT_DEFAULT_FIREWALL_RULES } from "./stack-contract.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const DEFAULT_NETWORK =
  "https://www.googleapis.com/compute/v1/projects/acme/global/networks/default";

/** A rule exactly as GCP auto-creates it. */
function stock(name: string, port: string): LiveFirewallRule {
  return {
    name,
    network: DEFAULT_NETWORK,
    direction: "INGRESS",
    sourceRanges: ["0.0.0.0/0"],
    allowed: [{ IPProtocol: "tcp", ports: [port] }],
  };
}
const SSH = stock("default-allow-ssh", "22");
const RDP = stock("default-allow-rdp", "3389");

/** Fake gcloud answering `list` and `delete`; records every call. */
function fakeGcloud(list: GcloudResult, del: (name: string) => GcloudResult = () => ok()) {
  const calls: string[] = [];
  const run = async (args: string[]) => {
    calls.push(args.join(" "));
    if (args[2] === "list") return list;
    if (args[2] === "delete") return del(args[3] ?? "");
    throw new Error(`unexpected gcloud call: ${args.join(" ")}`);
  };
  return { run, calls };
}

const LIST_CALL =
  "compute firewall-rules list --project=acme --filter=name=(default-allow-ssh default-allow-rdp) --format=json";
const deletes = (calls: string[]) =>
  calls.filter((c) => c.startsWith("compute firewall-rules delete"));

describe("removeDefaultIngressRules", () => {
  it("deletes the stock SSH + RDP rules on a fresh project", async () => {
    const { run, calls } = fakeGcloud(ok(JSON.stringify([SSH, RDP])));
    const outcomes = await removeDefaultIngressRules("acme", { run });
    expect(calls[0]).toBe(LIST_CALL);
    expect(deletes(calls)).toEqual([
      "compute firewall-rules delete default-allow-ssh --project=acme --quiet",
      "compute firewall-rules delete default-allow-rdp --project=acme --quiet",
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "applied"]);
    expect(outcomes.every((o) => o.onFailure === "warn")).toBe(true);
  });

  it("is a read-only no-op when the rules are already gone", async () => {
    const { run, calls } = fakeGcloud(ok("[]"));
    const outcomes = await removeDefaultIngressRules("acme", { run });
    expect(calls).toEqual([LIST_CALL]);
    expect(outcomes.map((o) => o.status)).toEqual(["present", "present"]);
  });

  it("deletes only the rule that is still there", async () => {
    const { run, calls } = fakeGcloud(ok(JSON.stringify([RDP])));
    const outcomes = await removeDefaultIngressRules("acme", { run });
    expect(deletes(calls)).toEqual([
      "compute firewall-rules delete default-allow-rdp --project=acme --quiet",
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["present", "applied"]);
  });

  it("leaves a customised rule in place and reports it with the next step", async () => {
    const narrowed = { ...SSH, sourceRanges: ["203.0.113.0/24"] };
    const { run, calls } = fakeGcloud(ok(JSON.stringify([narrowed, RDP])));
    const outcomes = await removeDefaultIngressRules("acme", { run });
    expect(deletes(calls)).toEqual([
      "compute firewall-rules delete default-allow-rdp --project=acme --quiet",
    ]);
    const ssh = outcomes[0];
    expect(ssh?.status).toBe("failed");
    expect(ssh?.onFailure).toBe("warn");
    expect(ssh?.error).toContain("not GCP's auto-created rule");
    expect(ssh?.error).toContain("from 203.0.113.0/24");
    expect(ssh?.error).toContain(
      "gcloud compute firewall-rules delete default-allow-ssh --project=acme",
    );
    expect(outcomes[1]?.status).toBe("applied");
  });

  it("is a no-op when Compute Engine is not enabled (no default network)", async () => {
    const { run, calls } = fakeGcloud(
      fail(
        "ERROR: (gcloud.compute.firewall-rules.list) Some requests did not succeed:\n" +
          " - Compute Engine API has not been used in project 42 before or it is disabled. " +
          "Enable it by visiting https://console.developers.google.com/apis/api/compute.googleapis.com/overview?project=42 " +
          "then retry. (reason: SERVICE_DISABLED)",
      ),
    );
    const outcomes = await removeDefaultIngressRules("acme", { run });
    expect(calls).toEqual([LIST_CALL]);
    expect(outcomes.map((o) => o.status)).toEqual(["present", "present"]);
  });

  it("is a no-op when the default network was never created", async () => {
    // Org policy compute.skipDefaultNetworkCreation, or the network was
    // deleted: the list simply has no default-network rules.
    const { run, calls } = fakeGcloud(ok("[]"));
    expect(
      (await removeDefaultIngressRules("acme", { run })).every((o) => o.status === "present"),
    ).toBe(true);
    expect(deletes(calls)).toEqual([]);
  });

  it("reports (warn) when the rules cannot be listed", async () => {
    const { run } = fakeGcloud(fail("ERROR: PERMISSION_DENIED: compute.firewalls.list"));
    const outcomes = await removeDefaultIngressRules("acme", { run });
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "failed"]);
    expect(outcomes[0]?.error).toContain("PERMISSION_DENIED");
  });

  it("reports (warn) a failed delete with the role it needs", async () => {
    const { run } = fakeGcloud(ok(JSON.stringify([SSH])), () =>
      fail(
        "ERROR: Required 'compute.firewalls.delete' permission for 'projects/acme/global/firewalls/default-allow-ssh'",
      ),
    );
    const outcomes = await removeDefaultIngressRules("acme", { run });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.error).toContain("roles/compute.securityAdmin");
  });

  it("treats a rule deleted between list and delete as gone", async () => {
    const { run } = fakeGcloud(ok(JSON.stringify([SSH])), () =>
      fail("ERROR: The resource 'projects/acme/global/firewalls/default-allow-ssh' was not found"),
    );
    const outcomes = await removeDefaultIngressRules("acme", { run });
    expect(outcomes[0]?.status).toBe("present");
  });
});

describe("isStockDefaultRule", () => {
  const ssh = ABSENT_DEFAULT_FIREWALL_RULES.find((r) => r.name === "default-allow-ssh");
  if (!ssh) throw new Error("default-allow-ssh missing from the contract");

  it("matches the rule as GCP creates it, ignoring priority/description/disabled", () => {
    expect(isStockDefaultRule(SSH, ssh)).toBe(true);
    expect(
      isStockDefaultRule(
        { ...SSH, priority: 1000, description: "x", disabled: true } as LiveFirewallRule,
        ssh,
      ),
    ).toBe(true);
  });

  it.each<[string, LiveFirewallRule]>([
    ["narrowed source range", { ...SSH, sourceRanges: ["10.0.0.0/8"] }],
    ["extra source range", { ...SSH, sourceRanges: ["0.0.0.0/0", "10.0.0.0/8"] }],
    ["other port", { ...SSH, allowed: [{ IPProtocol: "tcp", ports: ["2222"] }] }],
    ["extra port", { ...SSH, allowed: [{ IPProtocol: "tcp", ports: ["22", "80"] }] }],
    ["all ports", { ...SSH, allowed: [{ IPProtocol: "tcp" }] }],
    ["target tags", { ...SSH, targetTags: ["bastion"] }],
    [
      "target service account",
      { ...SSH, targetServiceAccounts: ["vm@acme.iam.gserviceaccount.com"] },
    ],
    [
      "another network",
      { ...SSH, network: DEFAULT_NETWORK.replace(/default$/, "caelo-production-vpc") },
    ],
    ["egress", { ...SSH, direction: "EGRESS" }],
  ])("does not match a rule with %s", (_label, rule) => {
    expect(isStockDefaultRule(rule, ssh)).toBe(false);
  });
});

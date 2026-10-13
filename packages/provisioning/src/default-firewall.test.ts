// SPDX-License-Identifier: MPL-2.0

/**
 * GCP pre-populates `default-allow-ssh` (tcp:22), `default-allow-rdp`
 * (tcp:3389), `default-allow-icmp` (from 0.0.0.0/0) and
 * `default-allow-internal` (all ports from 10.128.0.0/9) on the `default`
 * network when Compute Engine is enabled; audits flag them on every Caelo
 * install. The wizard and `upgrade` delete them — but only in their stock
 * shape, and the internal rule only while no VM sits on that network. The
 * fake gcloud answers with what `gcloud compute … list --format=json` returns.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isStockDefaultRule,
  type LiveFirewallRule,
  removeDefaultFirewallRules,
} from "./default-firewall.js";
import type { GcloudResult } from "./gcloud.js";
import { ABSENT_DEFAULT_FIREWALL_RULES } from "./stack-contract.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

const DEFAULT_NETWORK =
  "https://www.googleapis.com/compute/v1/projects/acme/global/networks/default";

/** A rule exactly as GCP auto-creates it (as the Compute API returns it). */
function stock(
  name: string,
  allowed: LiveFirewallRule["allowed"],
  sourceRanges = ["0.0.0.0/0"],
): LiveFirewallRule {
  return {
    name,
    network: DEFAULT_NETWORK,
    direction: "INGRESS",
    priority: 65534,
    sourceRanges,
    allowed,
  } as LiveFirewallRule;
}
const SSH = stock("default-allow-ssh", [{ IPProtocol: "tcp", ports: ["22"] }]);
const RDP = stock("default-allow-rdp", [{ IPProtocol: "tcp", ports: ["3389"] }]);
const ICMP = stock("default-allow-icmp", [{ IPProtocol: "icmp" }]);
const INTERNAL = stock(
  "default-allow-internal",
  [
    { IPProtocol: "tcp", ports: ["0-65535"] },
    { IPProtocol: "udp", ports: ["0-65535"] },
    { IPProtocol: "icmp" },
  ],
  ["10.128.0.0/9"],
);
const ALL = [SSH, RDP, ICMP, INTERNAL];

const vm = (name: string, network: string) => ({
  name,
  zone: "https://www.googleapis.com/compute/v1/projects/acme/zones/europe-west1-b",
  networkInterfaces: [{ network }],
});

/**
 * Fake gcloud answering firewall `list`/`delete`, `instances list` and
 * `project-info describe` (Shared VPC status); records every call.
 */
function fakeGcloud(
  list: GcloudResult,
  del: (name: string) => GcloudResult = () => ok(),
  instances: GcloudResult = ok("[]"),
  xpnStatus: GcloudResult = ok("UNSPECIFIED_XPN_PROJECT_STATUS\n"),
) {
  const calls: string[] = [];
  const run = async (args: string[]) => {
    calls.push(args.join(" "));
    if (args[1] === "instances" && args[2] === "list") return instances;
    if (args[1] === "project-info" && args[2] === "describe") return xpnStatus;
    if (args[2] === "list") return list;
    if (args[2] === "delete") return del(args[3] ?? "");
    throw new Error(`unexpected gcloud call: ${args.join(" ")}`);
  };
  return { run, calls };
}

const LIST_CALL =
  "compute firewall-rules list --project=acme --filter=name=(default-allow-ssh default-allow-rdp default-allow-icmp default-allow-internal) --format=json";
const INSTANCES_CALL =
  "compute instances list --project=acme --format=json(name,zone,networkInterfaces[].network)";
const deletes = (calls: string[]) =>
  calls.filter((c) => c.startsWith("compute firewall-rules delete"));

describe("removeDefaultFirewallRules", () => {
  it("deletes all four stock rules on a fresh project", async () => {
    const { run, calls } = fakeGcloud(ok(JSON.stringify(ALL)));
    const outcomes = await removeDefaultFirewallRules("acme", { run });
    expect(calls[0]).toBe(LIST_CALL);
    expect(calls).toContain(INSTANCES_CALL);
    expect(deletes(calls)).toEqual([
      "compute firewall-rules delete default-allow-ssh --project=acme --quiet",
      "compute firewall-rules delete default-allow-rdp --project=acme --quiet",
      "compute firewall-rules delete default-allow-icmp --project=acme --quiet",
      "compute firewall-rules delete default-allow-internal --project=acme --quiet",
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "applied", "applied", "applied"]);
    expect(outcomes.map((o) => o.id)).toEqual([
      "firewall rule default-allow-ssh (tcp:22 from 0.0.0.0/0)",
      "firewall rule default-allow-rdp (tcp:3389 from 0.0.0.0/0)",
      "firewall rule default-allow-icmp (icmp from 0.0.0.0/0)",
      "firewall rule default-allow-internal (tcp:0-65535 udp:0-65535 icmp from 10.128.0.0/9)",
    ]);
    expect(outcomes.every((o) => o.onFailure === "warn")).toBe(true);
  });

  it("is a read-only no-op when the rules are already gone", async () => {
    const { run, calls } = fakeGcloud(ok("[]"));
    const outcomes = await removeDefaultFirewallRules("acme", { run });
    expect(calls).toEqual([LIST_CALL]);
    expect(outcomes.every((o) => o.status === "present")).toBe(true);
  });

  it("deletes only the rule that is still there", async () => {
    const { run, calls } = fakeGcloud(ok(JSON.stringify([RDP])));
    const outcomes = await removeDefaultFirewallRules("acme", { run });
    expect(deletes(calls)).toEqual([
      "compute firewall-rules delete default-allow-rdp --project=acme --quiet",
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["present", "applied", "present", "present"]);
  });

  it("checks for VMs only when the internal rule is there to delete", async () => {
    const { run, calls } = fakeGcloud(ok(JSON.stringify([SSH, ICMP])));
    await removeDefaultFirewallRules("acme", { run });
    expect(calls).not.toContain(INSTANCES_CALL);
    expect(calls.some((c) => c.startsWith("compute project-info"))).toBe(false);
  });

  it("leaves default-allow-internal in place while VMs sit on the default network", async () => {
    const { run, calls } = fakeGcloud(
      ok(JSON.stringify(ALL)),
      () => ok(),
      ok(
        JSON.stringify([
          vm("legacy-worker", DEFAULT_NETWORK),
          vm("vpc-only-vm", DEFAULT_NETWORK.replace(/default$/, "caelo-production-vpc")),
        ]),
      ),
    );
    const outcomes = await removeDefaultFirewallRules("acme", { run });
    expect(deletes(calls)).not.toContain(
      "compute firewall-rules delete default-allow-internal --project=acme --quiet",
    );
    expect(deletes(calls)).toHaveLength(3);
    const internal = outcomes[3];
    expect(internal?.status).toBe("failed");
    expect(internal?.onFailure).toBe("warn");
    expect(internal?.error).toContain("1 VM instance(s) are on the default network");
    expect(internal?.error).toContain("europe-west1-b/legacy-worker");
    expect(internal?.error).not.toContain("vpc-only-vm");
    expect(internal?.error).toContain(
      "gcloud compute firewall-rules delete default-allow-internal --project=acme",
    );
  });

  it("leaves default-allow-internal in place on a Shared VPC host", async () => {
    const { run, calls } = fakeGcloud(
      ok(JSON.stringify([INTERNAL])),
      () => ok(),
      ok("[]"),
      ok("HOST\n"),
    );
    const outcomes = await removeDefaultFirewallRules("acme", { run });
    expect(deletes(calls)).toEqual([]);
    expect(calls).not.toContain(INSTANCES_CALL);
    expect(outcomes[3]?.status).toBe("failed");
    expect(outcomes[3]?.onFailure).toBe("warn");
    expect(outcomes[3]?.error).toContain("Shared VPC host");
    expect(outcomes[3]?.error).toContain(
      "gcloud compute shared-vpc list-associated-resources acme",
    );
  });

  it("leaves default-allow-internal in place when the Shared VPC status is unknown", async () => {
    const { run, calls } = fakeGcloud(
      ok(JSON.stringify([INTERNAL])),
      () => ok(),
      ok("[]"),
      fail("ERROR: PERMISSION_DENIED: compute.projects.get"),
    );
    const outcomes = await removeDefaultFirewallRules("acme", { run });
    expect(deletes(calls)).toEqual([]);
    expect(outcomes[3]?.status).toBe("failed");
    expect(outcomes[3]?.error).toContain("compute.projects.get");
  });

  it("deletes default-allow-internal when VMs exist only on other networks", async () => {
    const { run, calls } = fakeGcloud(
      ok(JSON.stringify([INTERNAL])),
      () => ok(),
      ok(JSON.stringify([vm("x", DEFAULT_NETWORK.replace(/default$/, "caelo-production-vpc"))])),
    );
    const outcomes = await removeDefaultFirewallRules("acme", { run });
    expect(deletes(calls)).toEqual([
      "compute firewall-rules delete default-allow-internal --project=acme --quiet",
    ]);
    expect(outcomes[3]?.status).toBe("applied");
  });

  it("leaves default-allow-internal in place when the VMs cannot be listed", async () => {
    const { run, calls } = fakeGcloud(
      ok(JSON.stringify([INTERNAL])),
      () => ok(),
      fail("ERROR: PERMISSION_DENIED: compute.instances.list"),
    );
    const outcomes = await removeDefaultFirewallRules("acme", { run });
    expect(deletes(calls)).toEqual([]);
    expect(outcomes[3]?.status).toBe("failed");
    expect(outcomes[3]?.error).toContain("PERMISSION_DENIED");
    expect(outcomes[3]?.error).toContain("left it in place");
  });

  it("leaves a customised rule in place and reports it with the next step", async () => {
    const narrowed = { ...SSH, sourceRanges: ["203.0.113.0/24"] };
    const { run, calls } = fakeGcloud(ok(JSON.stringify([narrowed, RDP])));
    const outcomes = await removeDefaultFirewallRules("acme", { run });
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
    const outcomes = await removeDefaultFirewallRules("acme", { run });
    expect(calls).toEqual([LIST_CALL]);
    expect(outcomes.every((o) => o.status === "present")).toBe(true);
  });

  it("is a no-op when the default network was never created", async () => {
    // Org policy compute.skipDefaultNetworkCreation, or the network was
    // deleted: the list simply has no default-network rules.
    const { run, calls } = fakeGcloud(ok("[]"));
    expect(
      (await removeDefaultFirewallRules("acme", { run })).every((o) => o.status === "present"),
    ).toBe(true);
    expect(deletes(calls)).toEqual([]);
  });

  it("reports (warn) when the rules cannot be listed", async () => {
    const { run } = fakeGcloud(fail("ERROR: PERMISSION_DENIED: compute.firewalls.list"));
    const outcomes = await removeDefaultFirewallRules("acme", { run });
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "failed", "failed", "failed"]);
    expect(outcomes[0]?.error).toContain("PERMISSION_DENIED");
  });

  it("reports (warn) a failed delete with the role it needs", async () => {
    const { run } = fakeGcloud(ok(JSON.stringify([SSH])), () =>
      fail(
        "ERROR: Required 'compute.firewalls.delete' permission for 'projects/acme/global/firewalls/default-allow-ssh'",
      ),
    );
    const outcomes = await removeDefaultFirewallRules("acme", { run });
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.error).toContain("roles/compute.securityAdmin");
  });

  it("treats a rule deleted between list and delete as gone", async () => {
    const { run } = fakeGcloud(ok(JSON.stringify([SSH])), () =>
      fail("ERROR: The resource 'projects/acme/global/firewalls/default-allow-ssh' was not found"),
    );
    const outcomes = await removeDefaultFirewallRules("acme", { run });
    expect(outcomes[0]?.status).toBe("present");
  });
});

const contractRule = (name: string) => {
  const rule = ABSENT_DEFAULT_FIREWALL_RULES.find((r) => r.name === name);
  if (!rule) throw new Error(`${name} missing from the contract`);
  return rule;
};

describe("isStockDefaultRule", () => {
  const ssh = contractRule("default-allow-ssh");
  const icmp = contractRule("default-allow-icmp");
  const internal = contractRule("default-allow-internal");

  it("matches all four documented stock shapes", () => {
    for (const live of ALL) {
      expect(isStockDefaultRule(live, contractRule(live.name))).toBe(true);
    }
  });

  it("matches the internal rule whatever order the API lists its protocols in", () => {
    const reordered = { ...INTERNAL, allowed: [...(INTERNAL.allowed ?? [])].reverse() };
    expect(isStockDefaultRule(reordered, internal)).toBe(true);
  });

  it.each<[string, LiveFirewallRule]>([
    ["another source range", { ...INTERNAL, sourceRanges: ["10.240.0.0/16"] }],
    ["an extra source range", { ...INTERNAL, sourceRanges: ["10.128.0.0/9", "0.0.0.0/0"] }],
    [
      "narrowed tcp ports",
      {
        ...INTERNAL,
        allowed: [
          { IPProtocol: "tcp", ports: ["5432"] },
          { IPProtocol: "udp", ports: ["0-65535"] },
          { IPProtocol: "icmp" },
        ],
      },
    ],
    ["icmp dropped", { ...INTERNAL, allowed: (INTERNAL.allowed ?? []).slice(0, 2) }],
    ["target tags", { ...INTERNAL, targetTags: ["db"] }],
  ])("does not match an internal rule with %s", (_label, rule) => {
    expect(isStockDefaultRule(rule, internal)).toBe(false);
  });

  it.each<[string, LiveFirewallRule]>([
    ["a narrowed source range", { ...ICMP, sourceRanges: ["35.191.0.0/16"] }],
    ["an extra protocol", { ...ICMP, allowed: [{ IPProtocol: "icmp" }, { IPProtocol: "tcp" }] }],
    ["target tags", { ...ICMP, targetTags: ["pingable"] }],
  ])("does not match an icmp rule with %s", (_label, rule) => {
    expect(isStockDefaultRule(rule, icmp)).toBe(false);
  });

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

/**
 * Deleting `default-allow-internal` is only safe because Caelo attaches
 * nothing to the `default` network. Pin that in both GCP stacks: the only
 * VPC is the stack's own, and every Cloud Run Direct VPC egress interface
 * points at it.
 */
describe.each(["gcp", "gcp-firebase"])("%s stack — nothing on the default network", (provider) => {
  const src = readFileSync(resolve(import.meta.dir, `../stacks/${provider}/index.ts`), "utf8");

  it("creates its own VPC and attaches Cloud Run only to it", () => {
    expect(src.match(/new gcp\.compute\.Network\(/g)).toHaveLength(1);
    expect(src).toMatch(/new gcp\.compute\.Network\(\s*`\$\{namePrefix\}-vpc`/);
    const interfaces = src.match(/networkInterfaces: \[[^\]]*\]/g) ?? [];
    expect(interfaces.length).toBeGreaterThan(0);
    for (const ni of interfaces) {
      expect(ni).toBe("networkInterfaces: [{ network: network.name, subnetwork: subnet.name }]");
    }
  });

  it("never names the default network or creates VMs / connectors", () => {
    expect(src).not.toMatch(/networks\/default\b|network:\s*["']default["']/);
    expect(src).not.toMatch(/compute\.Instance\b|compute\.InstanceTemplate|vpcaccess\.Connector/);
  });
});

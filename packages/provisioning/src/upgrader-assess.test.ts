// SPDX-License-Identifier: MPL-2.0

/**
 * The upgrader's refusal matrix (upgrader-assess.ts), table-driven: every
 * row is one way a request can be refused, handed to Cloud Shell, or let
 * through.
 */

import { describe, expect, it } from "bun:test";
import type { StoredUpdatePolicy } from "@caelo-cms/shared";
import type { ReleaseManifest, ReleaseManifestResult } from "./release-manifest.js";
import { assessUpgradeRequest, type InstalledState } from "./upgrader-assess.js";

const D = (c: string) => `sha256:${c.repeat(64)}`;

const MANIFEST: ReleaseManifest = {
  manifestVersion: 1,
  version: "0.11.0",
  channel: "stable",
  digests: { admin: D("a"), gateway: D("b"), ops: D("c") },
  minFromVersion: "0.10.0",
  infraContractVersion: 2,
  migrations: { contract: false, lastContractVersion: null, head: "0267_platform_updates" },
  security: false,
  advisories: [],
};

const POLICY: StoredUpdatePolicy = {
  mode: "auto",
  autoSecurity: true,
  autoPatch: true,
  autoMinor: true,
  channel: "stable",
  windowStart: null,
  windowEnd: null,
  windowTimezone: "UTC",
  soakHours: 24,
  securitySoakHours: 2,
  paused: false,
  pausedReason: null,
  pausedAt: null,
  pausedUntil: null,
  pausedByOwner: false,
  updatedAt: "2026-10-13T00:00:00Z",
};

const INSTALLED: InstalledState = { version: "0.10.45", infraContractVersion: 2 };
const NOW = new Date("2026-10-13T12:00:00Z");

const verified = (m: Partial<ReleaseManifest> = {}): ReleaseManifestResult => ({
  ok: true,
  manifest: { ...MANIFEST, ...m },
});
const broken = (
  code: "registry" | "signature" | "schema" | "blob-digest" | "version-mismatch" | "artifact-shape",
): ReleaseManifestResult => ({ ok: false, error: { code, message: `${code} problem` } });

interface Row {
  readonly name: string;
  readonly manifest?: ReleaseManifestResult;
  readonly installed?: InstalledState;
  readonly trigger?: "manual" | "auto";
  readonly autoBasis?: "security" | "patch" | "minor";
  readonly policy?: StoredUpdatePolicy;
  readonly target?: string;
  /** "proceed" or `<status>/<code>`. */
  readonly expect: string;
  readonly reasonContains?: string;
}

const ROWS: readonly Row[] = [
  { name: "a signed, newer, app-only release", expect: "proceed" },
  {
    name: "registry unreachable",
    manifest: broken("registry"),
    expect: "failed/registry",
    reasonContains: "Nothing was changed",
  },
  { name: "bad signature", manifest: broken("signature"), expect: "refused/signature" },
  { name: "tampered blob", manifest: broken("blob-digest"), expect: "refused/signature" },
  { name: "replayed manifest", manifest: broken("version-mismatch"), expect: "refused/signature" },
  { name: "not an artifact", manifest: broken("artifact-shape"), expect: "refused/signature" },
  {
    name: "manifest too new for this upgrader",
    manifest: broken("schema"),
    expect: "needs_cloud_shell/manifest-unreadable",
  },
  {
    name: "installed version never recorded",
    installed: { version: null, infraContractVersion: 2 },
    expect: "needs_cloud_shell/install-version-unknown",
  },
  {
    name: "same version",
    installed: { version: "0.11.0", infraContractVersion: 2 },
    expect: "refused/not-newer",
  },
  {
    name: "downgrade",
    installed: { version: "0.12.0", infraContractVersion: 2 },
    expect: "refused/not-newer",
    reasonContains: "never installs an older release",
  },
  {
    name: "below minFromVersion",
    manifest: verified({ minFromVersion: "0.10.50" }),
    expect: "refused/min-from-version",
    reasonContains: "Install v0.10.50 first",
  },
  {
    name: "infrastructure contract raised",
    installed: { version: "0.10.45", infraContractVersion: 1 },
    expect: "needs_cloud_shell/infra-contract",
    reasonContains: "Cloud Shell",
  },
  {
    name: "never converged at all",
    installed: { version: "0.10.45", infraContractVersion: 0 },
    expect: "needs_cloud_shell/infra-contract",
  },
  {
    name: "contract migrations, Owner's click",
    manifest: verified({ migrations: { ...MANIFEST.migrations, contract: true } }),
    expect: "proceed",
  },
  {
    name: "contract migrations, automatic",
    manifest: verified({ migrations: { ...MANIFEST.migrations, contract: true } }),
    trigger: "auto",
    expect: "refused/contract-migrations",
  },
  {
    name: "skips a contract release, automatic",
    manifest: verified({ migrations: { ...MANIFEST.migrations, lastContractVersion: "0.10.50" } }),
    trigger: "auto",
    expect: "refused/contract-migrations",
  },
  { name: "automatic, allowed by policy", trigger: "auto", expect: "proceed" },
  {
    name: "automatic, policy off",
    trigger: "auto",
    policy: { ...POLICY, mode: "notify" },
    expect: "refused/policy",
  },
  {
    name: "automatic, paused",
    trigger: "auto",
    policy: { ...POLICY, paused: true },
    expect: "refused/policy",
  },
  {
    name: "automatic, minor not enabled",
    trigger: "auto",
    policy: { ...POLICY, autoMinor: false },
    expect: "refused/policy",
  },
  {
    name: "automatic security fix, only security enabled",
    trigger: "auto",
    policy: { ...POLICY, autoMinor: false, autoPatch: false },
    manifest: verified({ security: true, advisories: ["GHSA-abcd-efgh-ijkm"] }),
    expect: "proceed",
  },
  {
    name: "automatic 'security' flag without a published advisory",
    trigger: "auto",
    policy: { ...POLICY, autoMinor: false, autoPatch: false },
    manifest: verified({ security: true, advisories: [] }),
    expect: "refused/policy",
  },
  {
    name: "queued as a security fix, signed manifest says it is not one",
    trigger: "auto",
    autoBasis: "security",
    expect: "refused/policy",
    reasonContains: "names no published security advisory",
  },
  {
    name: "queued as a security fix, signed manifest agrees",
    trigger: "auto",
    autoBasis: "security",
    manifest: verified({ security: true, advisories: ["GHSA-abcd-efgh-ijkm"] }),
    expect: "proceed",
  },
  {
    name: "automatic, Owner pause already over",
    trigger: "auto",
    policy: {
      ...POLICY,
      paused: true,
      pausedByOwner: true,
      pausedAt: "2026-10-12T00:00:00Z",
      pausedUntil: "2026-10-13T00:00:00Z",
    },
    expect: "proceed",
  },
  {
    name: "automatic, outside the window",
    trigger: "auto",
    policy: { ...POLICY, windowStart: "02:00", windowEnd: "03:00" },
    expect: "refused/policy",
  },
  {
    name: "automatic, release candidate",
    trigger: "auto",
    target: "0.11.0-rc.1",
    manifest: verified({ version: "0.11.0-rc.1", channel: "rc" }),
    expect: "refused/policy",
  },
];

describe("assessUpgradeRequest — refusal matrix", () => {
  it.each(ROWS.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    const d = assessUpgradeRequest({
      request: {
        targetVersion: row.target ?? "0.11.0",
        trigger: row.trigger ?? "manual",
        autoBasis: row.autoBasis ?? null,
      },
      manifest: row.manifest ?? verified(),
      installed: row.installed ?? INSTALLED,
      policy: row.policy ?? POLICY,
      now: NOW,
    });
    const got = d.kind === "proceed" ? "proceed" : `${d.status}/${d.codes.join(",")}`;
    expect(got).toBe(row.expect);
    if (row.reasonContains) expect(d.kind === "stop" ? d.reason : "").toContain(row.reasonContains);
  });

  it("warns the Owner about destructive migrations it lets through", () => {
    const d = assessUpgradeRequest({
      request: { targetVersion: "0.11.0", trigger: "manual" },
      manifest: verified({ migrations: { ...MANIFEST.migrations, contract: true } }),
      installed: INSTALLED,
      policy: POLICY,
      now: NOW,
    });
    expect(d.kind === "proceed" ? d.warnings.join(" ") : "").toContain("backup must be restored");
  });

  it("keeps the verified manifest on a stop, for the facts the admin explains", () => {
    const d = assessUpgradeRequest({
      request: { targetVersion: "0.11.0", trigger: "manual" },
      manifest: verified(),
      installed: { version: "0.10.45", infraContractVersion: 1 },
      policy: POLICY,
      now: NOW,
    });
    expect(d.kind === "stop" && d.manifest?.infraContractVersion).toBe(2);
  });
});

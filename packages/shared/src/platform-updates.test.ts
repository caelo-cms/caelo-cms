// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  autoInstallRefusal,
  inMaintenanceWindow,
  isFinishedUpdateStatus,
  PLATFORM_UPDATE_STALE_REASON,
  type StoredUpdatePolicy,
  updateKind,
  updatePolicySchema,
} from "./platform-updates.js";

describe("updateKind", () => {
  it.each([
    ["0.10.45", "0.10.46", "patch"],
    ["0.10.45", "0.11.0", "minor"],
    ["0.10.45", "1.0.0", "major"],
    ["0.11.0-rc.1", "0.11.0", "patch"],
    ["0.11.0-rc.1", "0.11.0-rc.2", "patch"],
    ["0.11.0-rc.9", "0.11.0-rc.10", "patch"],
    ["0.11.0-rc.2", "0.11.0-rc.1", null],
    ["0.11.0", "0.11.0-rc.2", null],
    ["0.10.45", "0.10.45", null],
    ["0.10.45", "0.10.44", null],
    ["0.11.0", "0.10.99", null],
    ["nope", "0.10.46", null],
  ] as const)("%s → %s is %s", (from, to, kind) => {
    expect(updateKind(from, to)).toBe(kind);
  });
});

describe("inMaintenanceWindow", () => {
  const at = (iso: string) => new Date(iso);
  it("no window = any time", () => {
    expect(
      inMaintenanceWindow(
        { windowStart: null, windowEnd: null, windowTimezone: "UTC" },
        at("2026-10-13T12:00:00Z"),
      ),
    ).toBe(true);
  });
  it("respects the time zone", () => {
    const w = { windowStart: "02:00", windowEnd: "05:00", windowTimezone: "Europe/Berlin" };
    // 01:30 UTC = 03:30 Berlin (CEST).
    expect(inMaintenanceWindow(w, at("2026-10-13T01:30:00Z"))).toBe(true);
    expect(inMaintenanceWindow(w, at("2026-10-13T03:30:00Z"))).toBe(false);
  });
  it("a window across midnight", () => {
    const w = { windowStart: "22:00", windowEnd: "04:00", windowTimezone: "UTC" };
    expect(inMaintenanceWindow(w, at("2026-10-13T23:00:00Z"))).toBe(true);
    expect(inMaintenanceWindow(w, at("2026-10-13T03:59:00Z"))).toBe(true);
    expect(inMaintenanceWindow(w, at("2026-10-13T04:00:00Z"))).toBe(false);
    expect(inMaintenanceWindow(w, at("2026-10-13T12:00:00Z"))).toBe(false);
  });
});

describe("autoInstallRefusal", () => {
  const policy: StoredUpdatePolicy = {
    mode: "auto",
    autoSecurity: true,
    autoPatch: false,
    autoMinor: false,
    autoConverge: false,
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
  const now = new Date("2026-10-13T12:00:00Z");
  const patch = {
    kind: "patch",
    security: false,
    contractMigrations: false,
    channel: "stable",
  } as const;

  it.each([
    ["mode off", { ...policy, mode: "notify" as const }, patch, "switched off"],
    ["paused", { ...policy, paused: true }, { ...patch, security: true }, "paused"],
    ["rc channel", policy, { ...patch, security: true, channel: "rc" }, "only stable"],
    [
      "contract migrations",
      policy,
      { ...patch, security: true, contractMigrations: true },
      "destructive",
    ],
    [
      "major",
      { ...policy, autoMinor: true, autoPatch: true },
      { ...patch, kind: "major" as const },
      "major",
    ],
    ["patch not enabled", policy, patch, "does not install"],
    [
      "outside window",
      { ...policy, autoPatch: true, windowStart: "02:00", windowEnd: "03:00" },
      patch,
      "outside the maintenance window",
    ],
  ])("%s → refused", (_name, p, c, why) => {
    expect(autoInstallRefusal(p, c, now)).toContain(why);
  });

  it("allows an enabled kind inside the window", () => {
    expect(autoInstallRefusal(policy, { ...patch, security: true }, now)).toBeNull();
    expect(
      autoInstallRefusal({ ...policy, autoMinor: true }, { ...patch, kind: "minor" }, now),
    ).toBeNull();
  });
});

describe("updatePolicySchema", () => {
  const base = {
    mode: "auto",
    autoSecurity: true,
    autoPatch: false,
    autoMinor: false,
    autoConverge: false,
    channel: "stable",
    windowStart: "02:00",
    windowEnd: "04:00",
    windowTimezone: "Europe/Berlin",
    soakHours: 24,
    securitySoakHours: 2,
  };
  it("accepts a sane policy and rejects broken ones", () => {
    expect(updatePolicySchema.safeParse(base).success).toBe(true);
    for (const bad of [
      { ...base, channel: "rc" },
      { ...base, windowEnd: null },
      { ...base, windowStart: "25:00" },
      { ...base, windowTimezone: "Nowhere/Land" },
      { ...base, soakHours: 1000 },
      { ...base, securitySoakHours: 48 },
      { ...base, extra: true },
      // "Don't tell me" is gone (#862): security releases are always announced.
      { ...base, mode: "off" },
      { ...base, autoConverge: undefined },
    ]) {
      expect(updatePolicySchema.safeParse(bad).success).toBe(false);
    }
  });
});

it("isFinishedUpdateStatus", () => {
  expect(isFinishedUpdateStatus("pending")).toBe(false);
  expect(isFinishedUpdateStatus("running")).toBe(false);
  expect(isFinishedUpdateStatus("needs_cloud_shell")).toBe(true);
});

describe("PLATFORM_UPDATE_STALE_REASON (#721)", () => {
  it("names no provider's tool: it ends dead Google Cloud and self-hosted runs alike", () => {
    expect(PLATFORM_UPDATE_STALE_REASON).not.toContain("Cloud Shell");
    expect(PLATFORM_UPDATE_STALE_REASON).toContain("Settings → Updates");
  });
});

// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  BUILTIN_ROLE_NAMES,
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
  PERMISSIONS,
} from "../permissions.js";

describe("permission catalog", () => {
  it("has no duplicates", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it("includes the permissions that later phases depend on", () => {
    const set = new Set<string>(PERMISSIONS);
    for (const p of ["deploy.trigger", "ops.view", "roles.manage", "plugins.approve"]) {
      expect(set.has(p)).toBe(true);
    }
  });

  it("built-in role catalogue matches seed", () => {
    expect(BUILTIN_ROLE_NAMES).toEqual(["owner", "editor", "reviewer"]);
  });
});

describe("permission resolver", () => {
  const grants = new Set<string>(["content.read", "content.write"]);

  it("hasPermission is true when granted", () => {
    expect(hasPermission(grants, "content.read")).toBe(true);
    expect(hasPermission(grants, "deploy.trigger")).toBe(false);
  });

  it("hasAllPermissions requires every listed permission", () => {
    expect(hasAllPermissions(grants, ["content.read", "content.write"])).toBe(true);
    expect(hasAllPermissions(grants, ["content.read", "deploy.trigger"])).toBe(false);
  });

  it("hasAnyPermission is satisfied by any match", () => {
    expect(hasAnyPermission(grants, ["deploy.trigger", "content.read"])).toBe(true);
    expect(hasAnyPermission(grants, ["deploy.trigger", "ops.view"])).toBe(false);
  });
});

// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_INSTALL_NAMES,
  INSTALL_NAMES_ENV,
  installDatabases,
  installNamesEnv,
  installNamesFromEnv,
  installRoles,
  isDefaultInstallNames,
  parseInstallNames,
  physicalDatabaseName,
  prefixedInstallNames,
} from "./install-names.js";

describe("install name map (#1689)", () => {
  it("is today's names when the env sets none", () => {
    expect(installNamesFromEnv({})).toBe(DEFAULT_INSTALL_NAMES);
    expect(installNamesFromEnv({ [INSTALL_NAMES_ENV]: "  " })).toBe(DEFAULT_INSTALL_NAMES);
    expect(DEFAULT_INSTALL_NAMES.roles.admin).toBe("admin_role");
    expect(installDatabases(DEFAULT_INSTALL_NAMES)).toEqual([
      "cms_admin",
      "cms_public",
      "cms_public_staging",
    ]);
  });

  it("reads a complete map from the env and gives the env back for it", () => {
    const t1 = prefixedInstallNames("t1");
    expect(installNamesFromEnv(installNamesEnv(t1))).toEqual(t1);
    expect(installNamesEnv(DEFAULT_INSTALL_NAMES)).toEqual({});
    expect(isDefaultInstallNames(t1)).toBe(false);
    expect(isDefaultInstallNames(JSON.parse(JSON.stringify(DEFAULT_INSTALL_NAMES)))).toBe(true);
  });

  it("names every role and database behind a prefix", () => {
    const t1 = prefixedInstallNames("t1");
    expect(installRoles(t1)).toEqual([
      "t1_admin_role",
      "t1_public_role",
      "t1_public_staging_role",
      "t1_operator_access_reader",
      "t1_platform_updater",
      "t1_gateway_role",
    ]);
    expect(physicalDatabaseName(t1, "cms_public_staging")).toBe("t1_cms_public_staging");
  });

  it("refuses a map that is not JSON, incomplete, or mixes in a name twice", () => {
    expect(() => installNamesFromEnv({ [INSTALL_NAMES_ENV]: "t1" })).toThrow("is not JSON");
    const t1 = prefixedInstallNames("t1");
    const { formerGateway: _, ...missing } = t1.roles;
    expect(() => parseInstallNames({ ...t1, roles: missing }, "map")).toThrow(
      "roles.formerGateway",
    );
    expect(() =>
      parseInstallNames({ ...t1, roles: { ...t1.roles, public: t1.roles.admin } }, "map"),
    ).toThrow('roles.public and roles.admin are both "t1_admin_role"');
    expect(() => parseInstallNames({ ...t1, extra: 1 }, "map")).toThrow("map");
  });

  it("refuses names that need quoting, are too long, or are reserved", () => {
    const t1 = prefixedInstallNames("t1");
    for (const bad of [
      "Admin",
      "a-b",
      "x; DROP",
      `${"a".repeat(64)}`,
      "pg_admin",
      "cloudsql_x",
      "rds_x",
      // Postgres keywords, one per category that needs quoting (Codex review):
      // reserved, type/function name, column name.
      "select",
      "user",
      "left",
      "int",
    ]) {
      expect(() =>
        parseInstallNames({ ...t1, databases: { ...t1.databases, admin: bad } }, "map"),
      ).toThrow("databases.admin");
    }
    // Postgres reserves "public" for its PUBLIC pseudo-role (Codex review); a
    // database may still be called that.
    expect(() =>
      parseInstallNames({ ...t1, roles: { ...t1.roles, public: "public" } }, "map"),
    ).toThrow("roles.public");
    expect(
      parseInstallNames({ ...t1, databases: { ...t1.databases, publicStaging: "public" } }, "map")
        .databases.publicStaging,
    ).toBe("public");
    expect(() => prefixedInstallNames("T1")).toThrow("must match");
    expect(() => prefixedInstallNames("pg")).toThrow("must not start with");
  });
});

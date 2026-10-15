// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 — contract migrations declare the expand migration an earlier
 * release must have applied; the runner refuses a run that would apply both.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requiredEarlierRuns, runOrderViolations } from "./run-order.js";

const HEADER = "-- SPDX-License-Identifier: MPL-2.0\n-- caelo:contract drops x\n";
const contract = {
  name: "0003_contract.sql",
  body: `${HEADER}-- caelo:requires-earlier-run 0002_expand.sql\n\nDROP TABLE x;\n`,
};
const expand = { name: "0002_expand.sql", body: "CREATE TABLE y (id int);\n" };
const available = ["0001_base.sql", "0002_expand.sql", "0003_contract.sql"];

describe("requiredEarlierRuns (#635)", () => {
  it("reads the header only", () => {
    expect(requiredEarlierRuns(contract.body)).toEqual(["0002_expand.sql"]);
    expect(
      requiredEarlierRuns(`${HEADER}SELECT 1;\n-- caelo:requires-earlier-run 0002_expand.sql\n`),
    ).toEqual([]);
  });
});

describe("runOrderViolations (#635)", () => {
  it("refuses an upgrade that would apply the expand and the contract migration in one run", () => {
    const v = runOrderViolations({
      pending: [expand, contract],
      appliedBefore: new Set(["0001_base.sql"]),
      available,
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("0003_contract.sql needs 0002_expand.sql applied by an EARLIER");
    expect(v[0]).toContain("Upgrade to the newest release that ships 0002_expand.sql");
  });

  it("allows the contract migration once an earlier run applied the expand one", () => {
    expect(
      runOrderViolations({
        pending: [contract],
        appliedBefore: new Set(["0001_base.sql", "0002_expand.sql"]),
        available,
      }),
    ).toEqual([]);
  });

  it("allows a fresh install to apply everything in one run", () => {
    expect(
      runOrderViolations({
        pending: [{ name: "0001_base.sql", body: "" }, expand, contract],
        appliedBefore: new Set(),
        available,
      }),
    ).toEqual([]);
  });

  it("refuses a header naming a migration that does not sort before it", () => {
    const bad = {
      name: "0002_expand.sql",
      body: "-- caelo:requires-earlier-run 0003_contract.sql\nSELECT 1;\n",
    };
    expect(
      runOrderViolations({ pending: [bad], appliedBefore: new Set(), available })[0],
    ).toContain("Fix the caelo:requires-earlier-run header");
  });
});

describe("the shipped migrations (#635)", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const db of ["cms_admin", "cms_public"]) {
    it(`${db}: every caelo:requires-earlier-run header names an earlier migration`, () => {
      const files = readdirSync(resolve(root, db))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      const pending = files.map((name) => ({
        name,
        body: readFileSync(resolve(root, db, name), "utf8"),
      }));
      expect(runOrderViolations({ pending, appliedBefore: new Set(), available: files })).toEqual(
        [],
      );
    });
  }

  it("0282 (drops gateway_role) requires an earlier run of 0281", () => {
    const body = readFileSync(resolve(root, "cms_admin", "0282_drop_gateway_role.sql"), "utf8");
    expect(requiredEarlierRuns(body)).toEqual(["0281_public_projection_outbox.sql"]);
  });
});

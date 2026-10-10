// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { convergeSelfHostedRoles, decideUp, roleConvergenceScript } from "./self-hosted-roles.js";

const PASSWORDS = { admin: "a'pw", public: "p-pw", gateway: "g-pw" };

describe("roleConvergenceScript (#613 review)", () => {
  const script = roleConvergenceScript(PASSWORDS);

  it("creates missing roles and (re)sets every role's password, quoted", () => {
    for (const role of ["admin_role", "public_role", "gateway_role"]) {
      expect(script).toContain(
        `WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}')`,
      );
    }
    expect(script).toContain("ALTER ROLE admin_role WITH LOGIN PASSWORD 'a''pw';");
    expect(script).toContain("ALTER ROLE gateway_role WITH LOGIN PASSWORD 'g-pw';");
  });

  it("re-applies migration 0248's gateway grants in cms_admin, and stops on the first error", () => {
    expect(script.startsWith("\\set ON_ERROR_STOP on")).toBe(true);
    expect(script.indexOf("\\connect cms_admin")).toBeLessThan(
      script.indexOf("PERFORM caelo_grant_gateway_role()"),
    );
  });
});

describe("convergeSelfHostedRoles", () => {
  it("does nothing while Postgres is down", async () => {
    let ran = false;
    const r = await convergeSelfHostedRoles(PASSWORDS, {
      probe: async () => false,
      psql: async () => {
        ran = true;
        return { exitCode: 0, stderr: "" };
      },
    });
    expect(r).toEqual({
      ok: false,
      reachable: false,
      error: "the Postgres container is not running",
    });
    expect(ran).toBe(false);
  });

  it("hands the script to psql on stdin and reports its failure", async () => {
    const scripts: string[] = [];
    const r = await convergeSelfHostedRoles(PASSWORDS, {
      probe: async () => true,
      psql: async (script) => {
        scripts.push(script);
        return { exitCode: 3, stderr: "ERROR: permission denied\n" };
      },
    });
    expect(scripts).toEqual([roleConvergenceScript(PASSWORDS)]);
    expect(r).toEqual({ ok: false, reachable: true, error: "ERROR: permission denied" });
  });
});

describe("decideUp — `cms-provision up` never switches URLs onto unapplied passwords", () => {
  it("a back-filled config converges, then proceeds and records it", () => {
    expect(decideUp(false, { ok: true })).toEqual({ kind: "proceed", markConverged: true });
  });

  it("a back-filled config with Postgres down aborts before writing anything", () => {
    const d = decideUp(false, { ok: false, reachable: false, error: "down" });
    expect(d.kind).toBe("abort");
    expect(d.kind === "abort" && d.error).toContain("up -d postgres");
  });

  it("a failed convergence aborts whatever the config says", () => {
    expect(decideUp(true, { ok: false, reachable: true, error: "boom" }).kind).toBe("abort");
  });

  it("an already converged config proceeds with a warning while Postgres is down", () => {
    const d = decideUp(true, { ok: false, reachable: false, error: "down" });
    expect(d).toMatchObject({ kind: "proceed", markConverged: false });
  });
});

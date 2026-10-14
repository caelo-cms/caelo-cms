// SPDX-License-Identifier: MPL-2.0

/**
 * #587 — `cms-provision upgrade` gives older `gcp` installs the admin's
 * URL-map redirects role: create or update the custom role, undelete a
 * soft-deleted one, bind it to the admin's run SA.
 */

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import { ensureUrlMapRedirectsAccess } from "./url-map-redirects-access.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** The gcloud verb of a call (`projects add-iam-policy-binding` has it second). */
const verb = (c: string[]) => (c[0] === "projects" ? c[1] : c[2]);

function runner(answer: (args: string[]) => GcloudResult) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args);
      return answer(args);
    },
  };
}

const PERMS =
  "--permissions=compute.urlMaps.list,compute.urlMaps.get,compute.urlMaps.update,compute.backendBuckets.use,compute.backendServices.use,compute.globalOperations.get";
const BIND = [
  "projects",
  "add-iam-policy-binding",
  "p1",
  "--member=serviceAccount:caelo-production-run-sa@p1.iam.gserviceaccount.com",
  "--role=projects/p1/roles/caelo_production_urlMapRedirects",
  "--condition=None",
  "--quiet",
  "--format=none",
];

describe("ensureUrlMapRedirectsAccess", () => {
  it("creates the role when missing, then binds it", async () => {
    const r = runner((a) => (a[2] === "describe" ? fail("NOT_FOUND") : ok()));
    const out = await ensureUrlMapRedirectsAccess({
      projectId: "p1",
      env: "production",
      run: r.run,
    });
    expect(out).toEqual({ ok: true, role: "projects/p1/roles/caelo_production_urlMapRedirects" });
    expect(r.calls[1]?.slice(0, 5)).toEqual([
      "iam",
      "roles",
      "create",
      "caelo_production_urlMapRedirects",
      "--project=p1",
    ]);
    expect(r.calls[1]).toContain(PERMS);
    expect(r.calls[2]).toEqual(BIND);
  });

  it("updates an existing role to the current permissions (no drift)", async () => {
    const r = runner((a) => (a[2] === "describe" ? ok('{"name":"x"}') : ok()));
    await ensureUrlMapRedirectsAccess({ projectId: "p1", env: "production", run: r.run });
    expect(r.calls.map(verb)).toEqual(["describe", "update", "add-iam-policy-binding"]);
    expect(r.calls[1]).toContain(PERMS);
  });

  it("undeletes a soft-deleted role first", async () => {
    const r = runner((a) => (a[2] === "describe" ? ok('{"deleted":true}') : ok()));
    await ensureUrlMapRedirectsAccess({ projectId: "p1", env: "production", run: r.run });
    expect(r.calls.map(verb)).toEqual(["describe", "undelete", "update", "add-iam-policy-binding"]);
  });

  it("reports a failure instead of throwing", async () => {
    const r = runner((a) =>
      a[2] === "describe" ? fail("NOT_FOUND") : fail("PERMISSION_DENIED: iam.roles.create"),
    );
    expect(
      await ensureUrlMapRedirectsAccess({ projectId: "p1", env: "production", run: r.run }),
    ).toEqual({
      ok: false,
      error:
        "create projects/p1/roles/caelo_production_urlMapRedirects: PERMISSION_DENIED: iam.roles.create",
    });
  });
});

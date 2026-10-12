// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { GcloudResult } from "./gcloud.js";
import { ensureGcloudComponent } from "./gcloud-components.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

function fake(list: GcloudResult, install: GcloudResult = ok()) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return args[1] === "list" ? list : install;
  };
  return { calls, logs, opts: { run, log: (m: string) => logs.push(m) } };
}

const LIST_ARGS = [
  "components",
  "list",
  "--only-local-state",
  "--filter=id=beta",
  "--format=value(id)",
];

describe("ensureGcloudComponent", () => {
  it("does nothing when the component is installed", async () => {
    const f = fake(ok("beta\n"));
    expect(await ensureGcloudComponent("beta", f.opts)).toEqual({ ok: true, installed: false });
    expect(f.calls).toEqual([LIST_ARGS]);
    expect(f.logs).toEqual([]);
  });

  it("installs a missing component non-interactively and says so", async () => {
    const f = fake(ok(""));
    expect(await ensureGcloudComponent("beta", f.opts)).toEqual({ ok: true, installed: true });
    expect(f.calls).toEqual([LIST_ARGS, ["components", "install", "beta", "--quiet"]]);
    expect(f.logs).toHaveLength(1);
    expect(f.logs[0]).toContain('"beta"');
  });

  it("names the package-manager command when the component manager is disabled", async () => {
    const f = fake(
      ok(""),
      fail(
        "ERROR: (gcloud.components.install) You cannot perform this action because this Google Cloud CLI installation is managed by an external package manager.",
      ),
    );
    const r = await ensureGcloudComponent("beta", f.opts);
    expect(r.ok).toBe(false);
    const error = r.ok ? "" : r.error;
    expect(error).toContain("sudo apt-get install google-cloud-cli");
    expect(error).toContain("managed by an external package manager");
  });

  it("tells the operator to install it themselves when the install fails for another reason", async () => {
    const f = fake(ok(""), fail("ERROR: Permission denied: /opt/google-cloud-sdk"));
    const r = await ensureGcloudComponent("alpha", f.opts);
    expect(r.ok).toBe(false);
    const error = r.ok ? "" : r.error;
    expect(error).toContain("Permission denied");
    expect(error).toContain("gcloud components install alpha");
  });

  it("fails instead of guessing when gcloud cannot list components", async () => {
    const f = fake(fail("gcloud crashed"));
    const r = await ensureGcloudComponent("beta", f.opts);
    expect(r).toEqual({
      ok: false,
      error: 'check whether the gcloud "beta" component is installed: gcloud crashed',
    });
    expect(f.calls).toHaveLength(1);
  });
});

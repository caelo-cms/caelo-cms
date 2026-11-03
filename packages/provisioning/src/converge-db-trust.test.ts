// SPDX-License-Identifier: MPL-2.0

/**
 * converge-db-trust.ts (#1373) against a fake gcloud and a fake Cloud SQL
 * Admin API: which host the converge job dials before the database TLS
 * step, and whose certificate it accepts there.
 */

import { describe, expect, it } from "bun:test";
import {
  convergeDatabaseTarget,
  normalizedSha1,
  serverIdentityProblem,
} from "./converge-db-trust.js";
import type { GcloudResult } from "./gcloud.js";
import type { HttpFetch } from "./runtime-secrets.js";

const DNS = "abc123.p-label.europe-west1.sql-psa.goog";
const IP = "10.20.0.3";
const PLACEMENT = { projectId: "p", region: "europe-west1" };
const OWN_CA = "-----BEGIN CERTIFICATE-----\nper-instance\n-----END CERTIFICATE-----";
const SHARED_BUNDLE = "-----BEGIN CERTIFICATE-----\nshared\n-----END CERTIFICATE-----";
const ACTIVE = "a212b6cf51b3736b34a5d4a3194b200db6b3532a";
const OLD = "0123456789abcdef0123456789abcdef01234567";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** The admin service as `gcloud run services describe --format=json` prints it. */
function adminService(host: string): string {
  return JSON.stringify({
    spec: {
      template: {
        metadata: {
          annotations: {
            "run.googleapis.com/network-interfaces": JSON.stringify([
              { network: "net", subnetwork: "sub" },
            ]),
          },
        },
        spec: {
          containers: [
            {
              image: "img@sha256:x",
              env: [
                {
                  name: "ADMIN_DATABASE_URL",
                  value: `postgresql://admin_role@${host}:5432/cms_admin?sslmode=require`,
                },
                {
                  name: "ADMIN_DATABASE_PASSWORD",
                  valueFrom: { secretKeyRef: { name: "pw", key: "latest" } },
                },
              ],
            },
          ],
        },
      },
    },
  });
}

function gcloud(opts: { host: string; instance?: object; describeFails?: boolean }) {
  const calls: string[] = [];
  const run = async (args: string[]) => {
    const line = args.join(" ");
    calls.push(line);
    if (line.startsWith("run services list")) return ok("caelo-production-admin-abc1234\n");
    if (line.startsWith("run services describe")) return ok(adminService(opts.host));
    if (line.startsWith("sql instances list")) return ok("caelo-production-pg-1\n");
    if (line.startsWith("sql instances describe")) {
      return opts.describeFails ? fail("PERMISSION_DENIED") : ok(JSON.stringify(opts.instance));
    }
    if (line.startsWith("auth print-access-token")) return ok("ya29.token\n");
    return fail(`unexpected: ${line}`);
  };
  return { run, calls };
}

function api(body: object, status = 200): HttpFetch {
  return async () => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
}

const perInstance = {
  serverCaCert: { cert: OWN_CA },
  settings: { ipConfiguration: { serverCaMode: "GOOGLE_MANAGED_INTERNAL_CA" } },
};
const shared = {
  serverCaCert: { cert: OWN_CA },
  settings: { ipConfiguration: { serverCaMode: "GOOGLE_MANAGED_CAS_CA" } },
};

describe("convergeDatabaseTarget", () => {
  it("an install on the DNS name connects with verify-full and asks Cloud SQL nothing", async () => {
    const g = gcloud({ host: DNS });
    expect(await convergeDatabaseTarget(PLACEMENT, { run: g.run })).toEqual({
      kind: "dns",
      host: DNS,
    });
    expect(g.calls.some((c) => c.startsWith("sql "))).toBe(false);
  });

  it("on the IP with the per-instance CA it trusts exactly that CA", async () => {
    const g = gcloud({ host: IP, instance: perInstance });
    const target = await convergeDatabaseTarget(PLACEMENT, {
      run: g.run,
      http: async () => {
        throw new Error("the per-instance CA needs no certificate list");
      },
    });
    expect(target).toEqual({ kind: "ip", host: IP, caPem: OWN_CA, pinnedSha1: null });
  });

  it("on the IP with the shared CA active it trusts the shared bundle and pins the instance's certificates", async () => {
    const g = gcloud({ host: IP, instance: shared });
    const target = await convergeDatabaseTarget(PLACEMENT, {
      run: g.run,
      http: api({ activeVersion: ACTIVE, serverCerts: [{ sha1Fingerprint: ACTIVE }] }),
      readSharedCaBundle: () => SHARED_BUNDLE,
    });
    expect(target).toEqual({ kind: "ip", host: IP, caPem: SHARED_BUNDLE, pinnedSha1: [ACTIVE] });
  });

  it("moved to the shared CA but not rotated in: pinned to the one certificate the API names active", async () => {
    const g = gcloud({ host: IP, instance: shared });
    const target = await convergeDatabaseTarget(PLACEMENT, {
      run: g.run,
      http: api({ activeVersion: OLD.toUpperCase(), serverCerts: [] }),
      readSharedCaBundle: () => SHARED_BUNDLE,
    });
    expect(target).toEqual({
      kind: "ip",
      host: IP,
      caPem: `${OWN_CA}\n${SHARED_BUNDLE}`,
      pinnedSha1: [OLD],
    });
  });

  it("shared CA: a listing that does not positively name the active certificate is refused (fail closed)", async () => {
    const answers: { body: unknown; why: RegExp }[] = [
      { body: {}, why: /does not name the active certificate/ },
      { body: { serverCerts: [{ sha1Fingerprint: ACTIVE }] }, why: /does not name/ },
      { body: { activeVersion: "", serverCerts: [] }, why: /does not name/ },
      { body: { activeVersion: "old-per-instance", serverCerts: [] }, why: /does not name/ },
      {
        body: { activeVersion: ACTIVE, serverCerts: [{ sha1Fingerprint: "nope" }] },
        why: /does not name/,
      },
      { body: { activeVersion: ACTIVE, serverCerts: [{}] }, why: /does not name/ },
      { body: { activeVersion: ACTIVE, serverCerts: "x" }, why: /does not name/ },
    ];
    for (const a of answers) {
      await expect(
        convergeDatabaseTarget(PLACEMENT, {
          run: gcloud({ host: IP, instance: shared }).run,
          http: api(a.body as object),
          readSharedCaBundle: () => SHARED_BUNDLE,
        }),
      ).rejects.toThrow(a.why);
    }
    const notJson: HttpFetch = async () => ({ ok: true, status: 200, text: async () => "<html>" });
    await expect(
      convergeDatabaseTarget(PLACEMENT, {
        run: gcloud({ host: IP, instance: shared }).run,
        http: notJson,
        readSharedCaBundle: () => SHARED_BUNDLE,
      }),
    ).rejects.toThrow(/answered no JSON/);
  });

  it("refuses a CA mode it cannot reason about", async () => {
    await expect(
      convergeDatabaseTarget(PLACEMENT, {
        run: gcloud({
          host: IP,
          instance: {
            serverCaCert: { cert: OWN_CA },
            settings: { ipConfiguration: { serverCaMode: "CUSTOMER_MANAGED_CAS_CA" } },
          },
        }).run,
      }),
    ).rejects.toThrow(/CUSTOMER_MANAGED_CAS_CA/);
  });

  it("an instance that names no CA mode is on the per-instance default", async () => {
    const g = gcloud({ host: IP, instance: { serverCaCert: { cert: OWN_CA } } });
    expect(await convergeDatabaseTarget(PLACEMENT, { run: g.run })).toEqual({
      kind: "ip",
      host: IP,
      caPem: OWN_CA,
      pinnedSha1: null,
    });
  });

  it("refuses to connect when it cannot tell whom to trust", async () => {
    await expect(
      convergeDatabaseTarget(PLACEMENT, { run: gcloud({ host: IP, describeFails: true }).run }),
    ).rejects.toThrow("PERMISSION_DENIED");
    await expect(
      convergeDatabaseTarget(PLACEMENT, {
        run: gcloud({
          host: IP,
          instance: {
            settings: { ipConfiguration: { serverCaMode: "GOOGLE_MANAGED_INTERNAL_CA" } },
          },
        }).run,
      }),
    ).rejects.toThrow("names no server CA certificate");
    await expect(
      convergeDatabaseTarget(PLACEMENT, {
        run: gcloud({ host: IP, instance: shared }).run,
        http: api({ error: "denied" }, 403),
      }),
    ).rejects.toThrow("HTTP 403");
  });
});

describe("serverIdentityProblem", () => {
  const pinned = { kind: "ip", host: IP, caPem: SHARED_BUNDLE, pinnedSha1: [ACTIVE] } as const;

  it("accepts a pinned certificate in node:tls's colon notation", () => {
    const colons = ACTIVE.toUpperCase().replace(/(..)(?!$)/g, "$1:");
    expect(serverIdentityProblem(pinned, colons)).toBeNull();
  });

  it("refuses a certificate the instance does not list", () => {
    expect(serverIdentityProblem(pinned, "00:11")).toContain("does not list");
  });

  it("without a pin the verified chain to the instance's own CA decides", () => {
    expect(serverIdentityProblem({ ...pinned, pinnedSha1: null }, "00:11")).toBeNull();
  });

  it("normalizes fingerprints", () => {
    expect(normalizedSha1("AB:cd:01")).toBe("abcd01");
  });
});

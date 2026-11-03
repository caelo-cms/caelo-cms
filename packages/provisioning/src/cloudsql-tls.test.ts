// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  dialsIpAddress,
  ensureCloudSqlVerifyFull,
  moveServicesToDnsHost,
  urlOnDnsHost,
} from "./cloudsql-tls.js";
import type { GcloudResult } from "./gcloud.js";
import type { HttpFetch } from "./runtime-secrets.js";

const DNS = "abc123.p-label.europe-west1.sql-psa.goog";
const TARGET = { projectId: "p", env: "production", sqlInstance: "caelo-production-pg-1" };

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const notFound = (): GcloudResult => ({
  ok: false,
  stdout: "",
  stderr: "ERROR: (gcloud) NOT_FOUND",
  exitCode: 1,
});

/** An instance as `gcloud sql instances describe --format=json` prints it. */
function instance(opts: { caMode: string; sslMode: string; dns: boolean }): string {
  return JSON.stringify({
    settings: {
      ipConfiguration: {
        serverCaMode: opts.caMode,
        sslMode: opts.sslMode,
        privateNetwork: "projects/p/global/networks/caelo-production-vpc-1",
      },
    },
    ipAddresses: [{ type: "PRIVATE", ipAddress: "10.20.0.3" }],
    dnsNames: opts.dns
      ? [{ name: `${DNS}.`, connectionType: "PRIVATE_SERVICES_ACCESS", dnsScope: "INSTANCE" }]
      : [],
  });
}

/** A fake gcloud: `answer` per call, every call recorded. */
function fake(answer: (args: string[]) => GcloudResult) {
  const calls: string[] = [];
  return {
    calls,
    run: async (args: string[]) => {
      calls.push(args.join(" "));
      return answer(args);
    },
  };
}

/** The Cloud SQL Admin API listServerCertificates answer. */
function certs(body: object): HttpFetch {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
}

describe("ensureCloudSqlVerifyFull", () => {
  it("moves a per-instance-CA instance to the shared CA, rotates, and makes its name resolve", async () => {
    let described = 0;
    const g = fake((a) => {
      const line = a.join(" ");
      if (line.startsWith("sql instances describe")) {
        described += 1;
        return ok(
          instance(
            described === 1
              ? {
                  caMode: "GOOGLE_MANAGED_INTERNAL_CA",
                  sslMode: "ALLOW_UNENCRYPTED_AND_ENCRYPTED",
                  dns: false,
                }
              : { caMode: "GOOGLE_MANAGED_CAS_CA", sslMode: "ENCRYPTED_ONLY", dns: true },
          ),
        );
      }
      if (line.startsWith("auth print-access-token")) return ok("token");
      if (line.includes(" describe ")) return notFound();
      return ok();
    });
    const r = await ensureCloudSqlVerifyFull(TARGET, {
      run: g.run,
      http: certs({ serverCerts: [] }),
      sleep: async () => {},
    });
    expect(r).toMatchObject({ ok: true, host: DNS });
    const writes = g.calls.filter((c) => !c.includes(" describe ") && !c.startsWith("auth"));
    expect(writes).toEqual([
      "sql instances patch caelo-production-pg-1 --project=p --server-ca-mode=GOOGLE_MANAGED_CAS_CA --ssl-mode=ENCRYPTED_ONLY --quiet",
      "sql ssl server-certs create --instance=caelo-production-pg-1 --project=p",
      "sql ssl server-certs rotate --instance=caelo-production-pg-1 --project=p --quiet",
      `dns managed-zones create caelo-production-pg-dns --project=p --dns-name=${DNS}. --visibility=private --networks=caelo-production-vpc-1 --description=Caelo production: the Cloud SQL instance's DNS name inside the VPC (#1338)`,
      `dns record-sets create ${DNS}. --zone=caelo-production-pg-dns --type=A --project=p --ttl=300 --rrdatas=10.20.0.3`,
    ]);
  });

  it("reads the DNS name after the move when the shared CA's certificate is active at once", async () => {
    // searchviu-website, v0.11.10: the patch made the shared CA's certificate
    // the active one, so no rotation re-read the instance, and the
    // description from before the patch named no DNS host.
    let described = 0;
    const g = fake((a) => {
      const line = a.join(" ");
      if (line.startsWith("sql instances describe")) {
        described += 1;
        return ok(
          instance(
            described === 1
              ? { caMode: "GOOGLE_MANAGED_INTERNAL_CA", sslMode: "ENCRYPTED_ONLY", dns: false }
              : { caMode: "GOOGLE_MANAGED_CAS_CA", sslMode: "ENCRYPTED_ONLY", dns: true },
          ),
        );
      }
      if (line.startsWith("auth print-access-token")) return ok("token");
      if (line.includes(" describe ")) return notFound();
      return ok();
    });
    const r = await ensureCloudSqlVerifyFull(TARGET, {
      run: g.run,
      http: certs({ activeVersion: "f1", serverCerts: [{ sha1Fingerprint: "f1" }] }),
      sleep: async () => {},
    });
    expect(r).toMatchObject({ ok: true, host: DNS });
    expect(g.calls.filter((c) => c.startsWith("sql ssl"))).toEqual([]);
  });

  it("changes nothing on an instance already in shape", async () => {
    const g = fake((a) => {
      const line = a.join(" ");
      if (line.startsWith("sql instances describe")) {
        return ok(
          instance({ caMode: "GOOGLE_MANAGED_CAS_CA", sslMode: "ENCRYPTED_ONLY", dns: true }),
        );
      }
      if (line.startsWith("auth")) return ok("token");
      if (line.startsWith("dns managed-zones describe"))
        return ok(JSON.stringify({ dnsName: `${DNS}.` }));
      if (line.startsWith("dns record-sets describe"))
        return ok(JSON.stringify({ rrdatas: ["10.20.0.3"] }));
      return ok();
    });
    const r = await ensureCloudSqlVerifyFull(TARGET, {
      run: g.run,
      http: certs({ activeVersion: "f1", serverCerts: [{ sha1Fingerprint: "f1" }] }),
    });
    expect(r).toEqual({ ok: true, host: DNS, done: [] });
    expect(g.calls.every((c) => c.includes(" describe ") || c.startsWith("auth"))).toBe(true);
  });

  it("finishes an interrupted rotation without creating a second certificate", async () => {
    const g = fake((a) => {
      const line = a.join(" ");
      if (line.startsWith("sql instances describe")) {
        return ok(
          instance({ caMode: "GOOGLE_MANAGED_CAS_CA", sslMode: "ENCRYPTED_ONLY", dns: true }),
        );
      }
      if (line.startsWith("auth")) return ok("token");
      if (line.startsWith("dns managed-zones describe"))
        return ok(JSON.stringify({ dnsName: `${DNS}.` }));
      if (line.startsWith("dns record-sets describe"))
        return ok(JSON.stringify({ rrdatas: ["10.9.9.9"] }));
      return ok();
    });
    const r = await ensureCloudSqlVerifyFull(TARGET, {
      run: g.run,
      http: certs({
        activeVersion: "old-per-instance",
        serverCerts: [{ sha1Fingerprint: "upcoming" }],
      }),
    });
    expect(r.ok).toBe(true);
    expect(g.calls.some((c) => c.startsWith("sql ssl server-certs create"))).toBe(false);
    expect(g.calls.some((c) => c.startsWith("sql ssl server-certs rotate"))).toBe(true);
    expect(
      g.calls.some(
        (c) => c.startsWith("dns record-sets update") && c.endsWith("--rrdatas=10.20.0.3"),
      ),
    ).toBe(true);
  });

  it("refuses a zone that serves another name instead of repointing it", async () => {
    const g = fake((a) => {
      const line = a.join(" ");
      if (line.startsWith("sql instances describe")) {
        return ok(
          instance({ caMode: "GOOGLE_MANAGED_CAS_CA", sslMode: "ENCRYPTED_ONLY", dns: true }),
        );
      }
      if (line.startsWith("auth")) return ok("token");
      if (line.startsWith("dns managed-zones describe")) {
        return ok(JSON.stringify({ dnsName: "old.p-label.europe-west1.sql-psa.goog." }));
      }
      return ok();
    });
    const r = await ensureCloudSqlVerifyFull(TARGET, {
      run: g.run,
      http: certs({ activeVersion: "f1", serverCerts: [{ sha1Fingerprint: "f1" }] }),
    });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain("serves old.p-label");
  });

  it("fails loudly when the instance names no private DNS name", async () => {
    const g = fake((a) =>
      a.join(" ").startsWith("sql instances describe")
        ? ok(instance({ caMode: "GOOGLE_MANAGED_CAS_CA", sslMode: "ENCRYPTED_ONLY", dns: false }))
        : ok("token"),
    );
    const r = await ensureCloudSqlVerifyFull(TARGET, {
      run: g.run,
      http: certs({ activeVersion: "f1", serverCerts: [{ sha1Fingerprint: "f1" }] }),
    });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain("PRIVATE_SERVICES_ACCESS DNS name");
  });
});

describe("moveServicesToDnsHost", () => {
  it("switches only the URLs that dial an IP, keeping their sslmode", async () => {
    const g = fake(() => ok());
    const r = await moveServicesToDnsHost(
      { projectId: "p", region: "europe-west1" },
      [
        {
          serviceName: "caelo-production-admin-1",
          liveUrls: {
            ADMIN_DATABASE_URL: "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
            PUBLIC_ADMIN_DATABASE_URL:
              "postgresql://admin_role@10.20.0.3:5432/cms_public?sslmode=require",
          },
        },
        {
          serviceName: "caelo-production-gateway-1",
          liveUrls: { PUBLIC_DATABASE_URL: `postgresql://public_role@${DNS}:5432/cms_public` },
        },
      ],
      DNS,
      { run: g.run, sleep: async () => {} },
    );
    expect(r.ok).toBe(true);
    expect(g.calls).toEqual([
      `run services update caelo-production-admin-1 --region europe-west1 --project=p --update-env-vars=^|^ADMIN_DATABASE_URL=postgresql://admin_role@${DNS}:5432/cms_admin?sslmode=require|PUBLIC_ADMIN_DATABASE_URL=postgresql://admin_role@${DNS}:5432/cms_public?sslmode=require --quiet`,
    ]);
  });
});

describe("urlOnDnsHost / dialsIpAddress", () => {
  it("tells IP-dialling URLs apart and moves only those", () => {
    expect(dialsIpAddress("postgresql://a@10.0.0.3:5432/d")).toBe(true);
    expect(dialsIpAddress(`postgresql://a@${DNS}:5432/d`)).toBe(false);
    expect(dialsIpAddress("not a url")).toBe(false);
    expect(urlOnDnsHost(`postgresql://a@${DNS}:5432/d`, "x")).toBeNull();
  });
});

// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type CertProbe, domainMappingProbe, lbCertProbe, waitForCert } from "./cert-wait.js";
import type { GcloudResult } from "./gcloud.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** A fake clock the injected sleep advances. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    elapsed: () => t,
  };
}

function probes(...seq: CertProbe[]) {
  let i = 0;
  return async () => seq[Math.min(i++, seq.length - 1)] as CertProbe;
}

describe("waitForCert", () => {
  it("returns once the probe reports ready, reporting each new detail once", async () => {
    const c = clock();
    const updates: string[] = [];
    const r = await waitForCert({
      probe: probes(
        { state: "pending", detail: "waiting for DNS" },
        { state: "pending", detail: "waiting for DNS" },
        { state: "pending", detail: "issuing" },
        { state: "ready" },
      ),
      timeoutMs: 60_000,
      intervalMs: 10_000,
      onUpdate: (d) => updates.push(d),
      ...c,
    });
    expect(r).toEqual({ ok: true });
    expect(updates).toEqual(["waiting for DNS", "issuing"]);
    expect(c.elapsed()).toBe(30_000);
  });

  it("times out with the last detail instead of waiting forever", async () => {
    const c = clock();
    const r = await waitForCert({
      probe: probes({ state: "pending", detail: "CertificateProvisioned: DNS not set" }),
      timeoutMs: 25_000,
      intervalMs: 10_000,
      ...c,
    });
    expect(r).toEqual({
      ok: false,
      reason: "timeout",
      lastDetail: "CertificateProvisioned: DNS not set",
    });
    // Probed at 0, 10s, 20s, 25s (the deadline) — never slept past it.
    expect(c.elapsed()).toBe(25_000);
  });

  it("stops at once when gcloud fails, since waiting cannot fix that", async () => {
    const c = clock();
    const r = await waitForCert({
      probe: probes({ state: "error", error: "PERMISSION_DENIED" }),
      timeoutMs: 60_000,
      intervalMs: 10_000,
      ...c,
    });
    expect(r).toEqual({ ok: false, reason: "error", error: "PERMISSION_DENIED" });
    expect(c.elapsed()).toBe(0);
  });
});

const target = { hostname: "admin.example.com", region: "europe-west1", projectId: "p" };

describe("domainMappingProbe", () => {
  it("is ready when the mapping's Ready condition is True", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return ok(JSON.stringify({ status: { conditions: [{ type: "Ready", status: "True" }] } }));
    };
    expect(await domainMappingProbe(run, target)).toEqual({ state: "ready" });
    expect(calls[0]).toEqual([
      "beta",
      "run",
      "domain-mappings",
      "describe",
      "--domain=admin.example.com",
      "--region=europe-west1",
      "--project=p",
      "--format=json",
    ]);
  });

  it("reports the certificate condition's message while pending", async () => {
    const run = async () =>
      ok(
        JSON.stringify({
          status: {
            conditions: [
              { type: "Ready", status: "Unknown", message: "not ready" },
              {
                type: "CertificateProvisioned",
                status: "Unknown",
                message: "Certificate issuance pending. Add the DNS record.",
              },
              { type: "DomainRoutable", status: "True" },
            ],
          },
        }),
      );
    expect(await domainMappingProbe(run, target)).toEqual({
      state: "pending",
      detail: "CertificateProvisioned: Certificate issuance pending. Add the DNS record.",
    });
  });

  it("is pending (not ready) before Google reports any condition", async () => {
    const run = async () => ok(JSON.stringify({ status: {} }));
    expect((await domainMappingProbe(run, target)).state).toBe("pending");
  });

  it("surfaces a gcloud failure as an error", async () => {
    const run = async () => fail("ERROR: (gcloud) You do not currently have an active account");
    const r = await domainMappingProbe(run, target);
    expect(r.state).toBe("error");
  });
});

describe("lbCertProbe", () => {
  const list = (certs: unknown[]) => async () => ok(JSON.stringify(certs));
  const lb = { projectId: "p", hostname: "admin.example.com" };

  it("is ready when the admin's own certificate is ACTIVE although the main domain's is not", async () => {
    const r = await lbCertProbe(
      list([
        {
          name: "combined",
          managed: {
            status: "PROVISIONING",
            domainStatus: { "example.com": "FAILED_NOT_VISIBLE", "admin.example.com": "ACTIVE" },
          },
        },
        {
          name: "admin-only",
          managed: { status: "ACTIVE", domainStatus: { "admin.example.com": "ACTIVE" } },
        },
      ]),
      lb,
    );
    expect(r).toEqual({ state: "ready" });
  });

  it("does not count a domain that is ACTIVE on a certificate that is not served yet", async () => {
    const r = await lbCertProbe(
      list([
        {
          name: "combined",
          managed: {
            status: "PROVISIONING",
            domainStatus: { "example.com": "FAILED_NOT_VISIBLE", "admin.example.com": "ACTIVE" },
          },
        },
      ]),
      lb,
    );
    expect(r).toEqual({ state: "pending", detail: "combined: admin.example.com ACTIVE" });
  });

  it("is ready for installs that only have the combined certificate, once it is ACTIVE", async () => {
    const r = await lbCertProbe(
      list([
        {
          name: "combined",
          managed: {
            status: "ACTIVE",
            domainStatus: { "example.com": "ACTIVE", "admin.example.com": "ACTIVE" },
          },
        },
      ]),
      lb,
    );
    expect(r).toEqual({ state: "ready" });
  });

  it("is pending when no certificate lists the host", async () => {
    expect((await lbCertProbe(list([]), lb)).state).toBe("pending");
  });
});

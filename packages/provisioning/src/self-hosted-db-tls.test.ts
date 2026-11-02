// SPDX-License-Identifier: MPL-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSelfHostedDbTls,
  generateDatabaseTls,
  SELF_HOSTED_DB_HOST,
  SELF_HOSTED_TLS_DIR,
  serverCertProblem,
} from "./self-hosted-db-tls.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "caelo-db-tls-"));
  dirs.push(d);
  return d;
}

describe("generateDatabaseTls", () => {
  it("makes a CA and a server certificate for `postgres` that chains to it", () => {
    const files = generateDatabaseTls();
    const ca = new X509Certificate(files.caCert);
    const server = new X509Certificate(files.serverCert);
    expect(ca.ca).toBe(true);
    expect(server.ca).toBe(false);
    expect(ca.verify(ca.publicKey)).toBe(true);
    expect(server.verify(ca.publicKey)).toBe(true);
    expect(server.checkHost(SELF_HOSTED_DB_HOST)).toBe(SELF_HOSTED_DB_HOST);
    expect(server.checkHost("evil.example")).toBeUndefined();
    expect(server.issuer).toBe(ca.subject);
    expect(serverCertProblem(files.caCert, files.serverCert, new Date())).toBeNull();
  });

  it("passes a real TLS handshake with host-name verification (Bun's TLS)", async () => {
    // The same check a verify-full Postgres client makes: the chain must end
    // at the CA we pass, and the certificate must name the host dialled.
    // `localhost` stands in for `postgres` (resolvable here), via the same
    // generator path.
    const files = generateDatabaseTls();
    using server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: files.serverCert, key: files.serverKey },
      fetch: () => new Response("ok"),
    });
    const url = `https://127.0.0.1:${server.port}/`;
    // Right CA + the certificate's host name (SNI/verify against `postgres`).
    const ok = await fetch(url, {
      tls: {
        ca: files.caCert,
        checkServerIdentity: (_host, cert) =>
          cert.subjectaltname === `DNS:${SELF_HOSTED_DB_HOST}`
            ? undefined
            : new Error(`unexpected SAN ${cert.subjectaltname}`),
      },
    });
    expect(await ok.text()).toBe("ok");
    // Another CA: the chain does not verify.
    await expect(fetch(url, { tls: { ca: generateDatabaseTls().caCert } })).rejects.toThrow();
  });
});

describe("ensureSelfHostedDbTls", () => {
  it("creates the files once, keys 0600, and keeps them on a re-run", () => {
    const caelo = tempDir();
    expect(ensureSelfHostedDbTls(caelo)).toHaveLength(1);
    const dir = join(caelo, SELF_HOSTED_TLS_DIR);
    expect(statSync(join(dir, "ca.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "server.key")).mode & 0o777).toBe(0o600);
    const ca = readFileSync(join(dir, "ca.crt"), "utf8");
    const server = readFileSync(join(dir, "server.crt"), "utf8");
    expect(ensureSelfHostedDbTls(caelo)).toEqual([]);
    expect(readFileSync(join(dir, "ca.crt"), "utf8")).toBe(ca);
    expect(readFileSync(join(dir, "server.crt"), "utf8")).toBe(server);
  });

  it("re-issues a server certificate near its end from the same CA", () => {
    const caelo = tempDir();
    ensureSelfHostedDbTls(caelo);
    const dir = join(caelo, SELF_HOSTED_TLS_DIR);
    const ca = readFileSync(join(dir, "ca.crt"), "utf8");
    const later = new Date(Date.now() + 9.5 * 365 * 24 * 3600 * 1000);
    const done = ensureSelfHostedDbTls(caelo, later);
    expect(done[0]).toMatch(/re-issued.*expires/);
    expect(readFileSync(join(dir, "ca.crt"), "utf8")).toBe(ca);
    const fresh = readFileSync(join(dir, "server.crt"), "utf8");
    expect(serverCertProblem(ca, fresh, later)).toBeNull();
  });

  it("re-issues a server certificate another CA signed", () => {
    const caelo = tempDir();
    ensureSelfHostedDbTls(caelo);
    const dir = join(caelo, SELF_HOSTED_TLS_DIR);
    writeFileSync(join(dir, "server.crt"), generateDatabaseTls().serverCert);
    expect(ensureSelfHostedDbTls(caelo)[0]).toMatch(/not signed by the install's CA/);
  });

  it("refuses half a CA instead of silently replacing the trust anchor", () => {
    const caelo = tempDir();
    ensureSelfHostedDbTls(caelo);
    rmSync(join(caelo, SELF_HOSTED_TLS_DIR, "ca.key"));
    expect(() => ensureSelfHostedDbTls(caelo)).toThrow(/only half of the database CA/);
  });
});

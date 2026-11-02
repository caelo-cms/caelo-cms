// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { X509Certificate } from "node:crypto";
import { resolve } from "node:path";
import {
  AWS_RDS_CA_BUNDLE,
  CLOUD_SQL_CA_BUNDLE,
  DATABASE_CA_DIR,
  databaseTlsProblem,
  isIpLiteral,
  verifyFullQuery,
} from "./database-tls.js";

const CERTS = resolve(import.meta.dir, "../certs");

/** The certificates of a PEM bundle in the repo. */
async function bundle(name: string): Promise<X509Certificate[]> {
  const pem = await Bun.file(resolve(CERTS, name)).text();
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((b) => new X509Certificate(b));
}

describe("shipped database CA bundles", () => {
  // The images copy packages/shared/certs/ to DATABASE_CA_DIR; the constants
  // name files there, so each must exist in the repo under the same name.
  for (const path of [CLOUD_SQL_CA_BUNDLE, AWS_RDS_CA_BUNDLE]) {
    const name = path.slice(DATABASE_CA_DIR.length + 1);
    it(`${name} parses, holds a root, and no certificate expires within two years`, async () => {
      const certs = await bundle(name);
      expect(certs.length).toBeGreaterThan(0);
      expect(certs.some((c) => c.subject === c.issuer)).toBe(true);
      // A bundle that is about to expire breaks every connection of every
      // install on that day: refresh it from the provider (see the file
      // comment of database-tls.ts for the URLs) well before.
      const horizon = Date.now() + 2 * 365 * 24 * 3600 * 1000;
      for (const c of certs) expect(Date.parse(c.validTo)).toBeGreaterThan(horizon);
    });
  }

  it("holds no private key", async () => {
    for (const name of ["cloudsql-global.pem", "aws-rds-global.pem"]) {
      expect(await Bun.file(resolve(CERTS, name)).text()).not.toMatch(/PRIVATE KEY/);
    }
  });
});

describe("verifyFullQuery", () => {
  it("names the CA bundle, or relies on the public roots without one", () => {
    expect(verifyFullQuery(CLOUD_SQL_CA_BUNDLE)).toBe(
      "sslmode=verify-full&sslrootcert=/etc/caelo/db-ca/cloudsql-global.pem",
    );
    expect(verifyFullQuery()).toBe("sslmode=verify-full");
  });
});

describe("databaseTlsProblem", () => {
  it("accepts verify-full to a remote host", () => {
    expect(databaseTlsProblem(`postgres://a@db.example:5432/d?${verifyFullQuery()}`)).toBeNull();
  });

  it("refuses every weaker mode to a remote host", () => {
    for (const q of ["", "?sslmode=require", "?sslmode=verify-ca", "?sslmode=prefer"]) {
      expect(databaseTlsProblem(`postgres://a@10.0.0.3:5432/d${q}`, "X_URL")).toMatch(
        /^X_URL reaches 10\.0\.0\.3 /,
      );
    }
  });

  it("refuses a URL that does not parse", () => {
    expect(databaseTlsProblem("not a url", "X_URL")).toBe("X_URL is not a valid URL");
  });
});

describe("isIpLiteral", () => {
  it("tells IP literals from host names", () => {
    expect(isIpLiteral("10.20.0.3")).toBe(true);
    expect(isIpLiteral("[fd00::3]")).toBe(true);
    expect(isIpLiteral("fd00::3")).toBe(true);
    expect(isIpLiteral("i1.p.europe-west1.sql-psa.goog")).toBe(false);
    expect(isIpLiteral("postgres")).toBe(false);
  });
});

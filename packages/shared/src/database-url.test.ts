// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  cloudSqlIamDatabaseUrls,
  cloudSqlIamIpDatabaseUrls,
  databasePasswordVar,
  databaseUrlFromEnv,
  withDatabasePassword,
} from "./database-url.js";

describe("databasePasswordVar", () => {
  it("pairs each URL var with its _PASSWORD var", () => {
    expect(databasePasswordVar("ADMIN_DATABASE_URL")).toBe("ADMIN_DATABASE_PASSWORD");
    expect(databasePasswordVar("PUBLIC_ADMIN_DATABASE_URL")).toBe("PUBLIC_ADMIN_DATABASE_PASSWORD");
    expect(databasePasswordVar("PUBLIC_DATABASE_URL")).toBe("PUBLIC_DATABASE_PASSWORD");
  });

  it("rejects a name that is not a URL var", () => {
    expect(() => databasePasswordVar("ADMIN_DATABASE")).toThrow(/_URL/);
  });
});

describe("withDatabasePassword", () => {
  it("injects the password into a password-less URL, keeping host, db and params", () => {
    expect(
      withDatabasePassword(
        "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
        "0123abcd",
      ),
    ).toBe("postgresql://admin_role:0123abcd@10.20.0.3:5432/cms_admin?sslmode=require");
  });

  it("keeps literal percent signs in the password (p%40ss stays p%40ss, p%ss stays valid)", () => {
    for (const password of ["p%40ss", "p%ss", "100%"]) {
      const parsed = new URL(withDatabasePassword("postgres://u@h:5432/d", password));
      expect(decodeURIComponent(parsed.password)).toBe(password);
    }
  });

  it("percent-encodes reserved characters so the URL stays parseable", () => {
    const url = withDatabasePassword("postgres://u@h:5432/d", "p@ss/w:rd#?");
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.password)).toBe("p@ss/w:rd#?");
    expect(parsed.host).toBe("h:5432");
    expect(parsed.pathname).toBe("/d");
  });

  it("refuses a URL that already carries a password", () => {
    expect(() => withDatabasePassword("postgres://u:old@h/d", "new")).toThrow(/already carries/);
  });

  it("refuses a URL without a user and a malformed URL", () => {
    expect(() => withDatabasePassword("postgres://h/d", "p")).toThrow(/no user/);
    expect(() => withDatabasePassword("not a url", "p")).toThrow(/not a valid URL/);
  });

  it("never echoes the password in its errors", () => {
    try {
      withDatabasePassword("postgres://u:old@h/d", "top-secret-value");
    } catch (e) {
      expect(String(e)).not.toContain("top-secret-value");
      expect(String(e)).not.toContain("old");
    }
  });
});

describe("databaseUrlFromEnv", () => {
  it("returns an inline-password URL unchanged (self-hosted compose, CI, .env)", () => {
    const env = { ADMIN_DATABASE_URL: "postgres://admin_role:dev@localhost:5432/cms_admin" };
    expect(databaseUrlFromEnv(["ADMIN_DATABASE_URL"], env)).toBe(env.ADMIN_DATABASE_URL);
  });

  it("composes the URL from the plain URL var + its secret-mounted password var (cloud)", () => {
    const env = {
      ADMIN_DATABASE_URL:
        "postgresql://admin_role@i1.p.europe-west1.sql-psa.goog:5432/cms_admin?sslmode=verify-full&sslrootcert=/etc/caelo/db-ca/cloudsql-global.pem",
      ADMIN_DATABASE_PASSWORD: "s3cret",
    };
    expect(databaseUrlFromEnv(["ADMIN_DATABASE_URL"], env)).toBe(
      "postgresql://admin_role:s3cret@i1.p.europe-west1.sql-psa.goog:5432/cms_admin?sslmode=verify-full&sslrootcert=/etc/caelo/db-ca/cloudsql-global.pem",
    );
  });

  it("uses the password var that belongs to the URL var it picked", () => {
    const env = {
      PUBLIC_DATABASE_URL: "postgresql://public_role@h:5432/cms_public?sslmode=verify-full",
      PUBLIC_DATABASE_PASSWORD: "pub",
      // Not consulted: it pairs with PUBLIC_ADMIN_DATABASE_URL, which is unset.
      PUBLIC_ADMIN_DATABASE_PASSWORD: "adm",
    };
    expect(databaseUrlFromEnv(["PUBLIC_ADMIN_DATABASE_URL", "PUBLIC_DATABASE_URL"], env)).toBe(
      "postgresql://public_role:pub@h:5432/cms_public?sslmode=verify-full",
    );
  });

  it("prefers the first URL var that is set", () => {
    const env = {
      PUBLIC_ADMIN_DATABASE_URL: "postgresql://admin_role@h:5432/cms_public?sslmode=verify-full",
      PUBLIC_ADMIN_DATABASE_PASSWORD: "adm",
      PUBLIC_DATABASE_URL: "postgresql://public_role@h:5432/cms_public?sslmode=verify-full",
    };
    expect(databaseUrlFromEnv(["PUBLIC_ADMIN_DATABASE_URL", "PUBLIC_DATABASE_URL"], env)).toBe(
      "postgresql://admin_role:adm@h:5432/cms_public?sslmode=verify-full",
    );
  });

  it("is undefined when no URL var is set", () => {
    expect(databaseUrlFromEnv(["ADMIN_DATABASE_URL"], { ADMIN_DATABASE_PASSWORD: "x" })).toBe(
      undefined,
    );
  });

  it("fails loudly when both the URL and the password var carry a password", () => {
    const env = {
      ADMIN_DATABASE_URL: "postgres://admin_role:inline@h/cms_admin?sslmode=verify-full",
      ADMIN_DATABASE_PASSWORD: "mounted",
    };
    expect(() => databaseUrlFromEnv(["ADMIN_DATABASE_URL"], env)).toThrow(
      /ADMIN_DATABASE_URL \(with ADMIN_DATABASE_PASSWORD\) already carries a password/,
    );
  });
});

describe("cloudSqlIamDatabaseUrls", () => {
  it("logs in as the service account's IAM database user with the token as password", () => {
    expect(
      cloudSqlIamDatabaseUrls(
        "i1.p.europe-west1.sql-psa.goog",
        "job@p.iam.gserviceaccount.com",
        "ya29/x",
      ),
    ).toEqual({
      user: "job@p.iam",
      admin:
        "postgresql://job%40p.iam:ya29%2Fx@i1.p.europe-west1.sql-psa.goog:5432/cms_admin?sslmode=verify-full&sslrootcert=/etc/caelo/db-ca/cloudsql-global.pem",
      public:
        "postgresql://job%40p.iam:ya29%2Fx@i1.p.europe-west1.sql-psa.goog:5432/cms_public?sslmode=verify-full&sslrootcert=/etc/caelo/db-ca/cloudsql-global.pem",
    });
  });

  it("refuses an IP host: the shared-CA certificate names only the instance's DNS name", () => {
    expect(() => cloudSqlIamDatabaseUrls("10.0.0.3", "job@p.iam.gserviceaccount.com", "t")).toThrow(
      /names only its DNS name.*cms-provision upgrade/,
    );
  });
});

describe("cloudSqlIamIpDatabaseUrls (#1373)", () => {
  it("dials the IP with verify-full and no trust anchor: the caller passes the server checks", () => {
    expect(cloudSqlIamIpDatabaseUrls("10.0.0.3", "job@p.iam.gserviceaccount.com", "t").admin).toBe(
      "postgresql://job%40p.iam:t@10.0.0.3:5432/cms_admin?sslmode=verify-full",
    );
  });

  it("refuses a host name, which takes the plain verify-full URLs", () => {
    expect(() =>
      cloudSqlIamIpDatabaseUrls("i1.p.europe-west1.sql-psa.goog", "job@p.iam", "t"),
    ).toThrow(/cloudSqlIamDatabaseUrls/);
  });
});

describe("databaseUrlFromEnv TLS (#1338)", () => {
  it("refuses a remote host without verify-full and names the variable", () => {
    for (const mode of ["", "?sslmode=require", "?sslmode=verify-ca", "?sslmode=disable"]) {
      expect(() =>
        databaseUrlFromEnv(["PUBLIC_DATABASE_URL"], {
          PUBLIC_DATABASE_URL: `postgres://public_role:x@postgres:5432/cms_public${mode}`,
        }),
      ).toThrow(/PUBLIC_DATABASE_URL reaches postgres .*verify-full/);
    }
  });

  it("lets loopback hosts and unix sockets connect without TLS (dev, CI, tests)", () => {
    for (const url of [
      "postgres://a:x@localhost:5432/d",
      "postgres://a:x@127.0.0.1:5541/d",
      "postgres://a:x@[::1]:5432/d",
      "postgres://a:x@sockethost/d?host=/var/run/postgresql",
    ]) {
      expect(databaseUrlFromEnv(["U_URL"], { U_URL: url })).toBe(url);
    }
  });
});

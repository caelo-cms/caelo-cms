// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { databasePasswordVar, databaseUrlFromEnv, withDatabasePassword } from "./database-url.js";

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
      ADMIN_DATABASE_URL: "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
      ADMIN_DATABASE_PASSWORD: "s3cret",
    };
    expect(databaseUrlFromEnv(["ADMIN_DATABASE_URL"], env)).toBe(
      "postgresql://admin_role:s3cret@10.20.0.3:5432/cms_admin?sslmode=require",
    );
  });

  it("uses the password var that belongs to the URL var it picked", () => {
    const env = {
      PUBLIC_DATABASE_URL: "postgresql://public_role@h:5432/cms_public",
      PUBLIC_DATABASE_PASSWORD: "pub",
      // Not consulted: it pairs with PUBLIC_ADMIN_DATABASE_URL, which is unset.
      PUBLIC_ADMIN_DATABASE_PASSWORD: "adm",
    };
    expect(databaseUrlFromEnv(["PUBLIC_ADMIN_DATABASE_URL", "PUBLIC_DATABASE_URL"], env)).toBe(
      "postgresql://public_role:pub@h:5432/cms_public",
    );
  });

  it("prefers the first URL var that is set", () => {
    const env = {
      PUBLIC_ADMIN_DATABASE_URL: "postgresql://admin_role@h:5432/cms_public",
      PUBLIC_ADMIN_DATABASE_PASSWORD: "adm",
      PUBLIC_DATABASE_URL: "postgresql://public_role@h:5432/cms_public",
    };
    expect(databaseUrlFromEnv(["PUBLIC_ADMIN_DATABASE_URL", "PUBLIC_DATABASE_URL"], env)).toBe(
      "postgresql://admin_role:adm@h:5432/cms_public",
    );
  });

  it("is undefined when no URL var is set", () => {
    expect(databaseUrlFromEnv(["ADMIN_DATABASE_URL"], { ADMIN_DATABASE_PASSWORD: "x" })).toBe(
      undefined,
    );
  });

  it("fails loudly when both the URL and the password var carry a password", () => {
    const env = {
      ADMIN_DATABASE_URL: "postgres://admin_role:inline@h/cms_admin",
      ADMIN_DATABASE_PASSWORD: "mounted",
    };
    expect(() => databaseUrlFromEnv(["ADMIN_DATABASE_URL"], env)).toThrow(
      /ADMIN_DATABASE_URL \(with ADMIN_DATABASE_PASSWORD\) already carries a password/,
    );
  });
});

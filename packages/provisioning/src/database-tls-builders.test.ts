// SPDX-License-Identifier: MPL-2.0

/**
 * #1338 — every database URL a provider adapter builds asks for
 * `sslmode=verify-full`, and no adapter still builds a weaker one
 * (CLAUDE.md §2 no fallbacks: a downgrade is never silent).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { databaseTlsProblem } from "@caelo-cms/shared";
import { generateDockerCompose } from "./compose.js";
import { databaseUrls } from "./stack-contract.js";

const DNS = "abc123.p-label.europe-west1.sql-psa.goog";

describe("database URL builders (#1338)", () => {
  it("Cloud SQL: verify-full on the instance's DNS name, never on its IP", () => {
    for (const url of Object.values(databaseUrls(DNS))) {
      expect(databaseTlsProblem(url)).toBeNull();
      expect(new URL(url).hostname).toBe(DNS);
    }
    expect(() => databaseUrls("10.20.0.3")).toThrow(/DNS name/);
  });

  it("self-hosted Compose: every service URL is verify-full against the install's CA", () => {
    const yaml = generateDockerCompose({
      domain: "example.com",
      postgresPassword: "superpw",
      rolePasswords: { admin: "adminpw", public: "publicpw", publicStaging: "ps" },
      caeloSecretKek: "0".repeat(64),
      dbTlsServerCertSha256: "abababababababababababababababababababababababababababababababab",
      internalSecret: "i".repeat(48),
      diskSize: "20Gi",
      images: {
        mode: "release",
        admin: `ghcr.io/caelo-cms/admin@sha256:${"a".repeat(64)}`,
        gateway: `ghcr.io/caelo-cms/gateway@sha256:${"b".repeat(64)}`,
      },
      ports: { http: 80, https: 443 },
      project: "caelo-example-com",
    });
    const urls = [...yaml.matchAll(/_DATABASE_URL: "([^"]+)"/g)].map((m) => m[1] as string);
    // admin: cms_admin, cms_public, cms_public_staging (#1329); gateway: cms_public.
    expect(urls).toHaveLength(4);
    for (const url of urls) expect(databaseTlsProblem(url)).toBeNull();
  });

  for (const stack of ["gcp", "gcp-firebase", "aws", "azure"]) {
    it(`stacks/${stack} builds no URL weaker than verify-full`, () => {
      const src = readFileSync(resolve(import.meta.dir, `../stacks/${stack}/index.ts`), "utf8");
      expect(src).not.toMatch(/sslmode=(disable|allow|prefer|require|verify-ca)\b/);
    });
  }
});

// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: provisioned installs never told the admin their public URL,
 * so site_defaults.site_base_url kept the dev default and every canonical,
 * og:url, JSON-LD url, sitemap <loc> and robots.txt `Sitemap:` line on the
 * live site pointed at http://localhost:8082. Every path that brings up an
 * admin for a known domain must now hand it CAELO_SITE_BASE_URL — new
 * installs through the stacks / compose file, existing ones through
 * `cms-provision upgrade`. Stack programs are checked as source strings,
 * like the other stack tests.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateDockerCompose } from "./compose.js";
import { adminEnvUpdateArgs, SITE_BASE_URL_ENV, siteBaseUrlForDomain } from "./site-base-url.js";

const read = (rel: string) => readFileSync(resolve(import.meta.dir, rel), "utf8");

describe("site base URL hand-off", () => {
  it("uses the env var name the admin reads (@caelo-cms/shared SITE_BASE_URL_ENV)", () => {
    expect(SITE_BASE_URL_ENV).toBe("CAELO_SITE_BASE_URL");
    expect(read("../../shared/src/seo.ts")).toContain(
      `export const SITE_BASE_URL_ENV = "${SITE_BASE_URL_ENV}";`,
    );
  });

  it("derives the public URL from the apex domain", () => {
    expect(siteBaseUrlForDomain("example.com")).toBe("https://example.com");
  });

  it.each(["gcp", "gcp-firebase", "azure"])("%s stack sets it on the admin", (provider) => {
    expect(read(`../stacks/${provider}/index.ts`)).toContain(
      `{ name: "CAELO_SITE_BASE_URL", value: \`https://\${domain}\` }`,
    );
  });

  it("the self-hosted compose file sets it on the admin", () => {
    const out = generateDockerCompose({
      domain: "example.com",
      postgresPassword: "x",
      minioRootUser: "caelo",
      minioRootPassword: "x",
      caeloSecretKek: "0".repeat(64),
      diskSize: "1Gi",
    });
    const admin = out.slice(out.indexOf("caelo-admin:"), out.indexOf("caelo-gateway:"));
    expect(admin).toContain('CAELO_SITE_BASE_URL: "https://example.com"');
  });

  it("`cms-provision upgrade` sets it on the admin revision for existing installs", () => {
    const src = read("./lifecycle.ts");
    expect(src).toContain("[SITE_BASE_URL_ENV, siteBaseUrlForDomain(meta.domain)]");
    expect(src).toContain('...(plan.slug === "admin" ? adminEnvUpdateArgs(adminEnv) : [])');
  });
});

describe("adminEnvUpdateArgs", () => {
  it("packs every pair into one --update-env-vars flag", () => {
    expect(
      adminEnvUpdateArgs([
        ["CAELO_SITE_BASE_URL", "https://example.com"],
        ["CAELO_MCP_IAP_SERVICE_ACCOUNT", "caelo-mcp@p.iam.gserviceaccount.com"],
      ]),
    ).toEqual([
      "--update-env-vars=CAELO_SITE_BASE_URL=https://example.com,CAELO_MCP_IAP_SERVICE_ACCOUNT=caelo-mcp@p.iam.gserviceaccount.com",
    ]);
  });

  it("emits nothing for no pairs", () => {
    expect(adminEnvUpdateArgs([])).toEqual([]);
  });

  it("rejects a value gcloud would split on its comma", () => {
    expect(() => adminEnvUpdateArgs([["X", "a,b"]])).toThrow("contains a comma");
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #37 — new installs must get MCP-through-IAP from Pulumi alone, with the
 * same names `cms-provision upgrade` uses for older installs (mcp-iap.ts).
 * Pure-string checks on the stack programs, like the other stack tests.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mcpIapServiceAccountEmail } from "./gcp-names.js";
import { adminEnvContract, databaseUrls } from "./stack-contract.js";

const stack = (provider: string) =>
  readFileSync(resolve(import.meta.dir, `../stacks/${provider}/index.ts`), "utf8");

describe.each(["gcp", "gcp-firebase"])("%s stack — MCP through IAP", (provider) => {
  const src = stack(provider);

  it("creates the MCP service account under the id upgrade uses, tolerating one upgrade created", () => {
    expect(src).toContain("accountId: MCP_IAP_SERVICE_ACCOUNT_ID,");
    expect(src).toContain("createIgnoreAlreadyExists: true");
  });

  it("lets every IAP-allowlisted principal sign as it", () => {
    expect(src).toMatch(
      /for \(const principal of iapAllowlist\) \{[\s\S]*?serviceaccount\.IAMMember\([\s\S]*?roles\/iam\.serviceAccountTokenCreator/,
    );
  });

  it("allowlists the service account on the admin's IAP resource", () => {
    const iapType =
      provider === "gcp" ? "WebBackendServiceIamMember" : "WebCloudRunServiceIamMember";
    expect(src).toMatch(
      new RegExp(
        `${iapType}\\(\\s*\`\\$\\{namePrefix\\}-admin-iap-mcp\`[\\s\\S]*?roles/iap\\.httpsResourceAccessor`,
      ),
    );
  });

  it("hands the email to the admin for the /security/mcp command (via the env contract)", () => {
    // The stack builds the admin env from adminEnvContract (parity test);
    // the contract carries the SA upgrade ensures.
    const env = adminEnvContract({
      provider: "gcp",
      projectId: "p",
      env: "production",
      domain: "d.com",
      region: "r",
      databaseUrls: databaseUrls("10.0.0.3"),
    });
    expect(env).toContainEqual({
      name: "CAELO_MCP_IAP_SERVICE_ACCOUNT",
      value: mcpIapServiceAccountEmail("p"),
    });
  });
});

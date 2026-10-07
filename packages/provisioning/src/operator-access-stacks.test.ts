// SPDX-License-Identifier: MPL-2.0

/**
 * New installs must give the admin's runtime SA the operator-access rights
 * from Pulumi alone, driven by the same list `cms-provision upgrade` applies
 * (operator-access-grants.ts). Pure-string checks, like mcp-iap-stacks.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const stack = (provider: string) =>
  readFileSync(resolve(import.meta.dir, `../stacks/${provider}/index.ts`), "utf8");

describe.each(["gcp", "gcp-firebase"])("%s stack — operator access", (provider) => {
  const src = stack(provider);

  it("derives roles and bindings from the shared grants list", () => {
    expect(src).toContain('from "../../dist/operator-access-grants.js"');
    expect(src).toContain(`g.providers.includes("${provider}")`);
    expect(src).toContain("new gcp.projects.IAMCustomRole(");
  });

  it("binds the custom role on the admin's own IAP resource, not project-wide", () => {
    const iapType =
      provider === "gcp" ? "WebBackendServiceIamMember" : "WebCloudRunServiceIamMember";
    expect(src).toMatch(
      new RegExp(
        `case "admin-iap-resource":\\s*new gcp\\.iap\\.${iapType}\\(\\s*\`\\$\\{namePrefix\\}-admin-iap-operator-access\``,
      ),
    );
  });

  it("binds it on the MCP service account only", () => {
    expect(src).toMatch(
      /case "mcp-service-account":\s*new gcp\.serviceaccount\.IAMMember\([\s\S]*?serviceAccountId: mcpServiceAccount\.name/,
    );
  });

  it("grants to the admin's runtime service account", () => {
    expect(src).toMatch(
      /const adminRuntimeMember = pulumi\.interpolate`serviceAccount:\$\{runSa\.email\}`;/,
    );
  });
});

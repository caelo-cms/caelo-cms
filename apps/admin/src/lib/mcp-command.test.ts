// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { caeloMcpExportCommand, claudeMcpAddCommand } from "./mcp-command.js";

const base = { adminUrl: "https://admin.example.com", token: "tok_123", version: "0.10.28" };

describe("claudeMcpAddCommand", () => {
  it("wires the Power-MCP binary for admin tokens (unchanged without IAP)", () => {
    expect(claudeMcpAddCommand({ ...base, scope: "admin", iapServiceAccount: null })).toBe(
      [
        "claude mcp add caelo-admin \\",
        "  --env CAELO_ADMIN_URL=https://admin.example.com \\",
        "  --env CAELO_MCP_TOKEN=tok_123 \\",
        "  -- bunx --package @caelo-cms/mcp-server@0.10.28 caelo-admin-mcp",
      ].join("\n"),
    );
  });

  it("wires the caelo_chat shim for chat tokens", () => {
    const cmd = claudeMcpAddCommand({ ...base, scope: "chat", iapServiceAccount: null });
    expect(cmd.startsWith("claude mcp add caelo \\")).toBe(true);
    expect(cmd.endsWith("-- bunx @caelo-cms/mcp-server@0.10.28")).toBe(true);
  });

  // Regression: an unpinned `bunx @caelo-cms/mcp-server` served a cached
  // 0.10.27 (no IAP support, #546) against a 0.10.28 admin → "Invalid IAP
  // credentials: empty token". The shim must always match the admin.
  it("pins the package to the admin's version for both scopes", () => {
    for (const scope of ["admin", "chat"]) {
      const cmd = claudeMcpAddCommand({
        ...base,
        version: "1.2.3",
        scope,
        iapServiceAccount: null,
      });
      expect(cmd).toContain("@caelo-cms/mcp-server@1.2.3");
      expect(cmd).not.toMatch(/@caelo-cms\/mcp-server(?!@)/);
    }
  });

  it("adds the IAP service account on IAP installs (issue #37), before the `--`", () => {
    const cmd = claudeMcpAddCommand({
      ...base,
      scope: "admin",
      iapServiceAccount: "caelo-mcp@p.iam.gserviceaccount.com",
    });
    const iap = cmd.indexOf("--env CAELO_IAP_SERVICE_ACCOUNT=caelo-mcp@p.iam.gserviceaccount.com");
    expect(iap).toBeGreaterThan(0);
    expect(iap).toBeLessThan(cmd.indexOf(" -- bunx"));
  });
});

describe("caeloMcpExportCommand", () => {
  it("runs the pinned `caelo-mcp-server export` with the same env", () => {
    expect(caeloMcpExportCommand({ ...base, iapServiceAccount: null })).toBe(
      [
        "CAELO_ADMIN_URL=https://admin.example.com \\",
        "  CAELO_MCP_TOKEN=tok_123 \\",
        "  bunx --package @caelo-cms/mcp-server@0.10.28 caelo-mcp-server export --out .",
      ].join("\n"),
    );
  });

  it("carries the IAP service account on IAP installs", () => {
    const cmd = caeloMcpExportCommand({
      ...base,
      iapServiceAccount: "caelo-mcp@p.iam.gserviceaccount.com",
    });
    expect(cmd).toContain("CAELO_IAP_SERVICE_ACCOUNT=caelo-mcp@p.iam.gserviceaccount.com \\");
  });
});

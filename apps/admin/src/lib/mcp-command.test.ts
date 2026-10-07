// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { claudeMcpAddCommand } from "./mcp-command.js";

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

  it("#552: pins the mcp-server package to the admin's release for both scopes", () => {
    for (const scope of ["admin", "chat"]) {
      const cmd = claudeMcpAddCommand({
        ...base,
        scope,
        iapServiceAccount: null,
        version: "1.2.3",
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

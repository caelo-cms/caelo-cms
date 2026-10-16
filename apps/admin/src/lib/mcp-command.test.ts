// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { claudeMcpAddCommand } from "./mcp-command.js";

const base = { adminUrl: "https://admin.example.com", token: "tok_123" };

describe("claudeMcpAddCommand", () => {
  it("wires the Power-MCP binary for admin tokens (unchanged without IAP)", () => {
    expect(claudeMcpAddCommand({ ...base, scope: "admin", iapServiceAccount: null })).toBe(
      [
        "claude mcp add caelo-admin \\",
        "  --env CAELO_ADMIN_URL=https://admin.example.com \\",
        "  --env CAELO_MCP_TOKEN=tok_123 \\",
        "  -- bunx --package @caelo-cms/mcp-server@latest caelo-admin-mcp",
      ].join("\n"),
    );
  });

  it("wires the caelo_chat shim for chat tokens", () => {
    const cmd = claudeMcpAddCommand({ ...base, scope: "chat", iapServiceAccount: null });
    expect(cmd.startsWith("claude mcp add caelo \\")).toBe(true);
    expect(cmd.endsWith("-- bunx @caelo-cms/mcp-server@latest")).toBe(true);
  });

  it("#764: carries no release number for either scope — the shim pins itself to the admin's release", () => {
    for (const scope of ["admin", "chat"]) {
      const cmd = claudeMcpAddCommand({ ...base, scope, iapServiceAccount: null });
      expect(cmd).not.toMatch(/@caelo-cms\/mcp-server@\d/);
    }
  });

  it("#764: resolves @latest, so bunx never reuses a cached pre-handshake shim", () => {
    // A bare name lets bunx run its cached unversioned install (up to a day old)
    // or a same-named binary on PATH; a dist-tag asks the registry every start.
    for (const scope of ["admin", "chat"]) {
      const cmd = claudeMcpAddCommand({ ...base, scope, iapServiceAccount: null });
      expect(cmd).toContain("@caelo-cms/mcp-server@latest");
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

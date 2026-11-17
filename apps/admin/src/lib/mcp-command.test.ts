// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  CLAUDE_PLUGIN,
  claudeMcpAddCommand,
  claudePluginInstallCommands,
  mcpAddCommand,
  mcpConfigJson,
  mcpServerSpec,
  remoteMcpAddCommand,
  remoteMcpConfigJson,
  remoteMcpServer,
  shellWord,
} from "./mcp-command.js";

const base = { adminUrl: "https://admin.example.com", token: "tok_123" };

describe("claudeMcpAddCommand", () => {
  it("wires the Power-MCP binary for Power tokens (unchanged without IAP)", () => {
    expect(claudeMcpAddCommand({ ...base, scope: "power", iapServiceAccount: null })).toBe(
      [
        "claude mcp add caelo-power \\",
        "  --env CAELO_ADMIN_URL=https://admin.example.com \\",
        "  --env CAELO_MCP_TOKEN=tok_123 \\",
        "  -- bunx --package @caelo-cms/mcp-server@latest caelo-power-mcp",
      ].join("\n"),
    );
  });

  it("wires the caelo_chat shim for chat tokens", () => {
    const cmd = claudeMcpAddCommand({ ...base, scope: "chat", iapServiceAccount: null });
    expect(cmd.startsWith("claude mcp add caelo \\")).toBe(true);
    expect(cmd.endsWith("-- bunx @caelo-cms/mcp-server@latest")).toBe(true);
  });

  it("#764: carries no release number for either scope — the shim pins itself to the admin's release", () => {
    for (const scope of ["power", "chat"] as const) {
      const cmd = claudeMcpAddCommand({ ...base, scope, iapServiceAccount: null });
      expect(cmd).not.toMatch(/@caelo-cms\/mcp-server@\d/);
    }
  });

  it("#764: resolves @latest, so bunx never reuses a cached pre-handshake shim", () => {
    // A bare name lets bunx run its cached unversioned install (up to a day old)
    // or a same-named binary on PATH; a dist-tag asks the registry every start.
    for (const scope of ["power", "chat"] as const) {
      const cmd = claudeMcpAddCommand({ ...base, scope, iapServiceAccount: null });
      expect(cmd).toContain("@caelo-cms/mcp-server@latest");
    }
  });

  it("adds the IAP service account on IAP installs (issue #37), before the `--`", () => {
    const cmd = claudeMcpAddCommand({
      ...base,
      scope: "power",
      iapServiceAccount: "caelo-mcp@p.iam.gserviceaccount.com",
    });
    const iap = cmd.indexOf("--env CAELO_IAP_SERVICE_ACCOUNT=caelo-mcp@p.iam.gserviceaccount.com");
    expect(iap).toBeGreaterThan(0);
    expect(iap).toBeLessThan(cmd.indexOf(" -- bunx"));
  });
});

describe("mcpAddCommand", () => {
  it("renders Codex CLI with the same options-then-`--` shape as Claude Code", () => {
    const args = {
      ...base,
      scope: "power" as const,
      iapServiceAccount: "sa@p.iam.gserviceaccount.com",
    };
    expect(mcpAddCommand("codex", args)).toBe(
      claudeMcpAddCommand(args).replace(/^claude /, "codex "),
    );
  });
});

describe("shellWord", () => {
  it("leaves plain URL, token and service-account values unquoted", () => {
    for (const v of [
      "CAELO_ADMIN_URL=https://admin.example.com:8443",
      "sa@p.iam.gserviceaccount.com",
    ]) {
      expect(shellWord(v)).toBe(v);
    }
  });

  it("single-quotes anything a shell would interpret, escaping embedded quotes", () => {
    expect(shellWord("CAELO_ADMIN_URL=https://a$(id)&b")).toBe(
      "'CAELO_ADMIN_URL=https://a$(id)&b'",
    );
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
  });

  it("is applied to every --env value of the add command", () => {
    const cmd = mcpAddCommand("claude", {
      ...base,
      adminUrl: "https://a;b.example.com",
      scope: "power",
      iapServiceAccount: null,
    });
    expect(cmd).toContain("--env 'CAELO_ADMIN_URL=https://a;b.example.com'");
  });
});

describe("mcpConfigJson", () => {
  const iapArgs = {
    ...base,
    scope: "power" as const,
    iapServiceAccount: "sa@p.iam.gserviceaccount.com",
  };

  it("renders the mcpServers shape (Claude Desktop, Cursor, Gemini CLI) from the same spec", () => {
    expect(JSON.parse(mcpConfigJson("mcpServers", iapArgs))).toEqual({
      mcpServers: {
        "caelo-power": {
          command: "bunx",
          args: ["--package", "@caelo-cms/mcp-server@latest", "caelo-power-mcp"],
          env: {
            CAELO_ADMIN_URL: "https://admin.example.com",
            CAELO_MCP_TOKEN: "tok_123",
            CAELO_IAP_SERVICE_ACCOUNT: "sa@p.iam.gserviceaccount.com",
          },
        },
      },
    });
  });

  it("renders VS Code's `servers` key with an explicit stdio type", () => {
    const cfg = JSON.parse(
      mcpConfigJson("vscode", { ...base, scope: "chat", iapServiceAccount: null }),
    );
    expect(cfg.mcpServers).toBeUndefined();
    expect(cfg.servers.caelo).toEqual({
      type: "stdio",
      command: "bunx",
      args: ["@caelo-cms/mcp-server@latest"],
      env: { CAELO_ADMIN_URL: "https://admin.example.com", CAELO_MCP_TOKEN: "tok_123" },
    });
  });

  it("keeps server names free of underscores (Gemini CLI rejects them)", () => {
    for (const scope of ["power", "chat"] as const) {
      expect(mcpServerSpec({ ...base, scope, iapServiceAccount: null }).name).not.toContain("_");
    }
  });
});

describe("remote MCP snippets (#806)", () => {
  const url = "https://caelo-production-gateway-bbb-xyz.a.run.app/api/mcp/power";
  const power = remoteMcpServer("power", url, "viu.one");

  it("names each surface after the site, so two sites stay apart in one client (#968)", () => {
    expect(power).toEqual({ name: "caelo-viu-one-power", url });
    expect(remoteMcpServer("chat", "u", "viu.one").name).toBe("caelo-viu-one");
    expect(remoteMcpServer("chat", "u", "Shop.Example.COM:8443").name).toBe(
      "caelo-shop-example-com-8443",
    );
  });

  it("registers by URL in Claude Code (--transport http) and Codex (--url, then login)", () => {
    expect(remoteMcpAddCommand("claude", power)).toBe(
      `claude mcp add --transport http caelo-viu-one-power ${url}`,
    );
    expect(remoteMcpAddCommand("codex", power)).toBe(
      `codex mcp add caelo-viu-one-power --url ${url}\ncodex mcp login caelo-viu-one-power`,
    );
  });

  it("renders each file-configured client's remote key: url, type http + url, httpUrl", () => {
    expect(JSON.parse(remoteMcpConfigJson("cursor", power))).toEqual({
      mcpServers: { "caelo-viu-one-power": { url } },
    });
    expect(JSON.parse(remoteMcpConfigJson("vscode", power))).toEqual({
      servers: { "caelo-viu-one-power": { type: "http", url } },
    });
    // Gemini CLI's `url` means SSE; Streamable HTTP is `httpUrl`.
    expect(JSON.parse(remoteMcpConfigJson("gemini", power))).toEqual({
      mcpServers: { "caelo-viu-one-power": { httpUrl: url } },
    });
  });

  it("carries no token or env: the client signs in through the browser", () => {
    for (const f of ["cursor", "vscode", "gemini"] as const) {
      expect(remoteMcpConfigJson(f, power)).not.toMatch(/TOKEN|env|command/);
    }
  });
});

describe("Claude Code plugin install (#1637)", () => {
  it("adds the marketplace and installs the plugin with the site's Power-MCP URL set", () => {
    const url = "https://caelo-production-mcp-auth-proxy-xyz.a.run.app/api/mcp/power";
    expect(claudePluginInstallCommands(url)).toBe(
      [
        "claude plugin marketplace add caelo-cms/caelo-cms",
        `claude plugin install caelo@caelo-cms --config mcp_url=${url}`,
      ].join("\n"),
    );
    // No token and no local server: the plugin connects by URL.
    expect(claudePluginInstallCommands(url)).not.toMatch(/TOKEN|bunx|--env/);
  });

  it("quotes a URL the shell would read as more than one word", () => {
    expect(claudePluginInstallCommands("https://a;b.example/api/mcp/power")).toContain(
      "--config 'mcp_url=https://a;b.example/api/mcp/power'",
    );
  });

  it("names the plugin by its install id", () => {
    expect(CLAUDE_PLUGIN.id).toBe(`${CLAUDE_PLUGIN.server}@caelo-cms`);
  });
});

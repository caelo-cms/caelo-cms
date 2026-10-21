// SPDX-License-Identifier: MPL-2.0
/**
 * The Claude Code plugin in integrations/claude-code, checked offline.
 *
 * P1: the plugin moves in lockstep with the release: plugin.json `version`
 *     and the mcp-server release its .mcp.json starts are the package's
 *     version, pinned exactly (Anthropic's plugin directory blocks `@latest`
 *     and ranges on a package launcher), and release.ts bumps both before
 *     the release commit.
 * P2: the server gets exactly the variables the MCP Registry entry
 *     advertises, each from a declared userConfig option, the token one
 *     marked sensitive (keychain, never settings.json) and none hardcoded.
 * P3: the marketplace entry at the repo root installs this plugin by the
 *     same name the manifest declares.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PLUGIN_DIR = resolve(REPO_ROOT, "integrations/claude-code");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface UserConfigOption {
  type: string;
  sensitive?: boolean;
}
interface PluginJson {
  name: string;
  version: string;
  userConfig: Record<string, UserConfigOption>;
}
interface McpJson {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

const plugin = readJson<PluginJson>(resolve(PLUGIN_DIR, ".claude-plugin/plugin.json"));
const mcp = readJson<McpJson>(resolve(PLUGIN_DIR, ".mcp.json"));
const pkg = readJson<{ version: string }>(resolve(REPO_ROOT, "packages/mcp-server/package.json"));
const serverJson = readJson<{
  packages: Array<{ environmentVariables: Array<{ name: string; isSecret?: boolean }> }>;
}>(resolve(REPO_ROOT, "packages/mcp-server/server.json"));
const server = mcp.mcpServers.caelo;

describe("Claude Code plugin", () => {
  it("P1: plugin version and mcp-server pin follow the release, pinned exactly", () => {
    expect(plugin.version).toBe(pkg.version);
    expect(server).toBeDefined();
    expect(server?.command).toBe("bunx");
    expect(server?.args).toEqual([
      "--package",
      `@caelo-cms/mcp-server@${pkg.version}`,
      "caelo-admin-mcp",
    ]);

    const releaseSrc = readFileSync(resolve(REPO_ROOT, "scripts/release.ts"), "utf8");
    const mainBody = releaseSrc.slice(releaseSrc.indexOf("async function main()"));
    const at = (call: string) => mainBody.indexOf(call);
    expect(at("bumpClaudePlugin(newVersion, dryRun)")).toBeGreaterThan(0);
    expect(at("maybeGitCommitTag(newVersion, dryRun)")).toBeGreaterThan(
      at("bumpClaudePlugin(newVersion, dryRun)"),
    );
  });

  it("P2: env comes from declared userConfig options, the token one sensitive", () => {
    const advertised = serverJson.packages[0]?.environmentVariables ?? [];
    expect(Object.keys(server?.env ?? {}).sort()).toEqual(advertised.map((v) => v.name).sort());
    for (const [name, value] of Object.entries(server?.env ?? {})) {
      const key = /^\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
      expect(key, `${name} must be a \${user_config.*} reference`).toBeDefined();
      const option = plugin.userConfig[key ?? ""];
      expect(option, `${name} references an undeclared option`).toBeDefined();
      const secret = advertised.find((v) => v.name === name)?.isSecret === true;
      expect(option?.sensitive === true, `${name} sensitive flag`).toBe(secret);
    }
  });

  it("P3: the root marketplace installs the plugin under its manifest name", () => {
    const marketplace = readJson<{ plugins: Array<{ name: string; source: string }> }>(
      resolve(REPO_ROOT, ".claude-plugin/marketplace.json"),
    );
    const entry = marketplace.plugins.find((p) => p.name === plugin.name);
    expect(entry?.source).toBe("./integrations/claude-code");
  });
});

// SPDX-License-Identifier: MPL-2.0
/**
 * The two Claude Code plugins, checked offline (#975, #1637):
 *
 *   - `caelo` (integrations/claude-code) connects to a site's Power-MCP
 *     address by URL; the person signs in with Google.
 *   - `caelo-token` (integrations/claude-code-token) starts Caelo's local
 *     MCP server with a token, for installs without remote MCP and for CI.
 *
 * Two plugins, not one with two servers: Claude Code lists a URL server
 * whose option is empty as failed, and a local server without credentials
 * as connected with every call failing. Each person would see a second
 * Caelo server that does not work (docs/dev/mcp-access.md).
 *
 * P1: both move in lockstep with the release: each plugin.json `version`
 *     is the package's version, the token plugin starts exactly that
 *     mcp-server release (Anthropic's plugin directory blocks `@latest` and
 *     ranges on a package launcher), and release.ts bumps all of it before
 *     the release commit. On main they carry the unreleased marker; users
 *     never get main's copy (P3).
 * P2: the local server gets exactly the variables the MCP Registry entry
 *     advertises, each from a declared userConfig option, the token one
 *     marked sensitive (keychain, never settings.json) and none hardcoded.
 * P3: the marketplace at the repo root installs each plugin by the name its
 *     manifest declares, from the `release-latest` branch — the newest
 *     published release commit, which release.yml moves after publishing —
 *     so main's marketplace.json never changes per release.
 * P4: the URL plugin holds no address, no secret and no code: its one
 *     server is the URL the person enters, and nothing else.
 * P5: both plugins bring the same editing skills, and those name no plugin
 *     option, so they read the same when the server is a connector in
 *     claude.ai or Cowork.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLAUDE_PLUGIN } from "../apps/admin/src/lib/mcp-command.ts";
import { POWER_BIN } from "../packages/mcp-server/src/names.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const URL_PLUGIN_DIR = resolve(REPO_ROOT, "integrations/claude-code");
const TOKEN_PLUGIN_DIR = resolve(REPO_ROOT, "integrations/claude-code-token");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface UserConfigOption {
  type: string;
  sensitive?: boolean;
  default?: string;
}
interface PluginJson {
  name: string;
  version: string;
  userConfig: Record<string, UserConfigOption>;
}
type McpServerEntry = Record<string, unknown> & {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
};
interface McpJson {
  mcpServers: Record<string, McpServerEntry>;
}

const manifest = (dir: string) => readJson<PluginJson>(resolve(dir, ".claude-plugin/plugin.json"));
const servers = (dir: string) => readJson<McpJson>(resolve(dir, ".mcp.json")).mcpServers;

const urlPlugin = manifest(URL_PLUGIN_DIR);
const tokenPlugin = manifest(TOKEN_PLUGIN_DIR);
const pkg = readJson<{ version: string }>(resolve(REPO_ROOT, "packages/mcp-server/package.json"));
const serverJson = readJson<{
  packages: Array<{ environmentVariables: Array<{ name: string; isSecret?: boolean }> }>;
}>(resolve(REPO_ROOT, "packages/mcp-server/server.json"));

/** A `${user_config.KEY}` reference's key, or undefined when `value` is anything else. */
const optionOf = (value: string | undefined): string | undefined =>
  /^\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value ?? "")?.[1];

describe("Claude Code plugins", () => {
  it("P1: plugin versions and the mcp-server pin follow the release, pinned exactly", () => {
    expect(urlPlugin.version).toBe(pkg.version);
    expect(tokenPlugin.version).toBe(pkg.version);
    const server = servers(TOKEN_PLUGIN_DIR).caelo;
    expect(server?.command).toBe("bunx");
    expect(server?.args).toEqual(["--package", `@caelo-cms/mcp-server@${pkg.version}`, POWER_BIN]);

    const releaseSrc = readFileSync(resolve(REPO_ROOT, "scripts/release.ts"), "utf8");
    const mainBody = releaseSrc.slice(releaseSrc.indexOf("async function main()"));
    const at = (call: string) => mainBody.indexOf(call);
    expect(at("bumpClaudePlugins(newVersion, dryRun)")).toBeGreaterThan(0);
    expect(at("maybeGitCommitTag(newVersion, dryRun)")).toBeGreaterThan(
      at("bumpClaudePlugins(newVersion, dryRun)"),
    );
    // The release commit check knows the same files, or a release would go
    // through the full gate for a version stamp.
    const commitSrc = readFileSync(resolve(REPO_ROOT, "scripts/release-commit.ts"), "utf8");
    for (const file of [
      "integrations/claude-code/.claude-plugin/plugin.json",
      "integrations/claude-code-token/.claude-plugin/plugin.json",
      "integrations/claude-code-token/.mcp.json",
    ]) {
      expect(releaseSrc).toContain(file);
      expect(commitSrc).toContain(file);
    }
  });

  it("P2: the local server's env comes from declared userConfig options, the token one sensitive", () => {
    const server = servers(TOKEN_PLUGIN_DIR).caelo;
    const advertised = serverJson.packages[0]?.environmentVariables ?? [];
    expect(Object.keys(server?.env ?? {}).sort()).toEqual(advertised.map((v) => v.name).sort());
    for (const [name, value] of Object.entries(server?.env ?? {})) {
      const key = optionOf(value);
      expect(key, `${name} must be a \${user_config.*} reference`).toBeDefined();
      const option = tokenPlugin.userConfig[key ?? ""];
      expect(option, `${name} references an undeclared option`).toBeDefined();
      const secret = advertised.find((v) => v.name === name)?.isSecret === true;
      expect(option?.sensitive === true, `${name} sensitive flag`).toBe(secret);
    }
  });

  it("P3: the root marketplace installs each plugin under its manifest name, from release-latest", () => {
    const marketplace = readJson<{ plugins: Array<{ name: string; source: unknown }> }>(
      resolve(REPO_ROOT, ".claude-plugin/marketplace.json"),
    );
    expect(marketplace.plugins.map((p) => p.name)).toEqual([urlPlugin.name, tokenPlugin.name]);
    for (const [plugin, path] of [
      [urlPlugin, "integrations/claude-code"],
      [tokenPlugin, "integrations/claude-code-token"],
    ] as const) {
      expect(marketplace.plugins.find((p) => p.name === plugin.name)?.source).toEqual({
        source: "git-subdir",
        url: "https://github.com/caelo-cms/caelo-cms.git",
        path,
        ref: "release-latest",
      });
    }
    // What Settings → MCP → Remote tells people to install.
    expect(CLAUDE_PLUGIN.id).toBe(`${urlPlugin.name}@caelo-cms`);
  });

  it("P4: the URL plugin is one remote server at the address the person enters, and nothing else", () => {
    const all = servers(URL_PLUGIN_DIR);
    expect(Object.keys(all)).toEqual([CLAUDE_PLUGIN.server]);
    // Exactly these two keys: no header (a token would ride in one), no
    // command, no fixed address. An entry with `url` and no `type` is read
    // as a local command by Claude Code.
    const entry = all[CLAUDE_PLUGIN.server];
    expect(Object.keys(entry ?? {}).sort()).toEqual(["type", "url"]);
    expect(entry?.type).toBe("http");
    expect(optionOf(entry?.url)).toBe(CLAUDE_PLUGIN.urlOption);
    expect(Object.keys(urlPlugin.userConfig)).toEqual([CLAUDE_PLUGIN.urlOption]);
    const option = urlPlugin.userConfig[CLAUDE_PLUGIN.urlOption];
    // The address is not a secret (Settings → MCP shows it to every member),
    // and it is empty until the person enters their own site's.
    expect(option?.sensitive).toBeUndefined();
    expect(option?.default).toBe("");
    // Nothing runs on the person's machine: skills and two JSON files.
    expect(readdirSync(URL_PLUGIN_DIR).sort()).toEqual(
      [".claude-plugin", ".mcp.json", "README.md", "skills"].sort(),
    );
  });

  it("P5: both plugins bring the same editing skills, which name no plugin option", () => {
    const skill = (dir: string, name: string) =>
      readFileSync(resolve(dir, "skills", name, "SKILL.md"), "utf8");
    for (const dir of [URL_PLUGIN_DIR, TOKEN_PLUGIN_DIR]) {
      expect(readdirSync(resolve(dir, "skills")).sort()).toEqual([
        "connect",
        "edit-site",
        "handover",
      ]);
      expect(existsSync(resolve(dir, ".claude-plugin/icon.png"))).toBe(true);
    }
    for (const name of ["edit-site", "handover"]) {
      const text = skill(URL_PLUGIN_DIR, name);
      expect(skill(TOKEN_PLUGIN_DIR, name), `skills/${name} differs between the plugins`).toBe(
        text,
      );
      // They also load in claude.ai and Cowork, where the server is a
      // connector: nothing in them may depend on how the connection was made.
      for (const word of ["mcp_url", "admin_url", "mcp_token", "CAELO_", "/plugin", "bunx"]) {
        expect(text.includes(word), `skills/${name} mentions ${word}`).toBe(false);
      }
    }
    // Each connect skill is about its own way in, and names the other plugin.
    expect(skill(URL_PLUGIN_DIR, "connect")).toContain("/api/mcp/power");
    expect(skill(URL_PLUGIN_DIR, "connect")).toContain("caelo-token@caelo-cms");
    expect(skill(URL_PLUGIN_DIR, "connect")).not.toContain("CAELO_MCP_TOKEN");
    expect(skill(TOKEN_PLUGIN_DIR, "connect")).toContain("CAELO_MCP_TOKEN");
    expect(skill(TOKEN_PLUGIN_DIR, "connect")).toContain("caelo@caelo-cms");
  });
});

// SPDX-License-Identifier: MPL-2.0
const PKG = "@caelo-cms/mcp-server@latest";
/** Name, launch line and env of the MCP server for one minted token. */
export function mcpServerSpec(args) {
    const admin = args.scope === "admin";
    return {
        name: admin ? "caelo-admin" : "caelo",
        command: "bunx",
        args: admin ? ["--package", PKG, "caelo-admin-mcp"] : [PKG],
        env: {
            CAELO_ADMIN_URL: args.adminUrl,
            CAELO_MCP_TOKEN: args.token,
            ...(args.iapServiceAccount ? { CAELO_IAP_SERVICE_ACCOUNT: args.iapServiceAccount } : {}),
        },
    };
}
/**
 * One shell word for the copy-paste command. The admin URL is derived from
 * the request's Host, so a value outside the plain URL/email charset is
 * single-quoted instead of trusted to be inert in the operator's shell.
 */
export function shellWord(value) {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
/**
 * `claude mcp add` / `codex mcp add` — both CLIs share the syntax:
 * options first, the server command after `--` (there is no --command
 * flag). Runs in a terminal, not inside the agent.
 */
export function mcpAddCommand(cli, args) {
    const spec = mcpServerSpec(args);
    const lines = [
        `${cli} mcp add ${spec.name}`,
        ...Object.entries(spec.env).map(([k, v]) => `--env ${shellWord(`${k}=${v}`)}`),
        `-- ${[spec.command, ...spec.args].join(" ")}`,
    ];
    return lines.join(" \\\n  ");
}
/** The Claude Code command — the client most operators start with. */
export function claudeMcpAddCommand(args) {
    return mcpAddCommand("claude", args);
}
/**
 * JSON config for clients configured by file. Claude Desktop, Cursor and
 * Gemini CLI read `{ "mcpServers": { … } }`; VS Code reads
 * `{ "servers": { … } }` with an explicit `"type": "stdio"`.
 */
export function mcpConfigJson(format, args) {
    const spec = mcpServerSpec(args);
    const entry = {
        ...(format === "vscode" ? { type: "stdio" } : {}),
        command: spec.command,
        args: spec.args,
        env: spec.env,
    };
    const key = format === "vscode" ? "servers" : "mcpServers";
    return JSON.stringify({ [key]: { [spec.name]: entry } }, null, 2);
}
/**
 * The remote server for `surface` on the site at `siteHost`
 * (`viu.one` → `caelo-viu-one`, `caelo-viu-one-admin`).
 */
export function remoteMcpServer(surface, url, siteHost) {
    const site = siteHost
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const base = `caelo-${site}`;
    return { name: surface === "admin" ? `${base}-admin` : base, url };
}
/**
 * Terminal registration of a remote server. Claude Code: `--transport http`
 * then `/mcp` → Authenticate (code.claude.com/docs/en/mcp). Codex: `--url`
 * then `codex mcp login` (Codex MCP docs). Both sign in through the browser
 * with a loopback redirect, which the broker allows.
 */
export function remoteMcpAddCommand(cli, server) {
    return cli === "claude"
        ? `claude mcp add --transport http ${server.name} ${shellWord(server.url)}`
        : `codex mcp add ${server.name} --url ${shellWord(server.url)}\ncodex mcp login ${server.name}`;
}
/**
 * JSON config for file-configured clients. Cursor reads `url` in
 * `mcpServers`; VS Code `"type": "http"` + `url` in `servers`; Gemini CLI
 * `httpUrl` (its `url` key means SSE). Each discovers the sign-in from the
 * server's 401 and runs the OAuth flow itself.
 */
export function remoteMcpConfigJson(format, server) {
    const entry = format === "vscode"
        ? { type: "http", url: server.url }
        : format === "gemini"
            ? { httpUrl: server.url }
            : { url: server.url };
    const key = format === "vscode" ? "servers" : "mcpServers";
    return JSON.stringify({ [key]: { [server.name]: entry } }, null, 2);
}

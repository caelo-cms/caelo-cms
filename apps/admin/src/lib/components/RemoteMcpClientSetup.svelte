<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Issue #806 — per-client setup for remote MCP (Settings → MCP → Remote,
   * last step). Every client gets only a URL: it discovers the sign-in from
   * the server and opens Google in the browser. No token, no Bun, no gcloud.
   * Snippets come from lib/mcp-command.ts so they match the local-server
   * setup's names.
   */

  import CopyLine from "#lib/components/updates/CopyLine.svelte";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import { Tabs, TabsContent, TabsList, TabsTrigger } from "#lib/components/ui/tabs/index.js";
  import { MCP_SURFACE_COPY, mcpConnectorName } from "@caelo-cms/shared";
  import { remoteMcpAddCommand, remoteMcpConfigJson, remoteMcpServer } from "#lib/mcp-command.js";

  let {
    urls,
    siteHost,
    mayUse,
  }: {
    urls: { chat: string; admin: string };
    /** For the suggested connector name ("Caelo viu.one (Chat)", #968). */
    siteHost: string;
    /** The surfaces this user's role allows; only those are offered. */
    mayUse: { chat: boolean; admin: boolean };
  } = $props();

  let surface = $state<"chat" | "admin">(mayUse.chat ? "chat" : "admin");
  let client = $state("claude-ai");
  const server = $derived(remoteMcpServer(surface, urls[surface], siteHost));
  const connectorName = $derived(mcpConnectorName(siteHost, surface));
</script>

<div class="space-y-4" data-testid="remote-mcp-client-setup">
  <div class="grid gap-2 md:max-w-md">
    <Label for="remote-surface">What should the AI tool get?</Label>
    <Select id="remote-surface" bind:value={surface}>
      {#if mayUse.chat}<option value="chat">{MCP_SURFACE_COPY.chat.title}</option>{/if}
      {#if mayUse.admin}<option value="admin">{MCP_SURFACE_COPY.admin.title}</option>{/if}
    </Select>
    <p class="text-xs text-muted-foreground">{MCP_SURFACE_COPY[surface].does}</p>
  </div>
  <CopyLine value={server.url} label="MCP URL" testid="remote-mcp-url" />
  <CopyLine value={connectorName} label="Connector name" testid="remote-mcp-connector-name" />
  <p class="text-xs text-muted-foreground">
    Use this name for the connector, so a chat and an admin connector to this site stay apart in
    the same AI tool.
  </p>
  <p class="text-sm text-muted-foreground">
    Each person signs in with their own Google account. Only accounts that are users of this
    site get in; what they may do follows their role here. Remove someone under Settings → Users
    and their connection stops working within the hour.
  </p>

  <Tabs bind:value={client}>
    <TabsList class="flex h-auto flex-wrap">
      <TabsTrigger value="claude-ai">claude.ai / Claude Desktop</TabsTrigger>
      <TabsTrigger value="chatgpt">ChatGPT</TabsTrigger>
      <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
      <TabsTrigger value="codex">Codex CLI</TabsTrigger>
      <TabsTrigger value="cursor">Cursor</TabsTrigger>
      <TabsTrigger value="vscode">VS Code</TabsTrigger>
      <TabsTrigger value="gemini">Gemini CLI</TabsTrigger>
    </TabsList>

    <TabsContent value="claude-ai" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>In claude.ai or Claude Desktop open <strong>Settings → Connectors</strong>.</li>
        <li>
          Click <strong>Add custom connector</strong>, name it <strong>{connectorName}</strong> and
          paste the MCP URL above.
        </li>
        <li>Click <strong>Connect</strong> and sign in with your Google account.</li>
      </ol>
    </TabsContent>

    <TabsContent value="chatgpt" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>
          In ChatGPT open <strong>Settings → Apps &amp; Connectors</strong>. If there is no option
          to add your own, turn on <strong>Developer mode</strong> under Advanced settings (your
          workspace admin may have to allow it).
        </li>
        <li>
          Create a connector named <strong>{connectorName}</strong> with the MCP URL above and OAuth
          authentication.
        </li>
        <li>Connect and sign in with your Google account.</li>
      </ol>
    </TabsContent>

    <TabsContent value="claude-code" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>Run this in a terminal, in the folder you work in.</li>
      </ol>
      <CopyLine
        value={remoteMcpAddCommand("claude", server)}
        label="Command"
        testid="remote-mcp-setup-claude-code"
      />
      <ol start="2" class="ml-5 list-decimal space-y-1 text-sm">
        <li>Start Claude Code, run <code>/mcp</code>, pick <code>{server.name}</code> and choose Authenticate.</li>
      </ol>
    </TabsContent>

    <TabsContent value="codex" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>Run these in a terminal; the second opens the Google sign-in.</li>
      </ol>
      <CopyLine
        value={remoteMcpAddCommand("codex", server)}
        label="Commands"
        testid="remote-mcp-setup-codex"
      />
    </TabsContent>

    <TabsContent value="cursor" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>
          Add this to <code>~/.cursor/mcp.json</code>. If the file already has an
          <code>mcpServers</code> block, add only the inner entry.
        </li>
      </ol>
      <CopyLine
        value={remoteMcpConfigJson("cursor", server)}
        label="Config"
        testid="remote-mcp-setup-cursor"
      />
      <ol start="2" class="ml-5 list-decimal space-y-1 text-sm">
        <li>Open Cursor's MCP settings and click Connect next to <code>{server.name}</code>.</li>
      </ol>
    </TabsContent>

    <TabsContent value="vscode" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>
          Run <strong>MCP: Open User Configuration</strong> from the Command Palette and add this;
          if the file already has a <code>servers</code> block, add only the inner entry.
        </li>
      </ol>
      <CopyLine
        value={remoteMcpConfigJson("vscode", server)}
        label="Config"
        testid="remote-mcp-setup-vscode"
      />
      <ol start="2" class="ml-5 list-decimal space-y-1 text-sm">
        <li>Start the server from the Copilot chat's tool list and sign in when asked.</li>
      </ol>
    </TabsContent>

    <TabsContent value="gemini" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>
          Add this to <code>~/.gemini/settings.json</code> (or the inner entry to an existing
          <code>mcpServers</code> block).
        </li>
      </ol>
      <CopyLine
        value={remoteMcpConfigJson("gemini", server)}
        label="Config"
        testid="remote-mcp-setup-gemini"
      />
      <ol start="2" class="ml-5 list-decimal space-y-1 text-sm">
        <li>In Gemini CLI run <code>/mcp auth {server.name}</code> to sign in.</li>
      </ol>
    </TabsContent>
  </Tabs>
</div>

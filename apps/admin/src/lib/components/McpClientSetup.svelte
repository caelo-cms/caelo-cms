<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Per-client setup for a freshly minted MCP token (/settings/mcp).
   *
   * Every client runs the same local stdio server; the tabs differ only in
   * how it is registered (a terminal command or a JSON config file) and in
   * how the client picks it up (restart, new session). Browser-only
   * assistants (ChatGPT, claude.ai) need a hosted connector and cannot use
   * a local server at all; the hint at the bottom sends them to remote MCP
   * (Settings → MCP → Remote, #806).
   */

  import CopyLine from "#lib/components/updates/CopyLine.svelte";
  import { Tabs, TabsContent, TabsList, TabsTrigger } from "#lib/components/ui/tabs/index.js";
  import { type McpCommandArgs, mcpAddCommand, mcpConfigJson } from "#lib/mcp-command.js";

  let { args }: { args: McpCommandArgs } = $props();

  const claudeCmd = $derived(mcpAddCommand("claude", args));
  const codexCmd = $derived(mcpAddCommand("codex", args));
  const mcpServersJson = $derived(mcpConfigJson("mcpServers", args));
  const vscodeJson = $derived(mcpConfigJson("vscode", args));

  let client = $state("claude-code");
</script>

<div class="space-y-3" data-testid="mcp-client-setup">
  <p class="font-medium">Connect your AI tool</p>
  <div class="text-sm text-muted-foreground">
    <p>Once per computer, before any of the steps below:</p>
    <ul class="ml-5 list-disc">
      <li>Install <a class="underline" href="https://bun.sh" target="_blank" rel="noreferrer">Bun</a> — it runs the Caelo MCP server.</li>
      {#if args.iapServiceAccount}
        <li>
          Install the <a
            class="underline"
            href="https://cloud.google.com/sdk/docs/install"
            target="_blank"
            rel="noreferrer">Google Cloud CLI</a
          > and run <code>gcloud auth application-default login</code> with the Google account you
          use for this admin. The admin is protected by Google IAP; the MCP server gets through it with
          that login.
        </li>
      {/if}
    </ul>
  </div>

  <Tabs bind:value={client}>
    <TabsList class="flex h-auto flex-wrap">
      <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
      <TabsTrigger value="claude-desktop">Claude Desktop</TabsTrigger>
      <TabsTrigger value="codex">Codex CLI</TabsTrigger>
      <TabsTrigger value="cursor">Cursor</TabsTrigger>
      <TabsTrigger value="vscode">VS Code</TabsTrigger>
      <TabsTrigger value="gemini">Gemini CLI</TabsTrigger>
    </TabsList>

    <TabsContent value="claude-code" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>
          Open a terminal in the folder you work in and run this command (in the terminal, not
          inside Claude Code). It registers Caelo for that folder; add <code>--scope user</code>
          after <code>add</code> to use it in every folder.
        </li>
      </ol>
      <CopyLine value={claudeCmd} label="Command" testid="mcp-setup-claude-code" />
      <ol start="2" class="ml-5 list-decimal space-y-1 text-sm">
        <li>Restart Claude Code in that folder. <code>/mcp</code> shows Caelo as connected.</li>
      </ol>
    </TabsContent>

    <TabsContent value="claude-desktop" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>In Claude Desktop open <strong>Settings → Developer → Edit Config</strong>.</li>
        <li>
          Add this to <code>claude_desktop_config.json</code>. If the file already has an
          <code>mcpServers</code> block, add only the inner entry to it.
        </li>
      </ol>
      <CopyLine value={mcpServersJson} label="Config" testid="mcp-setup-claude-desktop" />
      <ol start="3" class="ml-5 list-decimal space-y-1 text-sm">
        <li>
          Replace <code>"bunx"</code> with its full path: run <code>which bunx</code> in a terminal
          (Windows: <code>where bunx</code>). Desktop apps don't see your terminal's PATH, so the
          short name is not found.
        </li>
        <li>Quit Claude Desktop completely (not just the window) and start it again.</li>
      </ol>
    </TabsContent>

    <TabsContent value="codex" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>Run this in a terminal. It registers Caelo for all your Codex sessions.</li>
      </ol>
      <CopyLine value={codexCmd} label="Command" testid="mcp-setup-codex" />
      <ol start="2" class="ml-5 list-decimal space-y-1 text-sm">
        <li>Start a new Codex session.</li>
      </ol>
    </TabsContent>

    <TabsContent value="cursor" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>
          Add this to <code>~/.cursor/mcp.json</code> (all projects) or <code>.cursor/mcp.json</code>
          in one project. If the file already has an <code>mcpServers</code> block, add only the inner
          entry to it.
        </li>
      </ol>
      <CopyLine value={mcpServersJson} label="Config" testid="mcp-setup-cursor" />
      <ol start="2" class="ml-5 list-decimal space-y-1 text-sm">
        <li>
          If Cursor reports that <code>bunx</code> is not found, replace it with the full path from
          <code>which bunx</code>. Then restart Cursor.
        </li>
      </ol>
    </TabsContent>

    <TabsContent value="vscode" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>
          Open the Command Palette and run <strong>MCP: Open User Configuration</strong>. Add this to
          the file; if it already has a <code>servers</code> block, add only the inner entry.
        </li>
      </ol>
      <CopyLine value={vscodeJson} label="Config" testid="mcp-setup-vscode" />
      <ol start="2" class="ml-5 list-decimal space-y-1 text-sm">
        <li>
          If VS Code reports that <code>bunx</code> is not found, replace it with the full path from
          <code>which bunx</code>. Start the server from the Copilot chat's tool list.
        </li>
      </ol>
    </TabsContent>

    <TabsContent value="gemini" class="space-y-2">
      <ol class="ml-5 list-decimal space-y-1 text-sm">
        <li>
          Add this to <code>~/.gemini/settings.json</code>. If the file already has an
          <code>mcpServers</code> block, add only the inner entry to it.
        </li>
      </ol>
      <CopyLine value={mcpServersJson} label="Config" testid="mcp-setup-gemini" />
      <ol start="2" class="ml-5 list-decimal space-y-1 text-sm">
        <li>Start a new Gemini CLI session. <code>/mcp</code> lists Caelo.</li>
      </ol>
    </TabsContent>
  </Tabs>

  <p class="text-sm text-muted-foreground" data-testid="mcp-setup-remote-hint">
    ChatGPT and claude.ai in the browser can't use this server: it runs on your computer, and they
    only reach servers on the internet. Connect them with
    <a class="underline" href="/settings/mcp/remote">remote MCP</a> instead — no token, each person
    signs in with Google.
  </p>
</div>

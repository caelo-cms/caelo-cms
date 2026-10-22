<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  //
  // Issue #968 — the top card of Settings → MCP: where connecting AI tools
  // by URL (remote MCP) stands, and when it is on, the addresses this user
  // may use, each with what it does, who may use it and a connector name
  // that keeps two connectors to one site apart. What to show is decided by
  // remoteAccessView (lib/mcp-remote-access.ts, unit-tested); this renders
  // it. The concept is docs/dev/mcp-access.md.
  import { MCP_SURFACE_PERMISSION, type McpSurfaceName } from "@caelo-cms/shared";
  import CopyLine from "#lib/components/updates/CopyLine.svelte";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { buttonVariants } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { type RemoteMcpState, remoteAccessView } from "#lib/mcp-remote-access.js";

  let {
    remote,
    mayUse,
    canWrite,
  }: {
    remote: RemoteMcpState;
    /** The surfaces this user's role allows; only their URLs are shown. */
    mayUse: Record<McpSurfaceName, boolean>;
    /** settings.write — may set remote MCP up. */
    canWrite: boolean;
  } = $props();

  const view = $derived(remoteAccessView(remote, mayUse, canWrite));
</script>

<Card data-testid="mcp-remote-access" data-state={remote.status}>
  <CardHeader>
    <CardTitle class="flex items-center gap-2 text-base">
      Connect AI tools by URL
      {#if remote.status === "on"}
        <Badge variant="success" data-testid="mcp-remote-access-status">Remote MCP is on</Badge>
      {:else if remote.status === "off"}
        <Badge variant="secondary" data-testid="mcp-remote-access-status">Off</Badge>
      {/if}
    </CardTitle>
    <CardDescription>
      ChatGPT, claude.ai, Claude Code, Cursor and other AI tools connect with a URL. Each person
      signs in with their own Google account; what the tool may do follows their role on this site.
      Nothing to install, no token to copy.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if remote.status === "not-available"}
      <p class="text-sm" data-testid="mcp-remote-access-unavailable">{remote.reason}</p>
    {:else if remote.status === "needs-upgrade"}
      <Alert variant="destructive">
        <AlertDescription>
          <p class="font-medium">This install is not prepared for remote MCP yet.</p>
          <p>{remote.nextStep}</p>
          <p class="text-xs">Missing: {remote.missing.join(", ")}</p>
        </AlertDescription>
      </Alert>
    {:else if remote.status === "off"}
      <p class="text-sm">
        Remote MCP turns on as soon as this site's Google sign-in is set up, once per site.
      </p>
      {#if view.setupHref}
        <a
          href={view.setupHref}
          class={buttonVariants({ variant: "default" })}
          data-testid="mcp-remote-access-setup"
        >
          Set up remote MCP
        </a>
      {:else}
        <p class="text-sm text-muted-foreground">Ask an Owner to set it up.</p>
      {/if}
    {:else}
      {#if view.surfaces.length === 0}
        <p class="text-sm" data-testid="mcp-remote-access-none">
          Your role may not use either address. Chatting with the site's AI needs
          {MCP_SURFACE_PERMISSION.chat}; ask an Owner under Settings → Users.
        </p>
      {/if}
      {#each view.surfaces as s (s.surface)}
        <section
          class="space-y-2 rounded-md border p-4"
          data-testid={`mcp-remote-surface-${s.surface}`}
        >
          <h3 class="font-medium">{s.title}</h3>
          <p class="text-sm text-muted-foreground">{s.does}</p>
          <p class="text-xs text-muted-foreground">Who may use it: {s.who}</p>
          <CopyLine value={s.url} label="MCP URL" testid={`mcp-remote-url-${s.surface}`} />
          <CopyLine
            value={s.connectorName}
            label="Connector name"
            testid={`mcp-remote-name-${s.surface}`}
          />
        </section>
      {/each}
      {#if view.adminHint}
        <p class="text-xs text-muted-foreground" data-testid="mcp-remote-admin-hint">
          {view.adminHint}
        </p>
      {/if}
      {#if view.surfaces.length > 0}
        <a href="/settings/mcp/remote" class="text-sm underline">
          Step-by-step setup for ChatGPT, Claude, Cursor and others
        </a>
      {/if}
    {/if}
  </CardContent>
</Card>

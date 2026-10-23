<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Issue #806 — Settings → MCP → Remote: connect ChatGPT, claude.ai and
   * other HTTP MCP clients. Everyone signs in with the install's Google
   * sign-in client (#914, Settings → Google sign-in); this page checks the
   * MCP side and hands out the URLs.
   */

  import { enhance } from "$app/forms";
  import { CircleCheck, CircleX } from "lucide-svelte";
  import RemoteMcpClientSetup from "#lib/components/RemoteMcpClientSetup.svelte";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button, buttonVariants } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";

  let { data, form } = $props();
  let busy = $state(false);

  const checks = $derived(form && "checks" in form ? form.checks : null);
</script>

<div class="space-y-6">
  <div>
    <a href="/settings/mcp" class="text-sm text-muted-foreground underline">← MCP</a>
    <h1 class="text-2xl font-semibold tracking-tight">Connect ChatGPT, claude.ai and other AI tools</h1>
    <p class="text-sm text-muted-foreground">
      Remote MCP lets AI tools reach this site over the internet. Everyone signs in with their own
      Google account, and only users of this site get in. Nothing needs to be installed on their
      computers.
    </p>
  </div>

  {#if data.availability.status === "not-available"}
    <Alert data-testid="remote-mcp-unavailable">
      <AlertDescription>
        <p class="font-medium">Not available on this install.</p>
        <p>{data.availability.reason}</p>
      </AlertDescription>
    </Alert>
  {:else if data.availability.status === "needs-upgrade"}
    <Alert variant="destructive" data-testid="remote-mcp-needs-upgrade">
      <AlertDescription>
        <p class="font-medium">This install is not prepared for remote MCP yet.</p>
        <p>{data.availability.nextStep}</p>
        <p class="text-xs">Missing: {data.availability.missing.join(", ")}</p>
      </AlertDescription>
    </Alert>
  {:else}
    {@const a = data.availability}
    {#if form?.error}
      <Alert variant="destructive" data-testid="remote-mcp-error">
        <AlertDescription><p>{form.error}</p></AlertDescription>
      </Alert>
    {/if}

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base">
          Status
          {#if data.client}
            <Badge variant="success" data-testid="remote-mcp-status">On</Badge>
          {:else}
            <Badge variant="secondary" data-testid="remote-mcp-status">Off</Badge>
          {/if}
        </CardTitle>
        <CardDescription data-testid="remote-mcp-sign-in">
          Remote MCP uses this install's Google sign-in.
          {#if data.client}
            People sign in with client <code>{data.client.clientId}</code>.
          {:else}
            Set up Google sign-in first; remote MCP is on as soon as it is.
          {/if}
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-wrap gap-2">
        <a
          href={a.signInSettingsPath}
          class={buttonVariants({ variant: data.client ? "outline" : "default" })}
          data-testid="remote-mcp-sign-in-link"
        >
          {data.client ? "Google sign-in settings" : "Set up Google sign-in"}
        </a>
        {#if data.client}
          <form
            method="post"
            action="?/check"
            use:enhance={() => {
              busy = true;
              return async ({ update }) => {
                await update();
                busy = false;
              };
            }}
          >
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <Button type="submit" variant="outline" disabled={busy}>
              {busy ? "Checking…" : "Check remote MCP"}
            </Button>
          </form>
        {/if}
      </CardContent>
    </Card>

    {#if checks}
      <Card data-testid="remote-mcp-checks">
        <CardHeader>
          <CardTitle class="text-base">Checks</CardTitle>
        </CardHeader>
        <CardContent>
          <ul class="space-y-2 text-sm">
            {#each checks as line (line.id)}
              <li class="flex items-start gap-2" data-testid={`remote-mcp-check-${line.id}`}>
                {#if line.ok}
                  <CircleCheck class="mt-0.5 size-4 text-green-600" aria-label="ok" />
                {:else}
                  <CircleX class="mt-0.5 size-4 text-destructive" aria-label="failed" />
                {/if}
                <div>
                  <p class="font-medium">{line.label}</p>
                  <p class="text-xs text-muted-foreground break-all">{line.detail}</p>
                  {#if !line.ok && line.nextStep}<p class="text-xs">{line.nextStep}</p>{/if}
                </div>
              </li>
            {/each}
          </ul>
        </CardContent>
      </Card>
    {/if}

    <Card>
      <CardHeader>
        <CardTitle class="text-base">Connect your AI tools</CardTitle>
        <CardDescription>
          {#if data.client}
            Share the URL with the people who should use it.
          {:else}
            Works once Google sign-in is set up.
          {/if}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {#if data.siteHost && (data.mayUse.chat || data.mayUse.admin)}
          <RemoteMcpClientSetup urls={a.urls} siteHost={data.siteHost} mayUse={data.mayUse} />
        {:else}
          <p class="text-sm" data-testid="remote-mcp-no-surface">
            Your role may not use remote MCP. Chatting with the site's AI needs content.write; ask an
            Owner under Settings → Users.
          </p>
        {/if}
      </CardContent>
    </Card>
  {/if}
</div>

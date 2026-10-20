<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Issue #806 — Settings → MCP → Remote: connect ChatGPT, claude.ai and
   * other HTTP MCP clients. Four steps: create a Google OAuth client (the
   * one thing Google only allows in its console), paste it here, Caelo
   * stores it and checks every link, then hand out the URL.
   */

  import { enhance } from "$app/forms";
  import { CircleCheck, CircleX, ExternalLink } from "lucide-svelte";
  import RemoteMcpClientSetup from "#lib/components/RemoteMcpClientSetup.svelte";
  import CopyLine from "#lib/components/updates/CopyLine.svelte";
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
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";

  let { data, form } = $props();
  let busy = $state<string | null>(null);

  const fieldErrors = $derived(
    (form && "fieldErrors" in form ? form.fieldErrors : undefined) as
      | Record<string, string>
      | undefined,
  );
  const checks = $derived(form && "checks" in form ? form.checks : null);

  function submitting(action: string) {
    return () => {
      busy = action;
      return async ({ update }: { update: () => Promise<void> }) => {
        await update();
        busy = null;
      };
    };
  }
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
        <AlertDescription>
          <p>{form.error}</p>
          {#if "nextStep" in form && form.nextStep}<p>{form.nextStep}</p>{/if}
        </AlertDescription>
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
        <CardDescription>
          {#if data.client}
            Signing in with Google OAuth client <code>{data.client.clientId}</code> since
            {data.client.configuredAt.slice(0, 10)}.
          {:else}
            Not set up. Follow the steps below; it takes about five minutes.
          {/if}
        </CardDescription>
      </CardHeader>
      {#if data.client}
        <CardContent class="flex flex-wrap gap-2">
          <form method="post" action="?/check" use:enhance={submitting("check")}>
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <Button type="submit" variant="outline" disabled={busy !== null}>
              {busy === "check" ? "Checking…" : "Run the checks again"}
            </Button>
          </form>
          <form method="post" action="?/disable" use:enhance={submitting("disable")}>
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <Button type="submit" variant="destructive" disabled={busy !== null}>
              {busy === "disable" ? "Turning off…" : "Turn remote MCP off"}
            </Button>
          </form>
        </CardContent>
      {/if}
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
        <CardTitle class="text-base">1. Create a Google sign-in client</CardTitle>
        <CardDescription>
          Google only lets you do this in its console. Open it, then fill in exactly this:
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3 text-sm">
        <a
          href={a.createClientUrl}
          target="_blank"
          rel="noreferrer"
          class={buttonVariants({ variant: "default" })}
          data-testid="remote-mcp-console-link"
        >
          Open the Google console <ExternalLink class="size-4" />
        </a>
        <ul class="ml-5 list-disc space-y-1">
          <li>
            If Google first asks you to set up the app ("Get started"): any app name, your email.
            For <strong>Audience</strong> pick <strong>Internal</strong> when your Google account
            belongs to a company Google Workspace — then only your organisation's accounts can
            sign in. Otherwise pick External and, under Audience, click
            <strong>Publish app</strong>: in "Testing" Google ends every sign-in after 7 days.
          </li>
          <li><strong>Application type</strong>: Web application</li>
          <li><strong>Name</strong>: Caelo MCP</li>
          <li>
            Leave <strong>Use this client for an AI-powered agent</strong> unchecked: that marks
            clients for Google's own MCP servers; Caelo signs people in with an ordinary web
            client.
          </li>
          <li><strong>Authorized redirect URIs</strong> → Add URI, and paste exactly:</li>
        </ul>
        <CopyLine value={a.redirectUri} label="Redirect URI" testid="remote-mcp-redirect-uri" />
        <p>
          Click <strong>Create</strong>. Google shows the client ID and secret once — keep that
          window open for step 2.
        </p>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">2. Paste the client here</CardTitle>
        <CardDescription>
          Caelo stores the secret where only its sign-in service can read it, allows the client in
          Google IAP, and checks that everything answers. This can take up to a minute.
          {#if data.client}Saving a new client replaces the current one.{/if}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          method="post"
          action="?/save"
          class="grid gap-4 md:max-w-xl"
          use:enhance={submitting("save")}
          data-testid="remote-mcp-form"
        >
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <div class="space-y-2">
            <Label for="clientId">Client ID</Label>
            <Input
              id="clientId"
              name="clientId"
              type="text"
              autocomplete="off"
              placeholder="123456789012-abc….apps.googleusercontent.com"
              value={form && "clientId" in form ? (form.clientId ?? "") : ""}
              aria-invalid={fieldErrors?.clientId ? "true" : undefined}
              required
            />
            {#if fieldErrors?.clientId}
              <p class="text-xs text-destructive" data-testid="remote-mcp-error-clientId">
                {fieldErrors.clientId}
              </p>
            {/if}
          </div>
          <div class="space-y-2">
            <Label for="clientSecret">Client secret</Label>
            <Input
              id="clientSecret"
              name="clientSecret"
              type="password"
              autocomplete="off"
              placeholder="GOCSPX-…"
              aria-invalid={fieldErrors?.clientSecret ? "true" : undefined}
              required
            />
            {#if fieldErrors?.clientSecret}
              <p class="text-xs text-destructive" data-testid="remote-mcp-error-clientSecret">
                {fieldErrors.clientSecret}
              </p>
            {/if}
          </div>
          <div>
            <Button type="submit" disabled={busy !== null}>
              {busy === "save" ? "Saving and checking…" : "Save and check"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">3. Connect your AI tools</CardTitle>
        <CardDescription>
          {#if data.client}
            Share the URL with the people who should use it.
          {:else}
            Works once steps 1 and 2 are done and the checks are green.
          {/if}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RemoteMcpClientSetup urls={a.urls} />
      </CardContent>
    </Card>
  {/if}
</div>

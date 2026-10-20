<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Issue #914 — Settings → Google sign-in: the install's one Google OAuth
   * client. Google IAP signs people in with it (so Gmail and other
   * companies' accounts that are users here get in), and remote MCP uses
   * the same client. Steps: create the client in Google's console (the one
   * thing Google only allows there), paste it here, Caelo stores it, hands
   * it to IAP and checks every link.
   */

  import { GOOGLE_OAUTH_CLIENT_ID, iapRedirectUri } from "@caelo-cms/shared";
  import { enhance } from "$app/forms";
  import { CircleCheck, CircleX, ExternalLink } from "lucide-svelte";
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
  let confirmingRemove = $state(false);
  let typedClientId = $state("");

  const fieldErrors = $derived(
    (form && "fieldErrors" in form ? form.fieldErrors : undefined) as
      | Record<string, string>
      | undefined,
  );
  const checks = $derived(form && "checks" in form ? form.checks : null);
  /** The client whose IAP redirect URI step 1 shows: the one being typed, else the configured one. */
  const redirectClientId = $derived(
    GOOGLE_OAUTH_CLIENT_ID.test(typedClientId.trim())
      ? typedClientId.trim()
      : (data.client?.clientId ?? null),
  );
  const organisation = $derived(
    data.availability.status === "available" ? data.availability.organisationDomains : "unknown",
  );

  function submitting(action: string) {
    return () => {
      busy = action;
      return async ({ update }: { update: () => Promise<void> }) => {
        await update();
        busy = null;
        confirmingRemove = false;
      };
    };
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Google sign-in</h1>
    <p class="text-sm text-muted-foreground">
      Everyone who opens this admin signs in with Google first. Without a sign-in client of your
      own, Google only lets in accounts of your company's Google organisation. Set one up and every
      Google account that is a user here can sign in — Gmail addresses and other companies'
      accounts too. Remote MCP (ChatGPT, claude.ai) uses the same client.
    </p>
  </div>

  {#if data.availability.status === "not-available"}
    <Alert data-testid="google-sign-in-unavailable">
      <AlertDescription>
        <p class="font-medium">Not needed on this install.</p>
        <p>{data.availability.reason}</p>
      </AlertDescription>
    </Alert>
  {:else if data.availability.status === "needs-upgrade"}
    <Alert variant="destructive" data-testid="google-sign-in-needs-upgrade">
      <AlertDescription>
        <p class="font-medium">This install is not prepared for Google sign-in yet.</p>
        <p>{data.availability.nextStep}</p>
        <p class="text-xs">Missing: {data.availability.missing.join(", ")}</p>
      </AlertDescription>
    </Alert>
  {:else}
    {@const a = data.availability}
    {#if form?.error}
      <Alert variant="destructive" data-testid="google-sign-in-error">
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
            <Badge variant="success" data-testid="google-sign-in-status">On</Badge>
          {:else}
            <Badge variant="secondary" data-testid="google-sign-in-status">Off</Badge>
          {/if}
        </CardTitle>
        <CardDescription>
          {#if data.client}
            Signing in with Google OAuth client <code>{data.client.clientId}</code> since
            {data.client.configuredAt.slice(0, 10)}.
          {:else if organisation === "unknown"}
            Not set up, and Caelo could not read which Google organisation this project belongs to —
            so it adds no new users until this is set up.
          {:else if organisation === "none"}
            Not set up. This project belongs to no Google organisation, so nobody can sign in
            through Google's built-in client — set this up before adding users.
          {:else}
            Not set up. Only accounts of {organisation.join(", ")} can sign in.
          {/if}
        </CardDescription>
      </CardHeader>
      {#if !data.client && data.outsideOrganisation.length > 0}
        <CardContent>
          <Alert variant="destructive" data-testid="google-sign-in-blocked-users">
            <AlertDescription>
              <p class="font-medium">These users cannot sign in until this is set up:</p>
              <ul class="ml-5 list-disc">
                {#each data.outsideOrganisation as email (email)}<li>{email}</li>{/each}
              </ul>
            </AlertDescription>
          </Alert>
        </CardContent>
      {/if}
      {#if data.client}
        <CardContent class="space-y-3">
          <div class="flex flex-wrap gap-2">
            <form method="post" action="?/check" use:enhance={submitting("check")}>
              <input type="hidden" name="_csrf" value={data.csrfToken} />
              <Button type="submit" variant="outline" disabled={busy !== null}>
                {busy === "check" ? "Checking…" : "Run the checks again"}
              </Button>
            </form>
            {#if !confirmingRemove}
              <Button
                type="button"
                variant="destructive"
                disabled={busy !== null}
                onclick={() => (confirmingRemove = true)}
                data-testid="google-sign-in-remove-start"
              >
                Remove Google sign-in
              </Button>
            {/if}
          </div>
          {#if confirmingRemove}
            <Alert variant="destructive" data-testid="google-sign-in-remove-warning">
              <AlertDescription class="space-y-2">
                <p class="font-medium">
                  Google IAP goes back to its built-in sign-in, and remote MCP stops.
                </p>
                {#if data.outsideOrganisation.length > 0}
                  <p>These users can no longer sign in to the admin:</p>
                  <ul class="ml-5 list-disc">
                    {#each data.outsideOrganisation as email (email)}<li>{email}</li>{/each}
                  </ul>
                {:else}
                  <p>Every current user belongs to your organisation and keeps access.</p>
                {/if}
                <form
                  method="post"
                  action="?/remove"
                  class="flex flex-wrap gap-2"
                  use:enhance={submitting("remove")}
                >
                  <input type="hidden" name="_csrf" value={data.csrfToken} />
                  <input type="hidden" name="confirm" value="remove" />
                  <Button type="submit" variant="destructive" disabled={busy !== null}>
                    {busy === "remove" ? "Removing…" : "Remove anyway"}
                  </Button>
                  <Button type="button" variant="outline" onclick={() => (confirmingRemove = false)}>
                    Keep it
                  </Button>
                </form>
              </AlertDescription>
            </Alert>
          {/if}
        </CardContent>
      {/if}
    </Card>

    {#if checks}
      <Card data-testid="google-sign-in-checks">
        <CardHeader>
          <CardTitle class="text-base">Checks</CardTitle>
        </CardHeader>
        <CardContent>
          <ul class="space-y-2 text-sm">
            {#each checks as line (line.id)}
              <li class="flex items-start gap-2" data-testid={`google-sign-in-check-${line.id}`}>
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
        <CardTitle class="text-base">1. Let any Google account sign in</CardTitle>
        <CardDescription>
          Google decides on its consent screen which accounts may sign in to your apps.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3 text-sm">
        <a
          href={a.audienceUrl}
          target="_blank"
          rel="noreferrer"
          class={buttonVariants({ variant: "outline" })}
          data-testid="google-sign-in-audience-link"
        >
          Open the consent screen settings <ExternalLink class="size-4" />
        </a>
        <ul class="ml-5 list-disc space-y-1">
          <li>
            If Google first asks you to set up the app ("Get started"): any app name, your email.
          </li>
          <li><strong>User type</strong>: External</li>
          <li>
            <strong>Publishing status</strong>: In production — click <strong>Publish app</strong>.
            Caelo only asks for name and email, so Google does not need to review the app. In
            "Testing" only listed test users can sign in, and Google ends every sign-in after 7
            days.
          </li>
        </ul>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">2. Create the sign-in client</CardTitle>
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
          data-testid="google-sign-in-console-link"
        >
          Open the Google console <ExternalLink class="size-4" />
        </a>
        <ul class="ml-5 list-disc space-y-1">
          <li><strong>Application type</strong>: Web application</li>
          <li><strong>Name</strong>: Caelo sign-in</li>
          <li>
            Leave <strong>Use this client for an AI-powered agent</strong> unchecked: that marks
            clients for Google's own MCP servers; Caelo signs people in with an ordinary web
            client.
          </li>
          <li><strong>Authorized redirect URIs</strong> → Add URI, and paste exactly:</li>
        </ul>
        <CopyLine
          value={a.brokerRedirectUri}
          label="Redirect URI 1 (remote MCP)"
          testid="google-sign-in-broker-redirect-uri"
        />
        <p>
          Click <strong>Create</strong>. Google shows the client ID and secret once — keep that
          window open. Paste the client ID below; the second redirect URI appears here, and you add
          it to the same client (open it from the
          <a href={a.clientsUrl} target="_blank" rel="noreferrer" class="underline">client list</a>,
          Add URI, Save).
        </p>
        {#if redirectClientId}
          <CopyLine
            value={iapRedirectUri(redirectClientId)}
            label="Redirect URI 2 (Google IAP)"
            testid="google-sign-in-iap-redirect-uri"
          />
        {:else}
          <p class="text-muted-foreground" data-testid="google-sign-in-iap-redirect-pending">
            Redirect URI 2 appears once you paste the client ID in step 3.
          </p>
        {/if}
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">3. Paste the client here</CardTitle>
        <CardDescription>
          Caelo stores the secret where only Google IAP's sync and the sign-in service can read it,
          hands the client to Google IAP, and checks that signing in uses it. This can take a few
          minutes.
          {#if data.client}Saving a new client replaces the current one.{/if}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          method="post"
          action="?/save"
          class="grid gap-4 md:max-w-xl"
          use:enhance={submitting("save")}
          data-testid="google-sign-in-form"
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
              oninput={(e) => (typedClientId = (e.currentTarget as HTMLInputElement).value)}
              aria-invalid={fieldErrors?.clientId ? "true" : undefined}
              required
            />
            {#if fieldErrors?.clientId}
              <p class="text-xs text-destructive" data-testid="google-sign-in-error-clientId">
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
              <p class="text-xs text-destructive" data-testid="google-sign-in-error-clientSecret">
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
  {/if}
</div>

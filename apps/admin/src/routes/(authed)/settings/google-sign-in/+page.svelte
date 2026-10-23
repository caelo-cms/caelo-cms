<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Issue #914 — Settings → Google sign-in: the install's one Google OAuth
   * client. Google IAP signs people in with it (so Gmail and other
   * companies' accounts that are users here get in), and remote MCP uses
   * the same client.
   *
   * #967 — one pass through Google's console, and no lockout: publish the
   * consent screen, create the client, paste its ID (BOTH redirect URIs
   * appear at once), add them, paste the secret, let Caelo check the client
   * against Google, confirm that everyone signs in once more — only then is
   * the client stored and handed to IAP.
   */

  import { GOOGLE_OAUTH_CLIENT_ID, iapRedirectUri, oauthClientConsoleUrl } from "@caelo-cms/shared";
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
  /** The ID or secret changed after the last "Check the client": its result no longer applies. */
  let editedSinceCheck = $state(false);

  const fieldErrors = $derived(
    (form && "fieldErrors" in form ? form.fieldErrors : undefined) as
      | Record<string, string>
      | undefined,
  );
  const checks = $derived(form && "checks" in form ? form.checks : null);
  /** The client checks belong under step 4; the self-check after a switch, re-check or removal under Status. */
  const clientChecks = $derived(
    form?.action === "preflight" || (form?.action === "save" && form && !("ok" in form)) ? checks : null,
  );
  const selfChecks = $derived(clientChecks ? null : checks);
  const echoedClientId = $derived(form && "clientId" in form ? (form.clientId ?? "") : "");
  /** The client whose redirect URIs step 3 shows: the one being typed, else the configured one. */
  const shownClientId = $derived.by(() => {
    const typed = typedClientId.trim();
    if (GOOGLE_OAUTH_CLIENT_ID.test(typed)) return typed;
    if (!typedClientId && GOOGLE_OAUTH_CLIENT_ID.test(echoedClientId)) return echoedClientId;
    return data.client?.clientId ?? null;
  });
  const preflightPassed = $derived(
    form?.action === "preflight" && form && "passed" in form && form.passed === true && !editedSinceCheck,
  );
  const organisation = $derived(
    data.availability.status === "available" ? data.availability.organisationDomains : "unknown",
  );
  const brokenRedirects = $derived(data.redirectChecks.filter((c) => !c.ok));

  function submitting(action: string) {
    return () => {
      busy = action;
      return async ({ update }: { update: (opts?: { reset?: boolean }) => Promise<void> }) => {
        // The secret stays in its field after a check, so the confirm step can submit it.
        await update({ reset: action !== "preflight" });
        busy = null;
        confirmingRemove = false;
        if (action === "preflight") editedSinceCheck = false;
      };
    };
  }
</script>

<div class="space-y-6">
  <div class="space-y-2">
    <h1 class="text-2xl font-semibold tracking-tight">Google sign-in</h1>
    <p class="text-sm text-muted-foreground">
      Everyone who opens this admin signs in with Google first. Without a sign-in client of your
      own, Google lets in only accounts of your company's Google organisation — which is all most
      sites need.
    </p>
    <p class="text-sm text-muted-foreground" data-testid="google-sign-in-when-needed">
      Set up your own sign-in client only if you need one of these: <strong>remote MCP</strong>
      (connecting ChatGPT or claude.ai to Caelo), or <strong>users whose Google account is
      outside your organisation</strong> (a Gmail address, another company's Google Workspace).
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
          {:else if data.outsideOrganisation.length === 0}
            Not set up, and not needed right now: every user belongs to {organisation.join(", ")}.
            Set it up when you want remote MCP or a user outside your organisation.
          {:else}
            Not set up. Only accounts of {organisation.join(", ")} can sign in.
          {/if}
        </CardDescription>
      </CardHeader>
      {#if data.client && brokenRedirects.length > 0}
        <CardContent>
          <Alert variant="destructive" data-testid="google-sign-in-redirect-broken">
            <AlertDescription class="space-y-2">
              <p class="font-medium">The sign-in client is missing a redirect URI.</p>
              {#each brokenRedirects as line (line.id)}
                <p>{line.detail}</p>
                {#if line.nextStep}<p>{line.nextStep}</p>{/if}
              {/each}
            </AlertDescription>
          </Alert>
        </CardContent>
      {/if}
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
                  Google IAP goes back to its built-in sign-in, and remote MCP stops. Every user
                  signs in to the admin once more.
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

    {#if selfChecks}
      <Card data-testid="google-sign-in-self-checks">
        <CardHeader>
          <CardTitle class="text-base">Checks</CardTitle>
        </CardHeader>
        <CardContent>
          <ul class="space-y-2 text-sm">
            {#each selfChecks as line (line.id)}
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

    <form
      method="post"
      action="?/preflight"
      class="space-y-6"
      use:enhance={({ action }) => submitting(action.search.includes("save") ? "save" : "preflight")()}
      data-testid="google-sign-in-form"
    >
      <input type="hidden" name="_csrf" value={data.csrfToken} />

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
          <ul class="ml-5 list-disc space-y-1" data-testid="google-sign-in-consent-steps">
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
          <label class="flex items-start gap-2" data-testid="google-sign-in-consent-confirm">
            <input
              type="checkbox"
              name="consentConfirmed"
              value="yes"
              onchange={() => (editedSinceCheck = true)}
              class="mt-0.5 h-4 w-4 rounded border-input"
            />
            <span>
              The consent screen is External and In production. (Google offers no way for Caelo to
              check this, so you confirm it here.)
            </span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">2. Create the sign-in client</CardTitle>
          <CardDescription>
            Google only lets you do this in its console. Open it and fill in exactly this:
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
            <li data-testid="google-sign-in-agentic-hint">
              Leave <strong>Use this client for an AI-powered agent</strong> unchecked. That option
              only lets a client call Google Workspace's MCP servers (Gmail, Drive, Calendar and
              the like). Caelo uses this client only to sign people in with their name and email
              address. From 12 November 2026 Google no longer lets you change this choice once a
              client exists.
            </li>
            <li>
              Click <strong>Create</strong>. Google shows the client ID and the secret — keep that
              window open.
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">3. Paste the client ID, then add both redirect URIs</CardTitle>
          <CardDescription>
            Once the client ID is in, Caelo shows the two redirect URIs this client needs. Both
            must be on it: without the second one nobody could sign in to the admin.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3 text-sm">
          <div class="space-y-2 md:max-w-xl">
            <Label for="clientId">Client ID</Label>
            <Input
              id="clientId"
              name="clientId"
              type="text"
              autocomplete="off"
              placeholder="123456789012-abc….apps.googleusercontent.com"
              value={echoedClientId}
              oninput={(e) => {
                typedClientId = (e.currentTarget as HTMLInputElement).value;
                editedSinceCheck = true;
              }}
              aria-invalid={fieldErrors?.clientId ? "true" : undefined}
              required
            />
            {#if fieldErrors?.clientId}
              <p class="text-xs text-destructive" data-testid="google-sign-in-error-clientId">
                {fieldErrors.clientId}
              </p>
            {/if}
          </div>
          {#if shownClientId}
            <div class="space-y-3" data-testid="google-sign-in-redirect-uris">
              <p>
                Open the client in the Google console
                (<a
                  href={oauthClientConsoleUrl(a.projectId, shownClientId)}
                  target="_blank"
                  rel="noreferrer"
                  class="underline"
                  data-testid="google-sign-in-client-console-link">open it</a
                >), under <strong>Authorized redirect URIs</strong> click <strong>Add URI</strong>
                twice, paste these two exactly, and click <strong>Save</strong>:
              </p>
              <div class="space-y-1">
                <p class="text-xs font-medium">Redirect URI 1 (remote MCP)</p>
                <CopyLine
                  value={a.brokerRedirectUri}
                  label="Redirect URI 1 (remote MCP)"
                  testid="google-sign-in-broker-redirect-uri"
                />
              </div>
              <div class="space-y-1">
                <p class="text-xs font-medium">Redirect URI 2 (Google IAP)</p>
                <CopyLine
                  value={iapRedirectUri(shownClientId)}
                  label="Redirect URI 2 (Google IAP)"
                  testid="google-sign-in-iap-redirect-uri"
                />
              </div>
            </div>
          {:else}
            <p class="text-muted-foreground" data-testid="google-sign-in-redirect-uris-pending">
              Both redirect URIs appear here once you paste the client ID.
            </p>
          {/if}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">4. Paste the secret and check the client</CardTitle>
          <CardDescription>
            Caelo asks Google whether both redirect URIs are on the client and whether the secret
            belongs to it. Nothing is stored and nobody's sign-in changes until every check passes
            and you confirm.
            {#if data.client}A new client replaces the current one the same way.{/if}
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-2 md:max-w-xl">
            <Label for="clientSecret">Client secret</Label>
            <Input
              id="clientSecret"
              name="clientSecret"
              type="password"
              autocomplete="off"
              placeholder="GOCSPX-…"
              oninput={() => (editedSinceCheck = true)}
              aria-invalid={fieldErrors?.clientSecret ? "true" : undefined}
              required
            />
            {#if fieldErrors?.clientSecret}
              <p class="text-xs text-destructive" data-testid="google-sign-in-error-clientSecret">
                {fieldErrors.clientSecret}
              </p>
            {/if}
          </div>
          <Button type="submit" variant={preflightPassed ? "outline" : "default"} disabled={busy !== null}>
            {busy === "preflight" ? "Checking with Google…" : "Check the client"}
          </Button>

          {#if clientChecks}
            <ul class="space-y-2 text-sm" data-testid="google-sign-in-checks">
              {#each clientChecks as line (line.id)}
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
          {/if}

          {#if preflightPassed}
            <Alert data-testid="google-sign-in-relogin-confirm">
              <AlertDescription class="space-y-3">
                <p class="font-medium">Every user signs in to the admin once more.</p>
                <p>
                  Google IAP ties every sign-in to its sign-in client, so switching
                  {form && "replacing" in form && form.replacing ? "to the new client" : "to this client"}
                  signs everybody out — you too. Each person signs in with Google again on their next
                  visit. Remote MCP connections (ChatGPT, claude.ai) connect again too.
                </p>
                <!-- Save sends the same ID, secret and confirmation again and re-checks them. -->
                <input type="hidden" name="reLoginConfirmed" value="yes" />
                <Button type="submit" formaction="?/save" disabled={busy !== null} data-testid="google-sign-in-switch">
                  {busy === "save" ? "Switching and checking…" : "Switch sign-in to this client"}
                </Button>
              </AlertDescription>
            </Alert>
          {/if}
        </CardContent>
      </Card>
    </form>
  {/if}
</div>

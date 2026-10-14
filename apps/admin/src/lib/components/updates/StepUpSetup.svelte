<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #696 maintainer decision 4 — updates are confirmed with a fresh Google
   * sign-in, never a password. That needs a Google OAuth client in the
   * install's own project, which only the Owner can create (Google offers no
   * API for it). This card walks a non-technical Owner through it and stores
   * the client (step_up.set_client). Replacing a client needs a step-up.
   */

  import { ExternalLink, ShieldCheck } from "lucide-svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import CopyLine from "./CopyLine.svelte";

  let {
    csrfToken,
    redirectUri,
    credentialsUrl,
  }: { csrfToken: string; redirectUri: string; credentialsUrl: string } = $props();
</script>

<Card data-testid="step-up-setup">
  <CardHeader>
    <CardTitle class="flex items-center gap-2 text-base">
      <ShieldCheck class="size-4" aria-hidden="true" />
      First, set up Google sign-in for updates
    </CardTitle>
    <CardDescription>
      Before Caelo installs an update it asks you to sign in to Google again, right then. Someone who
      got hold of your admin session therefore still cannot install anything. There is no password
      alternative. One-time setup, about 5 minutes.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4 text-sm">
    <ol class="list-decimal space-y-2 pl-5">
      <li>
        Open
        <a
          href={credentialsUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1 underline underline-offset-4"
          >Google Cloud → Credentials <ExternalLink class="size-3" aria-hidden="true" /></a
        > for this site's project.
      </li>
      <li>
        If Google asks you to configure the consent screen first: choose <em>Internal</em> if you use
        Google Workspace; otherwise <em>External</em>, and add your own Google address as a test user.
        Name it e.g. "Caelo admin".
      </li>
      <li>
        Click <em>Create credentials → OAuth client ID</em>, application type <em>Web application</em>.
      </li>
      <li>
        Under <em>Authorized redirect URIs</em> add exactly:
        <CopyLine value={redirectUri} label="Redirect URI" testid="step-up-redirect-uri" />
      </li>
      <li>Click <em>Create</em> and copy the client ID and client secret into the form below.</li>
    </ol>
    <form method="post" action="?/setClient" class="grid gap-3">
      <input type="hidden" name="_csrf" value={csrfToken} />
      <div class="grid gap-1.5">
        <Label for="step-up-client-id">Client ID</Label>
        <Input
          id="step-up-client-id"
          name="clientId"
          required
          placeholder="123456789-abc.apps.googleusercontent.com"
          autocomplete="off"
        />
      </div>
      <div class="grid gap-1.5">
        <Label for="step-up-client-secret">Client secret</Label>
        <Input
          id="step-up-client-secret"
          name="clientSecret"
          type="password"
          required
          autocomplete="off"
        />
      </div>
      <div>
        <Button type="submit" data-testid="save-step-up-client">Save Google sign-in</Button>
      </div>
    </form>
  </CardContent>
</Card>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { setupFormSchema } from "@caelo/shared";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { bindZodForm } from "$lib/forms/zod-bind.svelte.js";

  let { data, form } = $props();

  // P6.6 closing pass — same schema the `users.create_first_owner`
  // op enforces server-side, mirrored client-side for per-field live
  // feedback. The "setup already complete" failure path still
  // surfaces via the existing form?.error Alert.
  const setupForm = bindZodForm(setupFormSchema, {
    displayName: form?.displayName ?? "",
    email: form?.email ?? "",
  });
</script>

<Card>
  <CardHeader>
    <CardTitle>Welcome to Caelo</CardTitle>
    <CardDescription>
      Create the first owner account. After this, users are managed in the admin.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if form?.error}
      <Alert variant="destructive">
        <AlertDescription>{form.error}</AlertDescription>
      </Alert>
    {/if}
    <form method="post" class="space-y-4">
      {#if data.tokenRequired}
        <div class="space-y-2">
          <Label for="token">Bootstrap token</Label>
          <Input
            id="token"
            name="token"
            type="text"
            required
            value={data.tokenFromQuery}
            placeholder="64-character hex token from `cms-provision init` output"
          />
          <p class="text-xs text-muted-foreground">
            This installation requires a one-time token. Open the URL printed by `cms-provision
            init` (the token is in the query string), or paste it here.
          </p>
        </div>
      {/if}
      <div class="space-y-2">
        <Label for="displayName">Display name</Label>
        <Input
          id="displayName"
          name="displayName"
          type="text"
          required
          value={form?.displayName ?? ""}
          aria-invalid={setupForm.errors.displayName ? "true" : undefined}
          aria-describedby={setupForm.errors.displayName ? "displayName-err" : undefined}
          oninput={(e) =>
            setupForm.update("displayName", (e.currentTarget as HTMLInputElement).value)}
        />
        {#if setupForm.errors.displayName}
          <p id="displayName-err" class="text-xs text-destructive">
            {setupForm.errors.displayName}
          </p>
        {/if}
      </div>
      <div class="space-y-2">
        <Label for="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autocomplete="username"
          required
          value={form?.email ?? ""}
          aria-invalid={setupForm.errors.email ? "true" : undefined}
          aria-describedby={setupForm.errors.email ? "email-err" : undefined}
          oninput={(e) => setupForm.update("email", (e.currentTarget as HTMLInputElement).value)}
        />
        {#if setupForm.errors.email}
          <p id="email-err" class="text-xs text-destructive">{setupForm.errors.email}</p>
        {/if}
      </div>
      <div class="space-y-2">
        <Label for="password">Password (min 8 chars)</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autocomplete="new-password"
          required
          minlength={8}
          aria-invalid={setupForm.errors.password ? "true" : undefined}
          aria-describedby={setupForm.errors.password ? "password-err" : undefined}
          oninput={(e) =>
            setupForm.update("password", (e.currentTarget as HTMLInputElement).value)}
        />
        {#if setupForm.errors.password}
          <p id="password-err" class="text-xs text-destructive">{setupForm.errors.password}</p>
        {/if}
      </div>
      <!-- Submit stays enabled — see comment in login form. The
           inline errors are advisory; the server is authoritative. -->
      <Button type="submit" class="w-full">Create owner</Button>
    </form>
  </CardContent>
</Card>

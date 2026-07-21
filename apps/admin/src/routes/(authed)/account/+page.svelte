<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
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

  let { data, form } = $props();
</script>

<svelte:head><title>Account · Caelo</title></svelte:head>

<div class="mx-auto max-w-lg space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Account</h1>
    {#if data.email}
      <p class="mt-1 text-sm text-muted-foreground">Signed in as {data.email}</p>
    {/if}
  </div>

  <Card>
    <CardHeader>
      <CardTitle>Change password</CardTitle>
      <CardDescription>
        Changing your password signs you out of your other devices.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      {#if form?.ok}
        <Alert>
          <AlertDescription>Your password has been changed.</AlertDescription>
        </Alert>
      {/if}
      {#if form?.error}
        <Alert variant="destructive">
          <AlertDescription>{form.error}</AlertDescription>
        </Alert>
      {/if}
      <form method="post" action="?/changePassword" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2">
          <Label for="currentPassword">Current password</Label>
          <Input
            id="currentPassword"
            name="currentPassword"
            type="password"
            autocomplete="current-password"
            required
          />
        </div>
        <div class="space-y-2">
          <Label for="newPassword">New password</Label>
          <Input
            id="newPassword"
            name="newPassword"
            type="password"
            autocomplete="new-password"
            required
            minlength={10}
          />
          <p class="text-xs text-muted-foreground">
            At least 10 characters. Not a common password or your name/email.
          </p>
        </div>
        <div class="space-y-2">
          <Label for="confirm">Confirm new password</Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autocomplete="new-password"
            required
            minlength={10}
          />
        </div>
        <Button type="submit">Change password</Button>
      </form>
    </CardContent>
  </Card>
</div>

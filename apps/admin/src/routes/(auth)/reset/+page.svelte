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
  // The action echoes the token back on strength/mismatch failures so a retry
  // keeps it; the missing-token failure has none, hence the guarded access.
  const token = $derived(
    (form as { token?: string } | null | undefined)?.token ?? data.token,
  );
</script>

<svelte:head><title>Set a new password · Caelo</title></svelte:head>

<Card>
  <CardHeader>
    <CardTitle>Set a new password</CardTitle>
    <CardDescription>Choose a strong password you don't use elsewhere.</CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if !token}
      <Alert variant="destructive">
        <AlertDescription>
          This reset link is missing its token. <a href="/forgot" class="underline">Request a new
            one</a>.
        </AlertDescription>
      </Alert>
    {:else}
      {#if form?.error}
        <Alert variant="destructive">
          <AlertDescription>{form.error}</AlertDescription>
        </Alert>
      {/if}
      <form method="post" class="space-y-4">
        <input type="hidden" name="token" value={token} />
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
        <Button type="submit" class="w-full">Set new password</Button>
      </form>
    {/if}
  </CardContent>
</Card>

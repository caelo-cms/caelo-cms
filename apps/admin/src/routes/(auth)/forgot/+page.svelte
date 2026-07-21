<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
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

  let { form } = $props();
</script>

<svelte:head><title>Reset password · Caelo</title></svelte:head>

<Card>
  <CardHeader>
    <CardTitle>Forgot your password?</CardTitle>
    <CardDescription>We'll email you a link to set a new one.</CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if form?.sent}
      <Alert>
        <AlertDescription>
          If an account exists for that email, a reset link is on its way. The link expires in one
          hour.
        </AlertDescription>
      </Alert>
      <a href="/login" class={buttonVariants({ variant: "outline", class: "w-full" })}>
        Back to sign in
      </a>
    {:else}
      {#if form?.error}
        <Alert variant="destructive">
          <AlertDescription>{form.error}</AlertDescription>
        </Alert>
      {/if}
      <form method="post" class="space-y-4">
        <div class="space-y-2">
          <Label for="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autocomplete="username"
            required
            value={form?.email ?? ""}
          />
        </div>
        <Button type="submit" class="w-full">Send reset link</Button>
      </form>
      <a href="/login" class="block text-center text-sm text-muted-foreground hover:underline">
        Back to sign in
      </a>
    {/if}
  </CardContent>
</Card>

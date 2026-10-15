<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { buttonVariants } from "#lib/components/ui/button/button-variants.js";
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

  let { data, form } = $props();
  const emailUnavailable = $derived(data.emailUnavailable || form?.emailUnavailable === true);
</script>

<svelte:head><title>Reset password · Caelo</title></svelte:head>

<Card>
  <CardHeader>
    <CardTitle>Forgot your password?</CardTitle>
    <CardDescription>
      {emailUnavailable
        ? "This install can't send email, so the reset link comes from the command line."
        : "We'll email you a link to set a new one."}
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if emailUnavailable}
      <Alert>
        <AlertDescription class="space-y-2">
          <p>
            No email is set up for this install, so we can't send you a reset link. Whoever manages
            the install's cloud account can create one with:
          </p>
          <pre class="overflow-x-auto rounded-md bg-muted p-3 text-xs"><code
              >bunx @caelo-cms/provisioning owner-reset</code
            ></pre>
          <p>
            It prints a one-time link to set a new password. Another Owner can also set one for you
            under Settings → Users. Once you're back in, set up email under Settings → Email so this
            page can send the link next time.
          </p>
        </AlertDescription>
      </Alert>
      <a href="/login" class={buttonVariants({ variant: "outline", class: "w-full" })}>
        Back to sign in
      </a>
    {:else if form?.sent}
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

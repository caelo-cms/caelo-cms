<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Lock } from "lucide-svelte";
  import { enhance } from "$app/forms";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";

  let { data, form } = $props();
  let signupOpen = $state(data.config.signupOpen);
  let passwordMinLength = $state(data.config.passwordMinLength);
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Lock class="size-6" />
      Visitor authentication
    </h1>
    <p class="text-sm text-muted-foreground">
      Owner-only config for the visitor auth plugin. Edits below apply immediately. AI proposals
      land in the <a href="/security/auth/pending" class="underline">pending queue</a> for review.
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">{form.error}</div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">{form.message}</div>
  {/if}
  {#if data.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">Could not load config: {data.error}</div>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle>Auth config (singleton)</CardTitle>
      <CardDescription>
        Last updated {data.config.updatedAt ? new Date(data.config.updatedAt).toLocaleString() : "never (defaults shown)"}
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/apply" use:enhance class="grid gap-4 max-w-md">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" name="signupOpen" bind:checked={signupOpen} />
          <span>Allow visitor signup</span>
        </label>
        <label class="grid gap-1 text-sm">
          <span>Minimum password length (8 – 128)</span>
          <Input name="passwordMinLength" type="number" min={8} max={128} bind:value={passwordMinLength} required />
        </label>
        <div>
          <Button type="submit">Save config</Button>
        </div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>OAuth providers</CardTitle>
      <CardDescription>Google + GitHub via Arctic — not yet wired.</CardDescription>
    </CardHeader>
    <CardContent>
      <p class="text-sm text-muted-foreground">
        OAuth lands as a follow-up. Until then, visitors authenticate via email + password through the
        <code>&lt;caelo-auth&gt;</code> Web Component.
      </p>
    </CardContent>
  </Card>
</div>

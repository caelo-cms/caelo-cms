<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { page } from "$app/state";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";

  let { data, form } = $props();
  const kind = $derived(page.params.kind ?? "");
</script>

<div class="space-y-6">
  <div class="flex items-center gap-2">
    <a
      href="/security/structured"
      class={buttonVariants({ variant: "outline", size: "sm" })}>← Back</a>
    <h1 class="text-2xl font-semibold tracking-tight">New {kind}</h1>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Set details</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <Label for="slug">Slug</Label>
            <Input
              id="slug"
              name="slug"
              type="text"
              required
              pattern="[a-z0-9][a-z0-9-]*"
              placeholder="header-main" />
          </div>
          <div class="space-y-2">
            <Label for="displayName">Display name</Label>
            <Input id="displayName" name="displayName" type="text" required />
          </div>
        </div>
        <div class="space-y-2">
          <Label for="items">items (JSON array)</Label>
          <textarea
            id="items"
            name="items"
            required
            rows="14"
            class="block w-full rounded-md border bg-background p-2 font-mono text-xs"
            placeholder="[]">[]</textarea>
          <p class="text-xs text-muted-foreground">
            Per-kind Zod validator runs at save; mismatched shape returns an explicit error.
          </p>
        </div>
        <div class="flex justify-end">
          <Button type="submit">Create set</Button>
        </div>
      </form>
    </CardContent>
  </Card>
</div>

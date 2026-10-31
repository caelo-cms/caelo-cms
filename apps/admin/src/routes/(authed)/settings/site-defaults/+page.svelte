<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Label } from "#lib/components/ui/label/index.js";

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Site defaults</h1>
    <p class="text-sm text-muted-foreground">
      The layout a new template uses when none is chosen. Pages always name their page type and
      templates theirs, so there is no default page type or template. Stored data, not a
      render-time fallback — the renderer always errors loudly when expected data is missing.
    </p>
  </div>

  {#if data.loadErrors && data.loadErrors.length > 0}
    <Alert variant="destructive">
      <AlertDescription>
        <p class="font-medium mb-1">Could not load all options:</p>
        <ul class="list-disc list-inside text-sm">
          {#each data.loadErrors as err (err)}
            <li>{err}</li>
          {/each}
        </ul>
      </AlertDescription>
    </Alert>
  {/if}

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {:else if form?.message}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Current defaults</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2">
          <Label for="defaultLayoutId">Default layout</Label>
          {#if data.layouts.length === 0}
            <p class="text-sm text-muted-foreground italic">
              No layouts available. Create one at <a href="/settings/layouts" class="underline">/settings/layouts</a>.
            </p>
          {:else}
            <select
              id="defaultLayoutId"
              name="defaultLayoutId"
              required
              class="block w-full rounded-md border bg-background p-2 text-sm">
              {#each data.layouts as layout (layout.id)}
                <option value={layout.id} selected={data.defaults?.defaultLayoutId === layout.id}>
                  {layout.slug} — {layout.displayName}
                </option>
              {/each}
            </select>
          {/if}
        </div>
        <div class="flex justify-end">
          <Button type="submit">Save default layout</Button>
        </div>
      </form>
    </CardContent>
  </Card>
</div>

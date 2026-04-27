<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Label } from "$lib/components/ui/label/index.js";

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Site defaults</h1>
    <p class="text-sm text-muted-foreground">
      Defaults used when a new page or template is created without an explicit layout / template id.
      Stored data, not a render-time fallback — the renderer always errors loudly when expected
      data is missing (CLAUDE.md §2 no-fallbacks).
    </p>
  </div>

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
        </div>
        <div class="space-y-2">
          <Label for="defaultTemplateId">Default template</Label>
          <select
            id="defaultTemplateId"
            name="defaultTemplateId"
            required
            class="block w-full rounded-md border bg-background p-2 text-sm">
            {#each data.templates as tpl (tpl.id)}
              <option value={tpl.id} selected={data.defaults?.defaultTemplateId === tpl.id}>
                {tpl.slug} — {tpl.displayName}
              </option>
            {/each}
          </select>
        </div>
        <div class="flex justify-end">
          <Button type="submit">Save defaults</Button>
        </div>
      </form>
    </CardContent>
  </Card>
</div>

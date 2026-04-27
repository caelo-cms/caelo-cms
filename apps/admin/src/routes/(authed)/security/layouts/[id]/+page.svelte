<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
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
</script>

<div class="space-y-6">
  <div class="flex items-center gap-2">
    <a href="/security/layouts" class={buttonVariants({ variant: "outline", size: "sm" })}>← Back</a>
    <h1 class="text-2xl font-semibold tracking-tight">Edit layout</h1>
    <Badge variant="outline">{data.layout.slug}</Badge>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {:else if form?.message}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Layout HTML / CSS</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/update" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2">
          <Label for="displayName">Display name</Label>
          <Input id="displayName" name="displayName" type="text" required value={data.layout.displayName} />
        </div>
        <div class="space-y-2">
          <Label for="html">HTML</Label>
          <textarea
            id="html"
            name="html"
            required
            rows="10"
            class="block w-full rounded-md border bg-background p-2 font-mono text-xs">{data.layout.html}</textarea>
          <p class="text-xs text-muted-foreground">
            Must contain <code>&lt;caelo-slot name="content"&gt;…&lt;/caelo-slot&gt;</code>.
          </p>
        </div>
        <div class="space-y-2">
          <Label for="css">CSS</Label>
          <textarea
            id="css"
            name="css"
            rows="6"
            class="block w-full rounded-md border bg-background p-2 font-mono text-xs">{data.layout.css}</textarea>
        </div>
        <div class="flex justify-end">
          <Button type="submit">Save changes</Button>
        </div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Blocks</CardTitle>
    </CardHeader>
    <CardContent>
      <ul class="space-y-1 text-sm">
        {#each data.layout.blocks
          .slice()
          .sort((a, b) => a.position - b.position) as block (block.name)}
          <li>
            <strong>{block.name}</strong>
            <span class="text-muted-foreground">— {block.displayName} (position {block.position})</span>
          </li>
        {/each}
      </ul>
      <p class="mt-2 text-xs text-muted-foreground">
        Editing blocks (rename / re-order / add) is not yet exposed here. Re-create the layout if
        the block topology needs to change.
      </p>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base text-destructive">Danger zone</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/delete">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <Button type="submit" variant="destructive">Delete layout</Button>
        <p class="mt-2 text-xs text-muted-foreground">
          Refused if any non-deleted template still references this layout — re-point them first.
        </p>
      </form>
    </CardContent>
  </Card>
</div>

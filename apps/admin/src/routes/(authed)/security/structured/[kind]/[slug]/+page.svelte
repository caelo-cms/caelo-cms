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

  const KIND_HINTS: Record<string, string> = {
    "nav-menu":
      'Items: [{"label": "Home", "href": "/", "target": "_self", "children": [...]}]. The renderer walks `children` recursively for submenus.',
    taxonomy:
      'Items: [{"slug": "blog", "displayName": "Blog", "parentSlug": "content", "description": "..."}]. parentSlug forms a tree.',
    theme:
      'Items: [{"token": "color-primary", "value": "#0066ff", "scope": "color"}]. Tokens emit as `:root { --color-primary: #0066ff; }`.',
    tags: 'Items: [{"slug": "engineering", "displayName": "Engineering", "color": "#3366aa"}]. Flat list.',
    "link-list":
      'Items: [{"label": "Privacy policy", "href": "/legal/privacy", "description": "..."}]. Footer / legal blocks.',
  };

  const itemsJson = $derived(JSON.stringify(data.set.items, null, 2));
  const items = $derived(Array.isArray(data.set.items) ? (data.set.items as unknown[]) : []);
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-center gap-2">
    <a
      href="/security/structured"
      class={buttonVariants({ variant: "outline", size: "sm" })}>← Back</a>
    <h1 class="text-2xl font-semibold tracking-tight">Edit set</h1>
    <Badge variant="outline">{data.set.kind}</Badge>
    <Badge variant="outline">{data.set.slug}</Badge>
    <Badge>{items.length} item{items.length === 1 ? "" : "s"}</Badge>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Items (JSON)</CardTitle>
      <p class="text-xs text-muted-foreground">{KIND_HINTS[data.set.kind] ?? ""}</p>
    </CardHeader>
    <CardContent>
      <form method="post" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2">
          <Label for="displayName">Display name</Label>
          <Input
            id="displayName"
            name="displayName"
            type="text"
            required
            value={data.set.displayName} />
        </div>
        <div class="space-y-2">
          <Label for="items">items</Label>
          <textarea
            id="items"
            name="items"
            required
            rows="20"
            class="block w-full rounded-md border bg-background p-2 font-mono text-xs"
            >{itemsJson}</textarea>
          <p class="text-xs text-muted-foreground">
            Saving runs the per-kind Zod validator; bad shape comes back as an explicit error
            message.
          </p>
        </div>
        <div class="flex justify-end">
          <Button type="submit">Save</Button>
        </div>
      </form>
    </CardContent>
  </Card>
</div>

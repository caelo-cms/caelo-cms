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
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";

  let { data, form } = $props();
  const module = data.module as {
    id: string;
    slug: string;
    displayName: string;
    html: string;
    css: string;
    js: string;
    deletedAt: string | null;
  };
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">{module.slug}</h1>
    <p class="text-sm text-muted-foreground">
      <a class="underline" href={`/content/modules/${module.id}/history`}>View history ↗</a>
    </p>
  </div>

  {#if module.deletedAt}
    <Alert variant="destructive">
      <AlertDescription>This module is soft-deleted ({module.deletedAt}).</AlertDescription>
    </Alert>
  {/if}
  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>Saved.</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Edit module</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/update" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2">
          <Label for="displayName">Display name</Label>
          <Input id="displayName" name="displayName" type="text" value={module.displayName} required />
        </div>
        <div class="space-y-2">
          <Label for="html">HTML</Label>
          <Textarea id="html" name="html" rows={10} class="font-mono text-xs" value={module.html} />
        </div>
        <div class="space-y-2">
          <Label for="css">CSS</Label>
          <Textarea id="css" name="css" rows={6} class="font-mono text-xs" value={module.css} />
        </div>
        <div class="space-y-2">
          <Label for="js">JS</Label>
          <Textarea id="js" name="js" rows={6} class="font-mono text-xs" value={module.js} />
        </div>
        <Button type="submit">Save</Button>
      </form>
    </CardContent>
  </Card>

  {#if !module.deletedAt}
    <Card class="border-destructive/50">
      <CardHeader>
        <CardTitle class="text-base text-destructive">Danger zone</CardTitle>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/delete">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <Button type="submit" variant="destructive">Soft-delete this module</Button>
        </form>
      </CardContent>
    </Card>
  {/if}
</div>

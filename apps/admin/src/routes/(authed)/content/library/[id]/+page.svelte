<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.12.3 — /content/library/[id] edit view. Renders the
   * content_instance's values against the owning module's fields
   * schema. Save calls content_instances.set_values via the form
   * action; the placementCount in the redirect query string lets the
   * library list show a "edits propagated to N pages" toast.
   */
  import PlacementsList from "$lib/components/content/PlacementsList.svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
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
  import { Textarea } from "$lib/components/ui/textarea/index.js";

  let { data, form } = $props();

  const blastWarning = $derived(
    data.placements.length >= 2
      ? `Saving will update ${data.placements.length} placement(s) across ${
          new Set(data.placements.map((p) => p.pageId)).size
        } page(s). Synced placements propagate; unsynced placements stay local.`
      : null,
  );

  function asString(v: unknown): string {
    if (v === null || v === undefined) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">
        {data.instance.displayName ?? data.instance.slug ?? "Content instance"}
      </h1>
      <p class="text-sm text-muted-foreground">
        Module <span class="font-mono">{data.instance.moduleSlug}</span> · v{data.instance.version}
        · {data.instance.placementCount} placement{data.instance.placementCount === 1 ? "" : "s"}
      </p>
    </div>
    <a href="/content/library" class="text-sm underline-offset-4 hover:underline">
      ← Back to library
    </a>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  {#if blastWarning}
    <Alert>
      <AlertDescription>{blastWarning}</AlertDescription>
    </Alert>
  {/if}

  <div class="grid gap-6 md:grid-cols-3">
    <Card class="md:col-span-2">
      <CardHeader>
        <CardTitle class="text-base">Values</CardTitle>
        <CardDescription>
          One input per declared module field. Empty → falls back to the field's default at render
          time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/save" class="space-y-4">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <div class="grid gap-4 md:grid-cols-2">
            <div class="space-y-2">
              <Label for="slug">Slug (optional)</Label>
              <Input id="slug" name="slug" type="text" value={data.instance.slug ?? ""} />
            </div>
            <div class="space-y-2">
              <Label for="displayName">Display name</Label>
              <Input
                id="displayName"
                name="displayName"
                type="text"
                value={data.instance.displayName ?? ""}
              />
            </div>
          </div>

          {#if data.moduleFields.length === 0}
            <p class="text-sm text-muted-foreground">
              This module declares no fields — content_instance values are pure JSON. Edit via the
              AI chat for nested-module fields.
            </p>
          {:else}
            {#each data.moduleFields as f (f.name)}
              <div class="space-y-2">
                <Label for={`value.${f.name}`}>
                  {f.label} <span class="font-mono text-xs text-muted-foreground">({f.kind})</span>
                  {#if f.kind === "module" || f.kind === "module-list"}
                    <Badge variant="outline" class="ml-2">nested · edit via AI chat</Badge>
                  {/if}
                </Label>
                {#if f.kind === "richtext"}
                  <Textarea
                    id={`value.${f.name}`}
                    name={`value.${f.name}`}
                    rows={4}
                    value={asString(data.instance.values[f.name])}
                  />
                {:else if f.kind === "module" || f.kind === "module-list"}
                  <!-- v0.12.2 — display-only. Nested-module refs are
                       `{moduleId, contentInstanceId}` objects (or arrays
                       of them); a readonly textarea with `name` is still
                       submitted, so saving would overwrite the structured
                       ref with `JSON.stringify(...)` and corrupt it.
                       Omit `name` so the form action never sees this
                       field — the existing ref stays intact. Edit via
                       the AI chat surface. -->
                  <Textarea
                    id={`value.${f.name}`}
                    rows={3}
                    readonly
                    value={asString(data.instance.values[f.name])}
                  />
                {:else}
                  <Input
                    id={`value.${f.name}`}
                    name={`value.${f.name}`}
                    type="text"
                    value={asString(data.instance.values[f.name])}
                  />
                {/if}
              </div>
            {/each}
          {/if}

          <Button type="submit">
            Save{data.placements.length >= 2 ? ` (propagates to ${data.placements.length})` : ""}
          </Button>
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">Bound placements</CardTitle>
      </CardHeader>
      <CardContent>
        <PlacementsList placements={data.placements} />
      </CardContent>
    </Card>
  </div>
</div>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { CheckCircle2, Download, Trash2 } from "lucide-svelte";
  import { enhance } from "$app/forms";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Download class="size-6" />
      Import run · <span class="font-mono text-base">{data.run.sourceUrl}</span>
    </h1>
    <p class="text-sm text-muted-foreground">
      <Badge>{data.run.status}</Badge> · seen {data.run.pagesSeen} · extracted {data.run.pagesExtracted}
      · started {new Date(data.run.createdAt).toLocaleString()}
      {#if data.run.finishedAt} · finished {new Date(data.run.finishedAt).toLocaleString()}{/if}
    </p>
    {#if data.run.errorMessage}
      <p class="mt-2 text-sm text-red-600">{data.run.errorMessage}</p>
    {/if}
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">{form.error}</div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">{form.message}</div>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle>Extracted pages</CardTitle>
      <CardDescription>
        Owner reviews each before promoting to draft. Modules are imported verbatim — edit in the
        page editor before publish.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      {#if data.pages.length === 0}
        <p class="text-sm text-muted-foreground">No pages yet — wait for the worker to finish.</p>
      {:else}
        {#each data.pages as p (p.id)}
          <div class="rounded border p-3">
            <div class="mb-2 flex items-center gap-2">
              <span class="font-mono text-sm">{p.proposedSlug}</span>
              <Badge variant="outline">{p.proposedTitle || "(no title)"}</Badge>
              <Badge variant="outline">{p.proposedModules.length} modules</Badge>
              {#if p.acceptedPageId}
                <Badge><CheckCircle2 class="size-3" /> accepted</Badge>
              {/if}
            </div>
            <p class="mb-3 font-mono text-xs text-muted-foreground">{p.sourceUrl}</p>
            <!-- issue #198 — side-by-side: original site vs rebuilt
                 preview, with the pixel-diff verdict. Renders only
                 when the worker persisted captures. -->
            {#if p.screenshotObjectKey || p.stagedScreenshotObjectKey}
              <div class="mb-3 flex flex-wrap gap-4" data-testid="import-screenshots">
                {#if p.screenshotObjectKey}
                  <figure class="w-64">
                    <img
                      src={`/security/import/screenshot/${p.id}/source`}
                      alt={`Original: ${p.sourceUrl}`}
                      class="rounded border border-border"
                      loading="lazy"
                    />
                    <figcaption class="mt-1 text-xs text-muted-foreground">Original site</figcaption>
                  </figure>
                {/if}
                {#if p.stagedScreenshotObjectKey}
                  <figure class="w-64">
                    <img
                      src={`/security/import/screenshot/${p.id}/staged`}
                      alt={`Rebuilt preview: ${p.proposedSlug}`}
                      class="rounded border border-border"
                      loading="lazy"
                    />
                    <figcaption class="mt-1 text-xs text-muted-foreground">
                      Rebuilt in Caelo
                      {#if p.diffStatus}
                        · diff {p.diffStatus}{p.diffPct !== null ? ` (${Math.round(p.diffPct * 100)}%)` : ""}
                      {/if}
                    </figcaption>
                  </figure>
                {/if}
              </div>
            {/if}
            <details class="mb-3 text-sm">
              <summary class="cursor-pointer">Module preview</summary>
              <ul class="ml-6 list-disc text-xs">
                {#each p.proposedModules as m, i (i)}
                  <li>
                    <span class="font-mono">{m.blockName}</span> · pos {m.position} · {m.html.length} bytes
                  </li>
                {/each}
              </ul>
            </details>
            {#if !p.acceptedPageId && data.defaultTemplateId}
              <form method="post" action="?/accept" use:enhance>
                <input type="hidden" name="importPageId" value={p.id} />
                <input type="hidden" name="templateId" value={data.defaultTemplateId} />
                <Button type="submit" size="sm">Accept (creates draft page)</Button>
              </form>
            {/if}
          </div>
        {/each}
      {/if}
    </CardContent>
  </Card>

  {#if data.run.status === "ready_for_review"}
    <Card>
      <CardHeader>
        <CardTitle>Done with this run?</CardTitle>
        <CardDescription>Drops un-accepted import_pages rows; accepted pages stay.</CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/cleanup" use:enhance>
          <input type="hidden" name="runId" value={data.run.id} />
          <Button type="submit" variant="destructive" class="gap-2">
            <Trash2 class="size-4" /> Mark complete + clean up
          </Button>
        </form>
      </CardContent>
    </Card>
  {/if}
</div>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Inbox } from "lucide-svelte";
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
  function fmt(s: string): string {
    return new Date(s).toLocaleString();
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Inbox class="size-6" />
      AI-proposed crawls
    </h1>
    <p class="text-sm text-muted-foreground">
      AI cannot run a headless crawler unprompted. Each proposal lands here for Owner approval. See
      <a href="/security/import" class="underline">/security/import</a> for the full list.
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">{form.error}</div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">{form.message}</div>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle>Pending</CardTitle>
      <CardDescription>{data.runs.length} awaiting review</CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      {#if data.runs.length === 0}
        <p class="text-sm text-muted-foreground">No pending proposals.</p>
      {:else}
        {#each data.runs as r (r.id)}
          <div class="rounded border p-3">
            <div class="mb-2 flex items-center gap-2">
              <span class="font-mono text-sm">{r.sourceUrl}</span>
              <!-- issue #229 — LIST mode fetches an exact set; depth/max
                   are meaningless there, so show the page count instead. -->
              {#if r.explicitUrls}
                <Badge variant="outline">list · {r.explicitUrls.length} pages</Badge>
              {:else}
                <Badge variant="outline">depth {r.depth}</Badge>
                <Badge variant="outline">max {r.maxPages}</Badge>
              {/if}
              <span class="text-xs text-muted-foreground">{fmt(r.createdAt)}</span>
            </div>
            <!-- issue #229 — surface the exact URLs the crawl will fetch
                 so the approval is informed (acceptance criterion). -->
            {#if r.explicitUrls}
              <details class="mb-2 text-sm" data-testid="import-explicit-urls">
                <summary class="cursor-pointer text-muted-foreground">
                  {r.explicitUrls.length} chosen page{r.explicitUrls.length === 1 ? "" : "s"} to fetch
                </summary>
                <ul class="mt-1 list-disc pl-5 font-mono text-xs text-muted-foreground">
                  {#each r.explicitUrls as u (u)}
                    <li class="break-all">{u}</li>
                  {/each}
                </ul>
              </details>
            {/if}
            <!-- issue #193 — blast-radius summary (§11.A): the Owner
                 approves with numbers. Unknown scope is shown as
                 unknown, never omitted. -->
            {#if r.estimate}
              {#if r.estimate.failed}
                <p class="mb-2 text-sm text-amber-600 dark:text-amber-400" data-testid="import-estimate">
                  Scope unknown — estimate failed: {r.estimate.reason}
                </p>
              {:else}
                <p
                  class="mb-2 text-sm {r.estimate.pages > 500 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}"
                  data-testid="import-estimate"
                >
                  {#if r.estimate.pages > 500}⚠ Large site:{/if}
                  <!-- issue #229 — list basis is the exact Owner-chosen
                       count; the "~" approximation marker only applies to
                       sitemap/sample estimates. -->
                  {r.estimate.basis === "list" ? "" : "~"}{r.estimate.pages}{r.estimate.truncated ? "+" : ""} pages
                  ({r.estimate.basis === "sitemap"
                    ? "from sitemap"
                    : r.estimate.basis === "list"
                      ? "exact list"
                      : "rough sample"})
                  · crawl ≈ {r.estimate.crawlMinutes} min
                  · AI rebuild ≈ ${r.estimate.aiCostUsd.low}–${r.estimate.aiCostUsd.high}
                </p>
              {/if}
            {/if}
            <div class="flex gap-2">
              <form method="post" action="?/approve" use:enhance>
                <input type="hidden" name="runId" value={r.id} />
                <Button type="submit" size="sm">Approve crawl</Button>
              </form>
              <form method="post" action="?/reject" use:enhance class="flex items-center gap-2">
                <input type="hidden" name="runId" value={r.id} />
                <input name="reason" placeholder="Reason (optional)" class="rounded border px-2 py-1 text-sm" />
                <Button type="submit" size="sm" variant="outline">Reject</Button>
              </form>
            </div>
          </div>
        {/each}
      {/if}
    </CardContent>
  </Card>
</div>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P10 — translation dashboard. Per CMS_REQUIREMENTS §7.7 + UX-5:
   * one primary action per row ("Translate" or "Bring up to date"),
   * one top-level bulk button ("Auto-translate everything stale"),
   * job-progress widget when a job is running. Granular controls live
   * in /content/translations/advanced.
   */

  import { Languages } from "lucide-svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table/index.js";

  let { data, form } = $props();
  const csrfToken = $derived(
    typeof window === "undefined" ? "" : (document.cookie.match(/caelo_csrf=([^;]+)/)?.[1] ?? ""),
  );

  function statusBadge(status: string): string {
    switch (status) {
      case "source":
        return "✓ source";
      case "up_to_date":
        return "✓ up-to-date";
      case "needs_update":
        return "⚠ needs update";
      case "not_started":
        return "○ not started";
      default:
        return status;
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Languages class="size-6" />
      Translations
    </h1>
    <p class="text-sm text-muted-foreground">
      Per-page, per-locale translation status. The AI translates each page on demand. Results land
      as drafts — you confirm via the publish flow before they go live.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message ?? "Saved."}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Bulk</CardTitle>
      <CardDescription>
        {#if data.staleCount === 0}
          Everything is up to date — no pending translations.
        {:else}
          {data.staleCount}
          translation{data.staleCount === 1 ? "" : "s"} pending across the matrix below.
        {/if}
      </CardDescription>
    </CardHeader>
    <CardContent class="flex items-center gap-2">
      <form method="post" action="?/bulkAllStale">
        <input type="hidden" name="_csrf" value={csrfToken} />
        <Button type="submit" disabled={data.staleCount === 0}>
          Auto-translate everything stale
        </Button>
      </form>
      <a href="/content/translations/advanced" class="text-sm underline text-muted-foreground">
        Advanced actions →
      </a>
    </CardContent>
  </Card>

  {#if data.recentCompletedJob && !data.activeJob}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Recent batch ready</CardTitle>
        <CardDescription>
          {data.recentCompletedJob.completedUnits} translation{data.recentCompletedJob
            .completedUnits === 1
            ? ""
            : "s"} completed. Each variant landed as DRAFT — review and publish them in one go.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/publishCompleted">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <input type="hidden" name="jobId" value={data.recentCompletedJob.id} />
          <Button type="submit">Publish all {data.recentCompletedJob.completedUnits} completed</Button>
        </form>
      </CardContent>
    </Card>
  {/if}

  {#if data.activeJob}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          Job in flight ({data.activeJob.status})
        </CardTitle>
        <CardDescription>
          {data.activeJob.completedUnits}/{data.activeJob.totalUnits} done · {data.activeJob.erroredUnits}
          error{data.activeJob.erroredUnits === 1 ? "" : "s"} · cost
          {(data.activeJob.costMicrocents / 1e8).toFixed(4)} USD
          {#if data.activeJob.capMicrocents !== null}
            · cap {(data.activeJob.capMicrocents / 1e8).toFixed(4)} USD
          {/if}
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-2">
        <div class="h-2 w-full overflow-hidden rounded bg-muted">
          <div
            class="h-full bg-primary transition-all"
            style:width={`${data.activeJob.totalUnits > 0 ? Math.round((100 * data.activeJob.completedUnits) / data.activeJob.totalUnits) : 0}%`}
          ></div>
        </div>
        {#if data.activeJob.errorSummary}
          <p class="text-xs text-yellow-700 dark:text-yellow-400">
            ⚠ {data.activeJob.errorSummary}
          </p>
        {/if}
        <form method="post" action="?/cancelJob">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <input type="hidden" name="jobId" value={data.activeJob.id} />
          <Button type="submit" size="sm" variant="outline">Cancel</Button>
        </form>
      </CardContent>
    </Card>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Per-page status</CardTitle>
      <CardDescription>
        One row per source page. One column per locale. Click "Translate" or "Bring up to date" to
        run the AI translation for a single cell.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.slugs.length === 0}
        <p class="text-sm text-muted-foreground">
          No source pages yet. Create a page in the default locale to populate this matrix.
        </p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              {#each data.locales as l (l.code)}
                <TableHead class="font-mono">{l.code}</TableHead>
              {/each}
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.slugs as slug (slug)}
              <TableRow>
                <TableCell class="font-mono">{slug}</TableCell>
                {#each data.locales as l (l.code)}
                  {@const cell = data.cellsByKey[`${slug}|${l.code}`]}
                  <TableCell>
                    {#if cell}
                      <div class="flex flex-col gap-1">
                        <span class="text-xs text-muted-foreground">{statusBadge(cell.status)}</span>
                        {#if cell.status === "not_started"}
                          <form method="post" action="?/translateOne">
                            <input type="hidden" name="_csrf" value={csrfToken} />
                            <input type="hidden" name="pageId" value={cell.sourcePageId} />
                            <input type="hidden" name="targetLocale" value={l.code} />
                            <input type="hidden" name="mode" value="mode_1" />
                            <Button type="submit" size="sm" variant="outline">Translate</Button>
                          </form>
                        {:else if cell.status === "needs_update"}
                          <form method="post" action="?/translateOne">
                            <input type="hidden" name="_csrf" value={csrfToken} />
                            <input type="hidden" name="pageId" value={cell.sourcePageId} />
                            <input type="hidden" name="targetLocale" value={l.code} />
                            <input type="hidden" name="mode" value="mode_2" />
                            <Button type="submit" size="sm" variant="outline">
                              Bring up to date
                            </Button>
                          </form>
                        {/if}
                      </div>
                    {/if}
                  </TableCell>
                {/each}
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>
</div>

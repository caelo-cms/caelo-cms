<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Star } from "lucide-svelte";
  import { enhance } from "$app/forms";
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
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Star class="size-6" />
      Ratings
    </h1>
    <p class="text-sm text-muted-foreground">
      Page-level ratings aggregated from visitor votes. Aggregates refresh every five minutes via
      the <code>refresh_aggregates</code> worker.
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">{form.error}</div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">{form.message}</div>
  {/if}
  {#if data.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">Failed: {data.error}</div>
  {/if}

  <Card>
    <CardHeader>
      <div class="flex items-center justify-between">
        <div>
          <CardTitle>Page aggregates</CardTitle>
          <CardDescription>Sorted by votes — top-rated pages first.</CardDescription>
        </div>
        <form method="post" action="?/refresh" use:enhance>
          <Button type="submit" size="sm" variant="secondary">Refresh now</Button>
        </form>
      </div>
    </CardHeader>
    <CardContent>
      {#if data.aggregates.length === 0}
        <p class="text-sm text-muted-foreground">No ratings yet.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Page</TableHead>
              <TableHead>Locale</TableHead>
              <TableHead class="text-right">Votes</TableHead>
              <TableHead class="text-right">Average</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.aggregates as a (`${a.page_id}-${a.locale}`)}
              <TableRow>
                <TableCell class="font-mono text-xs">{a.page_id}</TableCell>
                <TableCell>{a.locale}</TableCell>
                <TableCell class="text-right">{a.count}</TableCell>
                <TableCell class="text-right">{(a.average / 100).toFixed(2)}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>
</div>

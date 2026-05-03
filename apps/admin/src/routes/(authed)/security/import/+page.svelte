<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Download } from "lucide-svelte";
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
  import { Input } from "$lib/components/ui/input/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table/index.js";

  let { data, form } = $props();

  function statusVariant(s: string): "default" | "outline" | "destructive" | "secondary" {
    if (s === "ready_for_review") return "default";
    if (s === "completed") return "secondary";
    if (s === "failed") return "destructive";
    return "outline";
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Download class="size-6" />
      Site import
    </h1>
    <p class="text-sm text-muted-foreground">
      Crawl an existing site, extract per-page modules, stage as draft pages. Nothing publishes
      automatically — Owner reviews each page in the run detail view, clicks Accept, then promotes
      via the standard publish flow. AI-proposed crawls land at <a href="/security/import/pending" class="underline">/security/import/pending</a>.
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">{form.error}</div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">{form.message}</div>
  {/if}
  {#if data.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">Could not load runs: {data.error}</div>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle>Start a new crawl</CardTitle>
      <CardDescription>Same-domain BFS bounded by depth + max pages. Polite ~10 req/s.</CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/startCrawl" use:enhance class="grid gap-3 max-w-xl md:grid-cols-3">
        <label class="grid gap-1 text-sm md:col-span-3">
          <span>Source URL</span>
          <Input name="sourceUrl" type="url" placeholder="https://example.com/" required />
        </label>
        <label class="grid gap-1 text-sm">
          <span>Depth (1–5)</span>
          <Input name="depth" type="number" min={1} max={5} value="2" required />
        </label>
        <label class="grid gap-1 text-sm md:col-span-2">
          <span>Max pages (1–500)</span>
          <Input name="maxPages" type="number" min={1} max={500} value="50" required />
        </label>
        <div class="md:col-span-3"><Button type="submit">Start crawl</Button></div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>Recent runs</CardTitle>
      <CardDescription>{data.runs.length} total</CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.runs.length === 0}
        <p class="text-sm text-muted-foreground">No runs yet.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead class="text-right">Seen</TableHead>
              <TableHead class="text-right">Extracted</TableHead>
              <TableHead>Started</TableHead>
              <TableHead class="text-right">Open</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.runs as r (r.id)}
              <TableRow>
                <TableCell class="font-mono text-xs">{r.sourceUrl}</TableCell>
                <TableCell><Badge variant={statusVariant(r.status)}>{r.status}</Badge></TableCell>
                <TableCell class="text-right">{r.pagesSeen}</TableCell>
                <TableCell class="text-right">{r.pagesExtracted}</TableCell>
                <TableCell class="text-xs">{new Date(r.createdAt).toLocaleString()}</TableCell>
                <TableCell class="text-right">
                  <a href={`/security/import/${r.id}`} class="text-sm underline">Review</a>
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>
</div>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
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

  let { data } = $props();
  function fmtUsd(v: number): string {
    return v < 0.01 ? `$${v.toFixed(6)}` : `$${v.toFixed(4)}`;
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">AI cost dashboard</h1>
    <p class="text-sm text-muted-foreground">
      Per-call token + cost accounting from the chat surface, last 30 days. Per-actor budgets land in P16.
    </p>
  </div>

  <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
    <Card>
      <CardHeader>
        <CardDescription>Calls</CardDescription>
        <CardTitle class="text-2xl">{data.totals.calls}</CardTitle>
      </CardHeader>
    </Card>
    <Card>
      <CardHeader>
        <CardDescription>Input tokens</CardDescription>
        <CardTitle class="text-2xl">{data.totals.inputTokens.toLocaleString()}</CardTitle>
      </CardHeader>
    </Card>
    <Card>
      <CardHeader>
        <CardDescription>Output tokens</CardDescription>
        <CardTitle class="text-2xl">{data.totals.outputTokens.toLocaleString()}</CardTitle>
      </CardHeader>
    </Card>
    <Card>
      <CardHeader>
        <CardDescription>Cached tokens</CardDescription>
        <CardTitle class="text-2xl">{data.totals.cachedTokens.toLocaleString()}</CardTitle>
      </CardHeader>
    </Card>
    <Card>
      <CardHeader>
        <CardDescription>Estimated cost</CardDescription>
        <CardTitle class="text-2xl">{fmtUsd(data.totals.costUsd)}</CardTitle>
      </CardHeader>
    </Card>
  </div>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Per day</CardTitle>
    </CardHeader>
    <CardContent>
      {#if data.perDay.length === 0}
        <p class="text-sm text-muted-foreground"><em>No calls recorded yet.</em></p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead>Calls</TableHead>
              <TableHead>Input</TableHead>
              <TableHead>Output</TableHead>
              <TableHead>Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.perDay as d (d.day)}
              <TableRow>
                <TableCell>{d.day}</TableCell>
                <TableCell>{d.calls}</TableCell>
                <TableCell>{d.inputTokens.toLocaleString()}</TableCell>
                <TableCell>{d.outputTokens.toLocaleString()}</TableCell>
                <TableCell>{fmtUsd(d.costUsd)}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>
</div>

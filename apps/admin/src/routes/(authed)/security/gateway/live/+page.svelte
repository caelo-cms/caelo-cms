<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * P13 ideas-pass — live gateway analytics. SSE-driven; one frame
   * every 5s. Top stat cards + per-op table + 60-min sparkline.
   */
  import { Activity, AlertCircle, Bug, Shield } from "lucide-svelte";
  import { onDestroy, onMount } from "svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";
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

  interface Frame {
    windowSec: number;
    overall: {
      requests: number;
      p95Ms: number;
      errorCount: number;
      throttledCount: number;
      honeypotCount: number;
    };
    perOp: Array<{
      pluginSlug: string;
      operation: string;
      requests: number;
      p95Ms: number;
      errorCount: number;
      throttledCount: number;
    }>;
    timeBuckets: Array<{ bucketAt: string; requests: number }>;
  }

  let frame = $state<Frame | null>(null);
  let connected = $state(false);
  let source: EventSource | null = null;

  onMount(() => {
    source = new EventSource("/security/gateway/live");
    source.onopen = () => {
      connected = true;
    };
    source.onerror = () => {
      connected = false;
    };
    source.onmessage = (ev) => {
      try {
        frame = JSON.parse(ev.data) as Frame;
      } catch {
        /* ignore */
      }
    };
  });

  onDestroy(() => {
    source?.close();
  });

  function sparkline(buckets: Array<{ bucketAt: string; requests: number }>, w = 200, h = 40): string {
    if (buckets.length === 0) return "";
    const max = Math.max(...buckets.map((b) => b.requests), 1);
    const stride = w / Math.max(1, buckets.length - 1);
    const points = buckets
      .map((b, i) => `${(i * stride).toFixed(1)},${(h - (b.requests / max) * h).toFixed(1)}`)
      .join(" ");
    return points;
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Activity class="size-6" />
      Live gateway analytics
      {#if connected}
        <Badge>live</Badge>
      {:else}
        <Badge variant="destructive">disconnected</Badge>
      {/if}
    </h1>
    <p class="text-sm text-muted-foreground">
      Rolling 60-minute window; refreshes every 5s via SSE. Returns to
      <a href="/security/gateway" class="underline">/security/gateway</a> for the full request log.
    </p>
  </div>

  {#if !frame}
    <p class="text-sm text-muted-foreground">Waiting for first frame…</p>
  {:else}
    <div class="grid grid-cols-2 gap-4 md:grid-cols-5">
      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium">Requests</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-2xl font-bold">{frame.overall.requests}</p>
          <p class="text-xs text-muted-foreground">last hour</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium">p95 latency</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-2xl font-bold">{frame.overall.p95Ms}ms</p>
          <p class="text-xs text-muted-foreground">95th percentile</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="flex items-center gap-1 text-sm font-medium">
            <AlertCircle class="size-3" /> Errors
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-2xl font-bold">{frame.overall.errorCount}</p>
          <p class="text-xs text-muted-foreground">4xx + 5xx</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="flex items-center gap-1 text-sm font-medium">
            <Shield class="size-3" /> Throttled
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-2xl font-bold">{frame.overall.throttledCount}</p>
          <p class="text-xs text-muted-foreground">rate-limited</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="flex items-center gap-1 text-sm font-medium">
            <Bug class="size-3" /> Honeypot
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-2xl font-bold">{frame.overall.honeypotCount}</p>
          <p class="text-xs text-muted-foreground">bots caught</p>
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>Traffic (per-minute, last hour)</CardTitle>
        <CardDescription>{frame.timeBuckets.length} buckets</CardDescription>
      </CardHeader>
      <CardContent>
        {#if frame.timeBuckets.length === 0}
          <p class="text-sm text-muted-foreground">No traffic in window.</p>
        {:else}
          <svg viewBox="0 0 200 40" class="h-12 w-full" preserveAspectRatio="none">
            <polyline fill="none" stroke="currentColor" stroke-width="1.2" points={sparkline(frame.timeBuckets)} />
          </svg>
        {/if}
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Top ops by request count</CardTitle>
        <CardDescription>{frame.perOp.length} ops</CardDescription>
      </CardHeader>
      <CardContent>
        {#if frame.perOp.length === 0}
          <p class="text-sm text-muted-foreground">No traffic yet.</p>
        {:else}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plugin · op</TableHead>
                <TableHead class="text-right">Requests</TableHead>
                <TableHead class="text-right">p95 ms</TableHead>
                <TableHead class="text-right">Errors</TableHead>
                <TableHead class="text-right">Throttled</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {#each frame.perOp as r (`${r.pluginSlug}-${r.operation}`)}
                <TableRow>
                  <TableCell class="font-mono text-xs">{r.pluginSlug}.{r.operation}</TableCell>
                  <TableCell class="text-right">{r.requests}</TableCell>
                  <TableCell class="text-right">{r.p95Ms}</TableCell>
                  <TableCell class="text-right">{r.errorCount > 0 ? r.errorCount : "—"}</TableCell>
                  <TableCell class="text-right">{r.throttledCount > 0 ? r.throttledCount : "—"}</TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        {/if}
      </CardContent>
    </Card>
  {/if}
</div>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
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

  let { data } = $props();
  function fmtUsd(mc: number): string {
    return `$${(mc / 1e8).toFixed(6)}`;
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Audit · request</h1>
    <p class="text-sm text-muted-foreground">
      Request id: <code>{data.requestId}</code>. Every audit_events + ai_calls row written for one
      HTTP request, ordered by creation. Use this when correlating a structured-log line
      (X-Caelo-Request-Id) to the writes it produced.
    </p>
    <div class="mt-3 text-sm">
      <a class="underline" href="/security/costs">← Cost dashboard</a>
    </div>
  </div>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Audit events ({data.audit.length})</CardTitle>
    </CardHeader>
    <CardContent>
      {#if data.audit.length === 0}
        <p class="text-sm text-muted-foreground">No audit rows for this request id.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Operation</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>OK</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.audit as r (r.id)}
              <TableRow>
                <TableCell class="text-xs">{r.createdAt}</TableCell>
                <TableCell class="font-mono text-xs">{r.operation}</TableCell>
                <TableCell class="font-mono text-xs">{r.actorId.slice(0, 8)}…</TableCell>
                <TableCell>
                  <Badge variant={r.succeeded ? "success" : "destructive"}>
                    {r.succeeded ? "ok" : "fail"}
                  </Badge>
                </TableCell>
                <TableCell class="text-xs">{r.resultSummary ?? "—"}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">AI calls ({data.aiCalls.length})</CardTitle>
      <CardDescription>
        Provider calls that fired during this request. Each row's cost was computed against the
        live ai_pricing table at insert time.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.aiCalls.length === 0}
        <p class="text-sm text-muted-foreground">No AI calls for this request id.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Op</TableHead>
              <TableHead>In/Out</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Plugin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.aiCalls as r (r.id)}
              <TableRow>
                <TableCell class="text-xs">{r.createdAt}</TableCell>
                <TableCell>{r.provider}</TableCell>
                <TableCell class="font-mono text-xs">{r.model}</TableCell>
                <TableCell><Badge variant="outline">{r.operationType}</Badge></TableCell>
                <TableCell class="text-xs"
                  >{r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}</TableCell
                >
                <TableCell>{fmtUsd(r.costMicrocents)}</TableCell>
                <TableCell class="font-mono text-xs">
                  {r.pluginId ? `${r.pluginId.slice(0, 8)}…` : "—"}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>
</div>

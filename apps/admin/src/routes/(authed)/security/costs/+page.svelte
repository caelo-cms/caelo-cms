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
  function fmtUsd(v: number): string {
    return v < 0.01 ? `$${v.toFixed(6)}` : `$${v.toFixed(4)}`;
  }
  function fmtUsdMc(mc: number | null): string {
    if (mc === null) return "—";
    return `$${(mc / 1e8).toFixed(2)}`;
  }
  function statusVariant(s: string): "success" | "warning" | "destructive" | "outline" {
    if (s === "ok") return "success";
    if (s === "warn") return "warning";
    if (s === "blocked") return "destructive";
    return "outline";
  }
  function attrVariant(k: string): "outline" | "secondary" | "destructive" {
    if (k === "plugin") return "destructive";
    if (k === "subagent") return "secondary";
    return "outline";
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">AI cost dashboard</h1>
    <p class="text-sm text-muted-foreground">
      Per-call token + cost accounting from the chat surface, last 30 days. Costs computed from the
      live <a class="underline" href="/security/ai/pricing">pricing table</a> at insert time.
      Budgets enforced independently per operation type — see <a
        class="underline"
        href="/security/ai/budgets">budgets</a
      > to adjust.
    </p>
  </div>

  <!-- Panel 1: Totals -->
  <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
    <Card>
      <CardHeader>
        <CardDescription>Calls</CardDescription>
        <CardTitle class="text-2xl">{data.agg.totals.calls}</CardTitle>
      </CardHeader>
    </Card>
    <Card>
      <CardHeader>
        <CardDescription>Input tokens</CardDescription>
        <CardTitle class="text-2xl">{data.agg.totals.inputTokens.toLocaleString()}</CardTitle>
      </CardHeader>
    </Card>
    <Card>
      <CardHeader>
        <CardDescription>Output tokens</CardDescription>
        <CardTitle class="text-2xl">{data.agg.totals.outputTokens.toLocaleString()}</CardTitle>
      </CardHeader>
    </Card>
    <Card>
      <CardHeader>
        <CardDescription>Cached tokens</CardDescription>
        <CardTitle class="text-2xl">{data.agg.totals.cachedTokens.toLocaleString()}</CardTitle>
      </CardHeader>
    </Card>
    <Card>
      <CardHeader>
        <CardDescription>Estimated cost</CardDescription>
        <CardTitle class="text-2xl">{fmtUsd(data.agg.totals.costUsd)}</CardTitle>
      </CardHeader>
    </Card>
  </div>

  <!-- Panel 2: Budget status -->
  <Card>
    <CardHeader>
      <CardTitle class="text-base">Budget status</CardTitle>
      <CardDescription>
        Independent text vs image enforcement. Blocking caps fail with a structured error before the
        provider call. Session-scope spend is tracked on chat_sessions, not on this aggregate.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.budgetStatus.length === 0}
        <p class="text-sm text-muted-foreground">No budgets configured.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Scope</TableHead>
              <TableHead>Operation</TableHead>
              <TableHead>Cap</TableHead>
              <TableHead>Spent (24h)</TableHead>
              <TableHead>%</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.budgetStatus as row (`${row.scope}-${row.operationType}`)}
              <TableRow>
                <TableCell>{row.scope}</TableCell>
                <TableCell><Badge variant="outline">{row.operationType}</Badge></TableCell>
                <TableCell>{fmtUsdMc(row.capMicrocents)}</TableCell>
                <TableCell>{fmtUsdMc(row.spentMicrocents)}</TableCell>
                <TableCell>
                  {row.pct === null ? "—" : `${(row.pct * 100).toFixed(0)}%`}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>

  <!-- Panel 3: Per-day -->
  <Card>
    <CardHeader>
      <CardTitle class="text-base">Per day (last 60 days, descending)</CardTitle>
    </CardHeader>
    <CardContent>
      {#if data.agg.perDay.length === 0}
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
            {#each data.agg.perDay as d (d.day)}
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

  <div class="grid gap-6 md:grid-cols-2">
    <!-- Panel 4: Per provider/model/operation -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Per provider · model · operation</CardTitle>
        <CardDescription>Top 30 by spend.</CardDescription>
      </CardHeader>
      <CardContent>
        {#if data.agg.perProvider.length === 0}
          <p class="text-sm text-muted-foreground">No data yet.</p>
        {:else}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Op</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {#each data.agg.perProvider as r}
                <TableRow>
                  <TableCell>{r.provider}</TableCell>
                  <TableCell class="font-mono text-xs">{r.model}</TableCell>
                  <TableCell><Badge variant="outline">{r.operationType}</Badge></TableCell>
                  <TableCell>{r.calls}</TableCell>
                  <TableCell>{fmtUsd(r.costUsd)}</TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        {/if}
      </CardContent>
    </Card>

    <!-- Panel 5: Per plugin -->
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Per plugin</CardTitle>
        <CardDescription>Top 20 by spend. Empty plugin = chat-runner / direct call.</CardDescription>
      </CardHeader>
      <CardContent>
        {#if data.agg.perPlugin.length === 0}
          <p class="text-sm text-muted-foreground">No data yet.</p>
        {:else}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plugin</TableHead>
                <TableHead>Calls</TableHead>
                <TableHead>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {#each data.agg.perPlugin as r}
                <TableRow>
                  <TableCell>
                    {#if r.pluginSlug}
                      <a class="underline" href="/security/plugins/{r.pluginSlug}"
                        >{r.pluginSlug}</a
                      >
                    {:else}
                      <span class="text-muted-foreground">— (chat-runner)</span>
                    {/if}
                  </TableCell>
                  <TableCell>{r.calls}</TableCell>
                  <TableCell>{fmtUsd(r.costUsd)}</TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        {/if}
      </CardContent>
    </Card>
  </div>

  <!-- P16 hardening — cap-lookup health: surfaces fail-closed trips so
       silent enforcement bypass under DB pressure becomes operator-visible. -->
  {#if data.capLookupHealth.totalTrips > 0 || data.capLookupHealth.trippedKeys.length > 0}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          Cap-lookup health
          <Badge variant="destructive">attention</Badge>
        </CardTitle>
        <CardDescription>
          {data.capLookupHealth.totalTrips} fail-closed trip(s) since process start.
          {#if data.capLookupHealth.trippedKeys.length > 0}
            Currently failing closed: {data.capLookupHealth.trippedKeys.length} key(s).
          {/if}
          A trip means cap-lookup queries failed repeatedly so AI calls are blocked to protect the
          budget. Investigate Postgres health.
        </CardDescription>
      </CardHeader>
      {#if data.capLookupHealth.trippedKeys.length > 0}
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Consecutive failures</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {#each data.capLookupHealth.trippedKeys as t}
                <TableRow>
                  <TableCell class="font-mono text-xs">{t.key}</TableCell>
                  <TableCell>{t.consecutiveFailures}</TableCell>
                </TableRow>
              {/each}
            </TableBody>
          </Table>
        </CardContent>
      {/if}
    </Card>
  {/if}

  <!-- P16 hardening — unified attribution view: identifies WHO drove
       a spend bucket (plugin / user / subagent / system) without
       cross-referencing audit_events. -->
  <Card>
    <CardHeader>
      <CardTitle class="text-base">Spend attribution</CardTitle>
      <CardDescription>
        Top 50 sources by spend. <Badge variant="destructive">plugin</Badge> = Tier-1 plugin call ·
        <Badge variant="secondary">subagent</Badge> = spawn_subagent run ·
        <Badge variant="outline">user</Badge> = chat-runner under that user's session.
      </CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.agg.perAttribution.length === 0}
        <p class="text-sm text-muted-foreground">No data yet.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Calls</TableHead>
              <TableHead>Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.agg.perAttribution as r}
              <TableRow>
                <TableCell><Badge variant={attrVariant(r.kind)}>{r.kind}</Badge></TableCell>
                <TableCell class="font-mono text-xs">{r.label}</TableCell>
                <TableCell>{r.calls}</TableCell>
                <TableCell>{fmtUsd(r.costUsd)}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>

  <!-- Panel 5b: Per operation_type roll-up (for the "text vs image" view) -->
  <Card>
    <CardHeader>
      <CardTitle class="text-base">Operation-type roll-up</CardTitle>
      <CardDescription>Text and image are budgeted independently.</CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.agg.perOperationType.length === 0}
        <p class="text-sm text-muted-foreground">No data yet.</p>
      {:else}
        <div class="grid gap-4 md:grid-cols-2">
          {#each data.agg.perOperationType as r}
            <Card>
              <CardHeader>
                <CardDescription>{r.operationType}</CardDescription>
                <CardTitle class="text-xl">
                  {fmtUsd(r.costUsd)} · {r.calls} calls
                </CardTitle>
              </CardHeader>
            </Card>
          {/each}
        </div>
      {/if}
    </CardContent>
  </Card>
</div>

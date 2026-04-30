<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P10.5 — Owner observability for subagent runs. Lists every spawn
   * with role + status + cost + duration + click-through to the
   * ephemeral chat session's transcript (chat_messages table).
   */

  import { Sparkles } from "lucide-svelte";
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

  function statusClass(status: string): string {
    switch (status) {
      case "completed":
        return "text-green-700 dark:text-green-400";
      case "errored":
      case "timed_out":
        return "text-red-700 dark:text-red-400";
      case "running":
      case "pending":
        return "text-blue-700 dark:text-blue-400";
      default:
        return "text-muted-foreground";
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Sparkles class="size-6" />
      Subagent runs
    </h1>
    <p class="text-sm text-muted-foreground">
      Every <code>spawn_subagent</code> + <code>spawn_subagents</code> tool call lands here. Each subagent ran in
      its own ephemeral chat session — the transcript is queryable for debugging. Costs roll up into
      the AI cost dashboard via the <code>parent_chat_session_id</code> link on <code>ai_calls</code>.
    </p>
  </div>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Recent runs ({data.runs.length})</CardTitle>
      <CardDescription>Sorted by creation time, most recent first.</CardDescription>
    </CardHeader>
    <CardContent>
      {#if data.runs.length === 0}
        <p class="text-sm text-muted-foreground">
          No subagent runs yet. They'll appear here as the AI calls <code>spawn_subagent</code> /
          <code>spawn_subagents</code>.
        </p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Task</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each data.runs as r (r.id)}
              <TableRow>
                <TableCell class="font-mono text-xs">{r.role}</TableCell>
                <TableCell class={statusClass(r.status)}>
                  <span class="font-mono">{r.status}</span>
                  {#if r.errorMessage}
                    <span class="ml-1 text-xs">⚠</span>
                  {/if}
                </TableCell>
                <TableCell class="text-xs">${(r.costMicrocents / 1e8).toFixed(4)}</TableCell>
                <TableCell class="text-xs">{r.durationMs}ms</TableCell>
                <TableCell class="text-xs text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString()}
                </TableCell>
                <TableCell class="max-w-md truncate text-xs">{r.task}</TableCell>
              </TableRow>
              {#if r.errorMessage || r.resultJson}
                <TableRow>
                  <TableCell colspan="6" class="text-xs">
                    <details>
                      <summary class="cursor-pointer text-muted-foreground">
                        {r.errorMessage ? `error: ${r.errorMessage}` : "result"}
                      </summary>
                      <pre class="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs">{JSON.stringify(r.resultJson, null, 2)}</pre>
                    </details>
                  </TableCell>
                </TableRow>
              {/if}
            {/each}
          </TableBody>
        </Table>
      {/if}
    </CardContent>
  </Card>
</div>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * v0.2.46 — debug panel for the chat. Surfaces what flowed through
   * the SSE stream during the most recent turn so an Owner can answer
   * "what did the AI just do?" without opening /security/audit.
   *
   * Surface (this version):
   *   - Tool calls timeline: tool-start + tool-result events as a
   *     compact list with the full arguments + a result excerpt.
   *   - Token usage: aggregated from all `usage` events of the turn.
   *   - "Copy as JSON" button: serializes the full captured event log
   *     for paste into a bug report.
   *
   * Surface (deferred to a follow-up that needs runner changes):
   *   - System-prompt chunks emitted (would need a `system-prompt`
   *     SSE event behind a debug flag from the runner).
   *   - Engaged-skills + match reasons (same).
   *
   * Visibility: the parent (ChatPanel) gates this behind the `debug`
   * URL flag + a permission check before mounting.
   */

  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import type { DebugToolCall, DebugUsage } from "./debug-types.js";

  interface Props {
    toolCalls: DebugToolCall[];
    usage: DebugUsage;
    rawEvents: unknown[];
  }
  let { toolCalls, usage, rawEvents }: Props = $props();

  function copyJson(): void {
    void navigator.clipboard.writeText(
      JSON.stringify({ toolCalls, usage, rawEvents }, null, 2),
    );
  }
</script>

<Card data-testid="chat-debug-panel">
  <CardHeader>
    <CardTitle class="flex items-center justify-between text-base">
      <span>Debug</span>
      <Button type="button" size="sm" variant="outline" onclick={copyJson}>Copy as JSON</Button>
    </CardTitle>
  </CardHeader>
  <CardContent class="space-y-3 text-xs">
    <div>
      <div class="mb-1 text-[10px] font-medium uppercase text-muted-foreground">Usage</div>
      <div class="flex flex-wrap gap-1.5">
        <Badge variant="outline">in: {usage.inputTokens}</Badge>
        <Badge variant="outline">out: {usage.outputTokens}</Badge>
        {#if usage.cachedTokens > 0}
          <Badge variant="secondary">cached: {usage.cachedTokens}</Badge>
        {/if}
        <Badge>${(usage.cost).toFixed(4)}</Badge>
      </div>
    </div>

    <div>
      <div class="mb-1 text-[10px] font-medium uppercase text-muted-foreground">
        Tool calls ({toolCalls.length})
      </div>
      {#if toolCalls.length === 0}
        <p class="text-muted-foreground">(none yet)</p>
      {:else}
        <ol class="space-y-1.5">
          {#each toolCalls as tc (tc.toolCallId)}
            <li class="rounded border bg-muted/40 p-2 font-mono">
              <div class="flex items-center gap-2">
                <span class="font-semibold">{tc.name}</span>
                {#if tc.result}
                  <Badge variant={tc.result.ok ? "default" : "destructive"}>
                    {tc.result.ok ? "ok" : "fail"}
                  </Badge>
                  {#if tc.endedAt && tc.startedAt}
                    <span class="ml-auto text-[10px] text-muted-foreground">
                      {tc.endedAt - tc.startedAt}ms
                    </span>
                  {/if}
                {:else}
                  <Badge variant="secondary">running…</Badge>
                {/if}
              </div>
              <details class="mt-1">
                <summary class="cursor-pointer text-[10px] text-muted-foreground">args</summary>
                <pre class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px]">{JSON.stringify(tc.args, null, 2)}</pre>
              </details>
              {#if tc.result}
                <details class="mt-1">
                  <summary class="cursor-pointer text-[10px] text-muted-foreground">result</summary>
                  <pre
                    class="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px]">{tc.result.content}</pre>
                </details>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </CardContent>
</Card>

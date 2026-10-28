<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Issues #664 / #665 — admin-header indicator: how many AI agents are
   * working right now across the operator's chats (all chats for a site
   * administrator), including ones started in another tab, by another
   * client or by an external MCP agent. Click opens the list with a Stop
   * per entry and a link to the chat. Hidden while nothing runs.
   *
   * #1215 — no timer polling: re-read on every `agents` live topic (from a
   * chat stream of this tab or, while an agent runs, the live-events wait),
   * when the tab regains focus and after a Stop / Allow here.
   */

  import { Bot, Square } from "lucide-svelte";
  import { onDestroy, onMount } from "svelte";
  import { coalescedRefresh } from "#lib/components/edit/coalesced-refresh.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Card, CardContent } from "#lib/components/ui/card/index.js";
  import { liveHub } from "#lib/live/live-refresh.js";
  import {
    type AgentRunView,
    activeRuns,
    fetchAgentRuns,
    postAgentAction,
    runStatusText,
  } from "./agent-runs-client.js";

  interface Props {
    csrfToken: string;
  }
  let { csrfToken }: Props = $props();

  let runs = $state<AgentRunView[]>([]);
  let open = $state(false);
  let nowMs = $state(Date.now());
  let actionError = $state<string | null>(null);
  let rootEl: HTMLDivElement | null = $state(null);
  let unregister: (() => void) | null = null;

  // One read on the wire at a time; a call meanwhile re-reads once after it.
  const refresh = coalescedRefresh(async () => {
    const next = await fetchAgentRuns();
    if (next) runs = next;
    nowMs = Date.now();
    liveHub.kick();
  });

  async function act(run: AgentRunView, action: "cancel" | "allow"): Promise<void> {
    actionError = await postAgentAction({
      csrfToken,
      chatSessionId: run.chatSessionId,
      action,
      runId: run.id,
    });
    await refresh();
  }

  function onDocClick(e: MouseEvent): void {
    if (open && rootEl && !rootEl.contains(e.target as Node)) open = false;
  }

  onMount(() => {
    void refresh();
    unregister = liveHub.register({
      topics: ["agents"],
      refresh: () => void refresh(),
      waiting: () => activeRuns(runs).length > 0,
    });
    document.addEventListener("click", onDocClick);
  });
  onDestroy(() => {
    unregister?.();
    if (typeof document !== "undefined") document.removeEventListener("click", onDocClick);
  });

  const active = $derived(activeRuns(runs));
  // Ages in the open list tick locally while an agent runs; no request.
  $effect(() => {
    if (!open || active.length === 0) return;
    const id = setInterval(() => (nowMs = Date.now()), 1000);
    return () => clearInterval(id);
  });
</script>

{#if runs.length > 0}
  <div class="relative" bind:this={rootEl}>
    <Button
      variant="ghost"
      size="sm"
      class="gap-1.5 text-xs"
      aria-expanded={open}
      data-testid="header-agents-indicator"
      onclick={(e) => {
        e.stopPropagation();
        open = !open;
      }}
    >
      <Bot class="size-4 {active.length > 0 ? 'animate-pulse text-amber-700 dark:text-amber-400' : ''}" />
      {active.length > 0 ? `${active.length} agent${active.length === 1 ? "" : "s"} running` : "Agents"}
    </Button>
    {#if open}
      <div class="absolute right-0 z-40 mt-2 w-96">
        <Card>
          <CardContent class="space-y-2 p-3 text-sm">
            <ul class="space-y-2">
              {#each runs as run (run.id)}
                <li class="flex items-start gap-2" data-testid="header-agent-row">
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-medium">{run.label}</div>
                    <a
                      href={`/content/chat/${run.chatSessionId}`}
                      class="block truncate text-xs text-muted-foreground underline-offset-4 hover:underline"
                      onclick={() => (open = false)}>{run.chatTitle}</a
                    >
                    <div class="text-xs text-muted-foreground">{runStatusText(run, nowMs)}</div>
                  </div>
                  {#if run.state === "stopped"}
                    <!-- The block never expires; whoever may stop it here may
                         lift it here too (the chat itself may be another
                         operator's). -->
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      class="h-6 px-2 text-xs"
                      data-testid="header-agent-allow"
                      title="Let this external agent work in that chat again"
                      onclick={() => void act(run, "allow")}
                    >
                      Allow again
                    </Button>
                  {:else if !run.cancelRequested}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      class="h-6 px-2 text-xs"
                      data-testid="header-agent-stop"
                      onclick={() => void act(run, "cancel")}
                    >
                      <Square class="mr-1 size-3 fill-current" /> Stop
                    </Button>
                  {/if}
                </li>
              {/each}
            </ul>
            {#if actionError}
              <p role="alert" class="text-xs text-destructive">{actionError}</p>
            {/if}
          </CardContent>
        </Card>
      </div>
    {/if}
  </div>
{/if}

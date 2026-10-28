<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Issues #664 / #665 — every AI agent working in THIS chat, with a Stop
   * for each: the Live Edit AI (running or queued turns, also ones another
   * tab or client started), its subagents, external MCP agents. Work the
   * panel's own stream knows nothing about still shows up: the list is
   * re-read on every `agents` live topic (#1215 — from this tab's stream or,
   * while another agent works here, from the live-events wait) and when the
   * tab regains focus; it polls nothing on a timer. A stopped external agent
   * stays listed with "Allow again" — it is blocked in this chat until the
   * operator lifts it.
   */

  import { Bot, Square } from "lucide-svelte";
  import { coalescedRefresh } from "#lib/components/edit/coalesced-refresh.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { liveHub } from "#lib/live/live-refresh.js";
  import {
    type AgentRunView,
    activeRuns,
    fetchAgentRuns,
    postAgentAction,
    runStatusText,
  } from "./agent-runs-client.js";

  interface Props {
    chatSessionId: string;
    csrfToken: string;
    /** Bump to re-read now (after a send, a Stop, a stream end). */
    refreshKey?: number;
  }
  let { chatSessionId, csrfToken, refreshKey = 0 }: Props = $props();

  let runs = $state<AgentRunView[]>([]);
  let nowMs = $state(Date.now());
  let busy = $state<Record<string, boolean>>({});
  let actionError = $state<string | null>(null);

  // One read on the wire at a time; a call meanwhile re-reads once after it.
  const refresh = coalescedRefresh(async () => {
    const next = await fetchAgentRuns(chatSessionId);
    if (next) runs = next;
    nowMs = Date.now();
    liveHub.kick();
  });

  $effect(() => {
    // Re-read whenever the parent bumps refreshKey or the chat changes.
    void refreshKey;
    void chatSessionId;
    void refresh();
  });
  $effect(() =>
    liveHub.register({
      topics: ["agents"],
      refresh: () => void refresh(),
      // An agent works here: its changes come from no stream of this tab.
      waiting: () => activeRuns(runs).length > 0,
    }),
  );
  // The "working · 2 min" ages tick locally while an agent runs; no request.
  $effect(() => {
    if (activeRuns(runs).length === 0) return;
    const id = setInterval(() => (nowMs = Date.now()), 1000);
    return () => clearInterval(id);
  });

  async function act(action: "cancel" | "allow", runId?: string): Promise<void> {
    const key = runId ?? "all";
    busy = { ...busy, [key]: true };
    actionError = await postAgentAction({ csrfToken, chatSessionId, action, ...(runId ? { runId } : {}) });
    busy = { ...busy, [key]: false };
    await refresh();
    // The operator's own Stop / Allow: a failed wait may wait again.
    liveHub.resume();
  }

  const active = $derived(activeRuns(runs));
</script>

{#if runs.length > 0}
  <div
    class="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs"
    data-testid="chat-agents-bar"
    role="status"
    aria-live="polite"
  >
    <div class="flex items-center gap-2">
      <Bot class="size-3.5" />
      <span class="font-medium">
        {active.length > 0
          ? `${active.length} agent${active.length === 1 ? "" : "s"} working in this chat`
          : "Agents in this chat"}
      </span>
      {#if active.length > 1}
        <Button
          type="button"
          size="sm"
          variant="destructive"
          class="ml-auto h-6 px-2 text-xs"
          disabled={busy.all}
          data-testid="chat-agents-stop-all"
          onclick={() => void act("cancel")}
        >
          <Square class="mr-1 size-3 fill-current" /> Stop all
        </Button>
      {/if}
    </div>
    <ul class="space-y-1">
      {#each runs as run (run.id)}
        <li class="flex items-center gap-2" data-testid="chat-agent-row" data-kind={run.kind} data-state={run.state}>
          <span class="min-w-0 truncate" class:pl-4={run.kind === "subagent"}>{run.label}</span>
          <span class="text-muted-foreground">{runStatusText(run, nowMs)}</span>
          {#if run.state === "stopped"}
            <Button
              type="button"
              size="sm"
              variant="outline"
              class="ml-auto h-6 px-2 text-xs"
              disabled={busy[run.id]}
              data-testid="chat-agent-allow"
              title="Let this external agent work in this chat again"
              onclick={() => void act("allow", run.id)}
            >
              Allow again
            </Button>
          {:else if !run.cancelRequested}
            <Button
              type="button"
              size="sm"
              variant="outline"
              class="ml-auto h-6 px-2 text-xs"
              disabled={busy[run.id]}
              data-testid="chat-agent-stop"
              title={run.kind === "mcp"
                ? "Stop the external agent — its next call in this chat is refused until you allow it again"
                : "Stop this agent"}
              onclick={() => void act("cancel", run.id)}
            >
              <Square class="mr-1 size-3 fill-current" /> Stop
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if actionError}
      <p role="alert" class="text-destructive">{actionError}</p>
    {/if}
  </div>
{/if}

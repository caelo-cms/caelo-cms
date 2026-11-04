<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #1008 — what the running servers make of a plugin's status: running,
   * failing (with the reason), waiting for the Owner to approve new
   * capabilities (#1306, with their names), or not yet reported, plus its
   * recent errors.
   * A failing plugin stays active — the Owner's decision is never undone by
   * a load error — so this is where the problem becomes visible instead.
   */

  import { Badge } from "#lib/components/ui/badge/index.js";

  interface PluginErrorSummary {
    phase: string;
    errorClass: "transient" | "plugin" | "core";
    message: string;
    occurrences: number;
    lastSeenAt: string;
    /** What became of the bug report (admin-core ops/plugins/health.ts). */
    report: "none" | "local" | "queued" | "sent" | "failed";
  }

  interface Props {
    slug: string;
    health: {
      state: "running" | "failing" | "awaiting_approval" | "unreported" | "not_running";
      servers: { loaded: number; failing: number };
      awaitingCapabilities: string[];
      awaitingRelease: boolean;
      problem: PluginErrorSummary | null;
      recentErrors: PluginErrorSummary[];
      /** #1390 — its change consumer waits out a failure backoff. */
      consumerBackoff: { consecutiveFailures: number; nextRetryAt: string; lastError: string } | null;
      callCost: {
        since: string | null;
        calls: number;
        totalMs: number;
        ops: { op: string; calls: number; totalMs: number; maxMs: number }[];
      };
    };
  }

  let { slug, health }: Props = $props();

  const label = $derived(
    {
      running: "Running",
      failing: "Not loading",
      awaiting_approval: "Waiting for your approval",
      unreported: "Starting",
      not_running: "Not running",
    }[health.state],
  );

  /** A duration in the unit a person reads it in. */
  function duration(ms: number): string {
    if (ms < 1_000) return `${ms} ms`;
    if (ms < 120_000) return `${(ms / 1_000).toFixed(1)} s`;
    return `${(ms / 60_000).toFixed(1)} min`;
  }

  /** Who has to act, in the Owner's words. */
  function owner(e: PluginErrorSummary): string {
    if (e.errorClass === "core") {
      // Only `sent` means the Caelo team has it; with bug forwarding off
      // (the default) the report stays on this site.
      switch (e.report) {
        case "sent":
          return "Caelo problem, sent to the Caelo team";
        case "queued":
          return "Caelo problem, recorded on this site and about to be sent to the Caelo team";
        case "failed":
          return "Caelo problem, recorded on this site (sending it to the Caelo team failed)";
        case "local":
          return "Caelo problem, recorded on this site (not sent: bug forwarding is off)";
        case "none":
          return "Caelo problem";
      }
    }
    if (e.errorClass === "plugin") return "Problem in the plugin's code";
    return "Temporary problem, retried";
  }
</script>

<div class="space-y-1" data-testid="plugin-health-{slug}">
  <Badge
    variant={health.state === "failing" ? "destructive" : health.state === "running" ? "default" : "secondary"}
    data-testid="plugin-health-state-{slug}"
  >
    {label}
  </Badge>
  {#if health.state === "failing"}
    <p class="text-xs text-muted-foreground">
      {health.servers.failing} of {health.servers.loaded + health.servers.failing} servers could not load it.
      It stays active; the rest of the site keeps working.
    </p>
  {/if}
  {#if health.state === "awaiting_approval"}
    <p class="max-w-md text-xs" data-testid="plugin-health-awaiting-{slug}">
      Not running: this version needs your approval
      {#if health.awaitingCapabilities.length > 0}
        for <span class="font-mono">{health.awaitingCapabilities.join(", ")}</span>
      {/if}
      {#if health.awaitingRelease}
        {health.awaitingCapabilities.length > 0 ? "and" : "because"} it changes what the plugin declares
      {/if}. Review it to start it.
    </p>
  {/if}
  {#if health.problem}
    <p class="max-w-md text-xs text-red-700 dark:text-red-400" data-testid="plugin-health-problem-{slug}">
      {owner(health.problem)}: {health.problem.message}
    </p>
  {/if}
  {#if health.consumerBackoff}
    <p class="max-w-md text-xs text-amber-700 dark:text-amber-400" data-testid="plugin-health-backoff-{slug}">
      Reacting to site changes failed {health.consumerBackoff.consecutiveFailures}× in a row; it tries again at
      {new Date(health.consumerBackoff.nextRetryAt).toLocaleTimeString()}. Nothing is lost, and other plugins keep
      running. Last error: <code class="break-all">{health.consumerBackoff.lastError}</code>
    </p>
  {/if}
  {#if health.callCost.calls > 0}
    <details class="text-xs" data-testid="plugin-health-cost-{slug}">
      <summary class="cursor-pointer text-muted-foreground">
        Time in calls to Caelo and its own storage: {duration(health.callCost.totalMs)} over {health.callCost.calls} calls (including the wait for a database connection)
        {#if health.callCost.since}since {new Date(health.callCost.since).toLocaleString()}{/if}
      </summary>
      <table class="mt-1 max-w-md">
        <thead class="text-muted-foreground">
          <tr><th class="pr-3 text-left font-normal">Operation</th><th class="pr-3 text-right font-normal">Calls</th><th class="pr-3 text-right font-normal">Total</th><th class="text-right font-normal">Longest</th></tr>
        </thead>
        <tbody>
          {#each health.callCost.ops as o (o.op)}
            <tr>
              <td class="pr-3 font-mono">{o.op}</td>
              <td class="pr-3 text-right">{o.calls}</td>
              <td class="pr-3 text-right">{duration(o.totalMs)}</td>
              <td class="text-right">{duration(o.maxMs)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </details>
  {/if}
  {#if health.recentErrors.length > 0}
    <details class="text-xs">
      <summary class="cursor-pointer text-muted-foreground">
        {health.recentErrors.length} recent error{health.recentErrors.length === 1 ? "" : "s"}
      </summary>
      <ul class="mt-1 max-w-md list-disc space-y-1 pl-5">
        {#each health.recentErrors as e, i (i)}
          <li>
            <span class="text-muted-foreground">
              {new Date(e.lastSeenAt).toLocaleString()} · {e.phase} · {owner(e)} · {e.occurrences}×
            </span>
            <br />
            <code class="break-all">{e.message}</code>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</div>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #1008 — what the running servers make of a plugin's status: running,
   * failing (with the reason), or not yet reported, plus its recent errors.
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
      state: "running" | "failing" | "unreported" | "not_running";
      servers: { loaded: number; failing: number };
      problem: PluginErrorSummary | null;
      recentErrors: PluginErrorSummary[];
    };
  }

  let { slug, health }: Props = $props();

  const label = $derived(
    {
      running: "Running",
      failing: "Not loading",
      unreported: "Starting",
      not_running: "Not running",
    }[health.state],
  );

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
  {#if health.problem}
    <p class="max-w-md text-xs text-red-700 dark:text-red-400" data-testid="plugin-health-problem-{slug}">
      {owner(health.problem)}: {health.problem.message}
    </p>
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

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #696 — the live timeline of one update: the request's state plus every
   * line the upgrader job wrote, grouped by phase. While the update waits or
   * runs it polls /settings/updates/progress, which reads the database only,
   * so it keeps working while the admin itself restarts onto the new release
   * (failed polls during that minute are expected and retried).
   */

  import type { PlatformUpdateEvent, PlatformUpdateRequest } from "@caelo-cms/admin-core";
  import { CircleAlert, CircleCheck, LoaderCircle, TriangleAlert } from "lucide-svelte";
  import { untrack } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { isActive, PHASE_LABELS, statusDisplay } from "#lib/updates-display.js";

  let {
    request: initialRequest,
    events: initialEvents,
    selfHosted = false,
  }: {
    request: PlatformUpdateRequest;
    events: PlatformUpdateEvent[];
    /** A self-hosted install (its hand-run upgrade is on the server). */
    selfHosted?: boolean;
  } = $props();

  // Seeded once from the page's load; the poll below owns them afterwards
  // (the page re-keys this component when a new request appears).
  let request = $state(untrack(() => initialRequest));
  let events = $state(untrack(() => initialEvents));
  let reconnecting = $state(false);

  $effect(() => {
    if (!isActive(request.status)) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/settings/updates/progress?requestId=${request.id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          request: PlatformUpdateRequest | null;
          events: PlatformUpdateEvent[];
        };
        if (stopped || !body.request) return;
        reconnecting = false;
        const ended = !isActive(body.request.status);
        request = body.request;
        events = body.events;
        // The rest of the page (install controls, the Cloud Shell step,
        // history) follows the request's end state.
        if (ended) await invalidateAll();
      } catch {
        // The admin restarts during a roll; keep trying.
        reconnecting = true;
      }
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  });

  const groups = $derived.by(() => {
    const out: { phase: PlatformUpdateEvent["phase"]; lines: PlatformUpdateEvent[] }[] = [];
    for (const e of events) {
      const last = out.at(-1);
      if (last && last.phase === e.phase) last.lines.push(e);
      else out.push({ phase: e.phase, lines: [e] });
    }
    return out;
  });
  const display = $derived(statusDisplay(request.status, selfHosted));

  function time(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
</script>

<div class="space-y-3" data-testid="update-timeline">
  <div class="flex flex-wrap items-center gap-2 text-sm">
    <span class="font-medium">v{request.fromVersion} → v{request.targetVersion}</span>
    <Badge variant={display.tone} data-testid="update-status">{display.label}</Badge>
    {#if isActive(request.status)}
      <LoaderCircle class="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
    {/if}
  </div>
  {#if reconnecting && isActive(request.status)}
    <p class="text-xs text-muted-foreground">
      The admin is switching to the new version — reconnecting…
    </p>
  {/if}
  {#if request.statusReason && !isActive(request.status)}
    <p class="text-sm" data-testid="update-reason">{request.statusReason}</p>
  {/if}
  <ol class="space-y-3 border-l pl-4">
    {#each groups as group, i (`${group.phase}-${i}`)}
      <li data-testid="timeline-phase" data-phase={group.phase}>
        <p class="text-sm font-medium">{PHASE_LABELS[group.phase]}</p>
        <ul class="mt-1 space-y-1">
          {#each group.lines as line (line.id)}
            <li class="flex gap-2 text-xs text-muted-foreground">
              <span class="shrink-0 font-mono">{time(line.at)}</span>
              {#if line.level === "success"}
                <CircleCheck class="size-3.5 shrink-0 text-green-700" aria-label="done" />
              {:else if line.level === "warn"}
                <TriangleAlert class="size-3.5 shrink-0 text-amber-700" aria-label="warning" />
              {:else if line.level === "error"}
                <CircleAlert class="size-3.5 shrink-0 text-destructive" aria-label="error" />
              {/if}
              <span class="min-w-0 whitespace-pre-wrap break-words">{line.message}</span>
            </li>
          {/each}
        </ul>
      </li>
    {/each}
  </ol>
</div>

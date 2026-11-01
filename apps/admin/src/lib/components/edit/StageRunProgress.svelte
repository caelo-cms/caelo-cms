<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * #1288 — the running Stage's step, page progress and estimated time
   * left, inside the Staging menu. Mounted only while the menu is open, so
   * a closed menu reads nothing. Re-read on the `deploys` live topic (a
   * progress write, the run's end) and on focus; while the Stage runs the
   * live hub holds its wait — no timer (CLAUDE.md §11.B, #1215).
   */
  import { describeStageRun, type StageStatusRun } from "@caelo-cms/shared";
  import { LoaderCircle } from "lucide-svelte";
  import { onDestroy, onMount } from "svelte";
  import { Progress } from "#lib/components/ui/progress/index.js";
  import { liveFetch, liveHub } from "#lib/live/live-refresh.js";
  import { coalescedRefresh } from "./coalesced-refresh.js";

  let run = $state<StageStatusRun | null>(null);
  let error = $state<string | null>(null);
  const inFlight = $derived(run?.status === "queued" || run?.status === "running");

  const refetch = coalescedRefresh(async () => {
    if (document.visibilityState !== "visible") return;
    try {
      const r = await liveFetch("/api/stage-status?limit=1", {
        headers: { accept: "application/json" },
      });
      const body = (await r.json()) as { runs?: StageStatusRun[]; error?: string };
      if (!r.ok) {
        error = body.error ?? `The Stage status could not be read (HTTP ${r.status}).`;
        return;
      }
      error = null;
      run = body.runs?.[0] ?? null;
    } catch (e) {
      error = `The Stage status could not be read: ${e instanceof Error ? e.message : String(e)}`;
    }
    liveHub.kick();
  });

  let unregister: (() => void) | null = null;
  onMount(() => {
    void refetch();
    unregister = liveHub.register({
      topics: ["deploys"],
      refresh: () => void refetch(),
      waiting: () => inFlight,
    });
  });
  onDestroy(() => unregister?.());
</script>

{#if error}
  <p class="text-xs text-destructive" role="alert" data-testid="stage-run-progress-error">{error}</p>
{:else if run && inFlight}
  <div class="space-y-1.5 rounded-md border p-2" aria-live="polite" data-testid="stage-run-progress">
    <p class="flex items-center gap-1.5 text-xs font-medium">
      <LoaderCircle class="size-3.5 animate-spin motion-reduce:animate-none" />
      Stage running
    </p>
    {#if run.phase === "building" && run.pagesTotal}
      <Progress value={run.pagesDone ?? 0} max={Math.max(1, run.pagesTotal)} />
    {/if}
    <p class="text-xs text-muted-foreground" data-testid="stage-run-progress-text">
      {describeStageRun(run)}
    </p>
  </div>
{/if}

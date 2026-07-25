<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * edit_content result card — renders the surgical string-replace edits as
   * a minimal old→new diff (CLAUDE.md §8 "preview diffs must be minimal").
   * The hunks come from the tool's own args (`edits`), so no full before/after
   * body has to cross the wire — the whole point of edit_content.
   *
   * A template edit is §11.A-gated: its result is a "Queued proposal …"
   * string routed to ProposeCard by the router, so this card only ever sees
   * applied (module) or non-gated edits.
   */

  import { Scissors } from "lucide-svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";

  interface Props {
    content: string;
    args: Record<string, unknown>;
  }
  let { content, args }: Props = $props();

  const entityKind = $derived(typeof args.entityKind === "string" ? args.entityKind : null);
  const field = $derived(typeof args.field === "string" ? args.field : null);
  const entityId = $derived(typeof args.entityId === "string" ? args.entityId : null);
  // The tool result carries a summary line + a cat -n snippet (the latter is
  // for the MODEL, to chain edits without a re-read). The human card already
  // shows the change as visual hunks below, so surface just the summary line.
  const summary = $derived(content.split("\n")[0] ?? content);

  interface Hunk {
    oldString: string;
    newString: string;
    replaceAll: boolean;
  }
  const hunks = $derived.by<Hunk[]>(() => {
    const raw = args.edits;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((e) => {
      if (!e || typeof e !== "object") return [];
      const oldString = (e as Record<string, unknown>).oldString;
      const newString = (e as Record<string, unknown>).newString;
      if (typeof oldString !== "string" || typeof newString !== "string") return [];
      return [{ oldString, newString, replaceAll: (e as Record<string, unknown>).replaceAll === true }];
    });
  });
</script>

<div class="rounded-md border bg-card p-3 text-sm" data-testid="tool-card-edit-content">
  <div class="flex items-center gap-2">
    <Badge variant="secondary" class="gap-1">
      <Scissors class="size-3" />
      <span>edit_content</span>
    </Badge>
    {#if entityKind && field}
      <span class="font-mono text-[10px] text-muted-foreground">
        {entityKind}{entityId ? ` ${entityId.slice(0, 8)}…` : ""} · {field}
      </span>
    {/if}
    <span class="ml-auto text-[10px] text-muted-foreground">staged on chat branch</span>
  </div>
  <p class="mt-1.5 text-xs text-muted-foreground">{summary}</p>
  {#if hunks.length > 0}
    <div class="mt-2 space-y-1.5">
      {#each hunks as h, i (i)}
        <div class="overflow-x-auto rounded border font-mono text-[11px]">
          <pre
            class="whitespace-pre-wrap bg-destructive/10 px-2 py-1 text-destructive">- {h.oldString}</pre>
          <pre
            class="whitespace-pre-wrap bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-400">+ {h.newString}</pre>
          {#if h.replaceAll}
            <p class="px-2 py-0.5 text-[10px] text-muted-foreground">replaceAll</p>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

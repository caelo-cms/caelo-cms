<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * #779 — the Draft → Preview → Live state mark: a small raised dot plus
   * a text label. The dot tells the states apart without colour (Draft is
   * a brass ring, Preview a filled brass dot, Live a filled coral dot) and
   * is `aria-hidden`; the label always carries the state for assistive
   * tech and for anyone who does not read the colours. The dot colours are
   * graphic-only tokens (`--state-stage`, `--state-live`) — never text.
   *
   * `children` replaces the default label when the surface needs more
   * than the state word ("Draft · 3 unstaged"); it must still name the
   * state.
   */
  import type { Snippet } from "svelte";
  import { cn } from "#lib/utils.js";
  import type { PublishState } from "./state-dot.js";

  let {
    state,
    class: className,
    children,
  }: {
    state: PublishState;
    class?: string;
    children?: Snippet;
  } = $props();

  const LABELS: Record<PublishState, string> = {
    draft: "Draft",
    preview: "Preview",
    live: "Live",
  };

  // The filled dots get a highlight + drop shadow so they read as raised
  // (the Caelatum "raised above the surface" motif); the Draft ring stays
  // flat so it reads as "not yet there".
  const DOT: Record<PublishState, string> = {
    draft: "border-[1.6px] border-state-stage bg-transparent",
    preview:
      "bg-state-stage shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_1px_2px_rgba(14,26,46,0.35)]",
    live: "bg-state-live shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_1px_2px_rgba(14,26,46,0.35)]",
  };
</script>

<span
  class={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs", className)}
  data-testid="state-dot"
  data-state={state}
>
  <span aria-hidden="true" class={cn("inline-block size-2 shrink-0 rounded-full", DOT[state])}
  ></span>
  {#if children}{@render children()}{:else}{LABELS[state]}{/if}
</span>

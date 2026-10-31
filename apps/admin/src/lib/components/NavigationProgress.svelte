<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * #1268 — a thin bar at the top of the window while a navigation loads,
   * on every route (mounted once in the root layout).
   *
   * It also drops a link click that repeats the navigation in flight: the
   * old page stays on screen until the new one's data arrived, and every
   * extra click used to start another full server load of the same page.
   * `beforeNavigate` cannot do this (SvelteKit does not call it while a
   * navigation runs), so a capture-phase click listener marks the click
   * handled before SvelteKit's link handler sees it; that handler skips a
   * click whose default was prevented. Programmatic navigations (`goto`,
   * the editor's refreshes) pass.
   */
  import { navigating } from "$app/state";
  import { onMount } from "svelte";
  import { isRepeatNavigation } from "#lib/navigation-feedback.js";

  onMount(() => {
    const dropRepeat = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.origin !== location.origin) return;
      // A link into another tab or a download does not repeat this navigation.
      if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      if (isRepeatNavigation(navigating.to?.url, new URL(anchor.href))) event.preventDefault();
    };
    document.addEventListener("click", dropRepeat, true);
    return () => document.removeEventListener("click", dropRepeat, true);
  });
</script>

{#if navigating.to}
  <div
    class="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden bg-primary/20"
    role="progressbar"
    aria-label="Loading the page"
    data-testid="navigation-progress"
  >
    <div class="caelo-nav-progress h-full w-1/3 bg-primary"></div>
  </div>
{/if}

<style>
  /* Indeterminate sweep; one-off CSS animation per CLAUDE.md 6A. */
  .caelo-nav-progress {
    animation: caelo-nav-sweep 1.1s ease-in-out infinite;
  }
  @keyframes caelo-nav-sweep {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .caelo-nav-progress {
      width: 100%;
      animation: none;
    }
  }
</style>

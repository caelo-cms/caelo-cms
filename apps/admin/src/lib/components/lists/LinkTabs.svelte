<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Tabs that are routes (epic #1107: Lists / Types, and a list's Entries /
   * Structure / plugin tabs). Same look as the `ui/tabs` primitive, but each
   * tab is a link so it has a URL, survives a reload and works without JS.
   */

  import { cn } from "#lib/utils.js";

  interface Props {
    tabs: { href: string; label: string; active: boolean }[];
    label: string;
  }
  let { tabs, label }: Props = $props();
</script>

<nav
  aria-label={label}
  class="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground"
>
  {#each tabs as t (t.href)}
    <a
      href={t.href}
      aria-current={t.active ? "page" : undefined}
      class={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        t.active && "bg-background text-foreground shadow",
      )}>{t.label}</a
    >
  {/each}
</nav>

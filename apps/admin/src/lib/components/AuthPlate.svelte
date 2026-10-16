<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * The form card of the arrival screens (#781): a relief plate — card
   * with a soft light ring and a long blue-grey drop shadow — headed by
   * the open Caelo mark and the page title. Every (auth) route renders
   * its form through this so the plate, the mark and the heading level
   * stay identical; the sky behind it lives in `(auth)/+layout.svelte`.
   *
   * The title is the page's only `<h1>`: these screens have no shell,
   * so the plate heading is the document heading.
   */

  import type { Snippet } from "svelte";
  import CaeloMark from "#lib/components/CaeloMark.svelte";
  import { Card, CardContent, CardDescription, CardHeader } from "#lib/components/ui/card/index.js";

  interface Props {
    /** Heading next to the mark, e.g. "Sign in to Caelo". */
    title: string;
    /** One sentence under the heading. */
    description: string;
    children: Snippet;
  }
  let { title, description, children }: Props = $props();
</script>

<Card
  class="rounded-[14px] shadow-[0_0_0_5px_var(--plate-ring),0_18px_40px_-26px_rgba(42,64,110,0.45)]"
>
  <CardHeader>
    <h1 class="flex items-center gap-2.5 text-xl font-semibold leading-tight tracking-tight">
      <CaeloMark size={28} class="shrink-0" />
      {title}
    </h1>
    <CardDescription>{description}</CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {@render children()}
  </CardContent>
</Card>

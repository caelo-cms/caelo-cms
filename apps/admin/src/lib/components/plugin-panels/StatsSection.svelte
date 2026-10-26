<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /** A plugin panel's labelled numbers. */

  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import type { StatsState } from "#lib/plugin-panels.js";
  import PanelValue from "./PanelValue.svelte";

  interface Props {
    view: StatsState;
  }
  let { view }: Props = $props();
</script>

<Card data-testid="panel-section-{view.section.id}">
  <CardHeader>
    <CardTitle>{view.section.title}</CardTitle>
    {#if view.section.description}
      <CardDescription>{view.section.description}</CardDescription>
    {/if}
  </CardHeader>
  <CardContent>
    {#if view.error}
      <Alert variant="destructive">
        <AlertDescription>The plugin could not load these numbers: {view.error}</AlertDescription>
      </Alert>
    {:else}
      <dl class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {#each view.items as item, i (i)}
          <div class="rounded-md border p-3">
            <dt class="text-xs text-muted-foreground">{item.label}</dt>
            <dd class="text-2xl font-semibold tabular-nums">
              <PanelValue display={item.display} value={item.value} />
            </dd>
          </div>
        {/each}
      </dl>
    {/if}
  </CardContent>
</Card>

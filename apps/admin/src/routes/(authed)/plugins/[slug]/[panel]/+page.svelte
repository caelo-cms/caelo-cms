<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * A plugin's admin page, rendered from its `adminPanels` declaration. No
   * plugin code runs here: every section is one of the generic renderers in
   * `#lib/components/plugin-panels`, and every value is text.
   */

  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import FieldsSection from "#lib/components/plugin-panels/FieldsSection.svelte";
  import { PANEL_ICONS } from "#lib/components/plugin-panels/panel-icons.js";
  import ReviewCard from "#lib/components/plugin-panels/ReviewCard.svelte";
  import StatsSection from "#lib/components/plugin-panels/StatsSection.svelte";
  import TableSection from "#lib/components/plugin-panels/TableSection.svelte";

  let { data, form } = $props();

  const Icon = $derived(PANEL_ICONS[data.panel.icon]);
</script>

<svelte:head>
  <title>{data.panel.title} · Caelo</title>
</svelte:head>

<div class="space-y-6" data-testid="plugin-panel" data-plugin={data.pluginSlug}>
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <Icon class="size-6" aria-hidden="true" />
      {data.panel.title}
    </h1>
    <p class="text-sm text-muted-foreground">{data.panel.description}</p>
  </div>

  {#if form?.error}
    <Alert variant="destructive" role="alert">
      <AlertDescription>{form.error}</AlertDescription>
    </Alert>
  {:else if form?.ok}
    <Alert role="status">
      <AlertDescription>{form.ok}</AlertDescription>
    </Alert>
  {/if}

  {#if data.review}
    <ReviewCard review={data.review} csrfToken={data.csrfToken} />
  {/if}

  {#each data.sections as view (view.section.id)}
    {#if view.kind === "table"}
      <TableSection {view} csrfToken={data.csrfToken} />
    {:else if view.kind === "stats"}
      <StatsSection {view} />
    {:else}
      <FieldsSection {view} csrfToken={data.csrfToken} />
    {/if}
  {/each}
</div>

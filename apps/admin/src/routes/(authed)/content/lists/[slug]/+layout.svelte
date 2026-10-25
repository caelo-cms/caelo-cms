<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { page } from "$app/state";
  import LinkTabs from "#lib/components/lists/LinkTabs.svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { activeListTab } from "#lib/lists/editor-tabs.js";

  let { data, children } = $props();
  const active = $derived(activeListTab(page.url.pathname, data.list.slug));
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div class="min-w-0">
      <p class="text-sm text-muted-foreground">
        <a class="underline-offset-2 hover:underline" href="/content/lists">Menus &amp; lists</a> /
      </p>
      <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        {data.list.name}
        <Badge variant="secondary">{data.listType.name}</Badge>
      </h1>
      <p class="text-sm text-muted-foreground">{data.list.purpose}</p>
    </div>
    <LinkTabs
      label="List"
      tabs={data.tabs.map((t) => ({ href: t.href, label: t.label, active: t.id === active }))}
    />
  </div>
  {@render children()}
</div>

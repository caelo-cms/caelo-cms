<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.12.3 — /content/library list view. Operator surface for browsing
   * + filtering content_instances. AC #7 (the cross-page propagate-once
   * edit) starts here: click a synced instance → /content/library/[id]
   * edit view → save → all bound pages reflect the new values.
   */
  import { Package } from "lucide-svelte";
  import EmptyStatePlaceholder from "$lib/components/EmptyStatePlaceholder.svelte";
  import ContentInstancesTable from "$lib/components/content/ContentInstancesTable.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  let { data } = $props();

  // Client-side filter chips. The dataset is small (~one instance per
  // placement on the install), so all-in-memory filtering keeps the
  // page snappy without server round-trips.
  type Filter = "all" | "shared" | "orphan";
  let filter: Filter = $state("all");

  const filtered = $derived(
    data.instances.filter((i) => {
      if (filter === "shared") return i.placementCount >= 2;
      if (filter === "orphan") return i.placementCount === 0;
      return true;
    }),
  );

  const counts = $derived({
    all: data.instances.length,
    shared: data.instances.filter((i) => i.placementCount >= 2).length,
    orphan: data.instances.filter((i) => i.placementCount === 0).length,
  });
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Content library</h1>
    <p class="text-sm text-muted-foreground">
      Reusable content for module placements. Edit a shared instance once — every page bound to it
      updates.
    </p>
  </div>

  {#if data.instances.length === 0}
    <Card>
      <CardContent class="py-10">
        <EmptyStatePlaceholder
          icon={Package}
          title="No content instances yet"
          description="Content instances mint automatically when you add a module to a page. Open a page in /edit and bind a placement to a shared instance to start reusing content."
        />
      </CardContent>
    </Card>
  {:else}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">Filter</CardTitle>
        <CardDescription>
          Shared = bound to ≥2 placements (edits propagate). Orphan = bound to none (safe to
          delete).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={filter === "all" ? "default" : "outline"}
            onclick={() => (filter = "all")}
          >
            All ({counts.all})
          </Button>
          <Button
            type="button"
            size="sm"
            variant={filter === "shared" ? "default" : "outline"}
            onclick={() => (filter = "shared")}
          >
            Shared ({counts.shared})
          </Button>
          <Button
            type="button"
            size="sm"
            variant={filter === "orphan" ? "default" : "outline"}
            onclick={() => (filter = "orphan")}
          >
            Orphans ({counts.orphan})
          </Button>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">Instances</CardTitle>
      </CardHeader>
      <CardContent>
        {#if filtered.length === 0}
          <p class="text-sm text-muted-foreground">No instances match this filter.</p>
        {:else}
          <ContentInstancesTable instances={filtered} />
        {/if}
      </CardContent>
    </Card>
  {/if}
</div>

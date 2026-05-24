<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.12.3 — list-table primitive for /content/library. Rows show
   * module + instance slug/displayName + placementCount badge + a
   * first-value preview snippet. Clicking a row routes to the edit
   * view. CLAUDE.md §6A — `cn()` for class composition, shadcn-svelte
   * Table primitive, no custom <style> block.
   */
  import { Badge } from "$lib/components/ui/badge/index.js";
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from "$lib/components/ui/table/index.js";

  interface Instance {
    id: string;
    moduleSlug: string;
    moduleDisplayName: string;
    slug: string | null;
    displayName: string | null;
    values: Record<string, unknown>;
    placementCount: number;
    updatedAt: string;
  }

  let { instances }: { instances: Instance[] } = $props();

  function valuePreview(values: Record<string, unknown>): string {
    for (const [, v] of Object.entries(values)) {
      if (typeof v === "string" && v.length > 0) {
        return v.length > 80 ? `${v.slice(0, 77)}…` : v;
      }
    }
    return "—";
  }
</script>

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Module</TableHead>
      <TableHead>Instance</TableHead>
      <TableHead>Preview</TableHead>
      <TableHead class="text-right">Placements</TableHead>
      <TableHead>Updated</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {#each instances as i (i.id)}
      <TableRow>
        <TableCell class="font-mono text-xs">{i.moduleSlug}</TableCell>
        <TableCell>
          <a
            class="font-medium underline-offset-4 hover:underline"
            href={`/content/library/${i.id}`}
          >
            {i.displayName ?? i.slug ?? i.id.slice(0, 8)}
          </a>
        </TableCell>
        <TableCell class="text-muted-foreground">{valuePreview(i.values)}</TableCell>
        <TableCell class="text-right">
          {#if i.placementCount === 0}
            <Badge variant="outline">orphan</Badge>
          {:else if i.placementCount >= 2}
            <Badge variant="secondary">shared · {i.placementCount}</Badge>
          {:else}
            <Badge variant="outline">1</Badge>
          {/if}
        </TableCell>
        <TableCell class="text-muted-foreground">{i.updatedAt.slice(0, 10)}</TableCell>
      </TableRow>
    {/each}
  </TableBody>
</Table>

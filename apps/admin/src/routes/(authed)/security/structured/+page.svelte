<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  let { data, form } = $props();

  const KINDS: { kind: string; label: string; desc: string }[] = [
    { kind: "nav-menu", label: "Nav menus", desc: "Header / footer / sidebar navigation" },
    { kind: "tags", label: "Tags", desc: "Flat tag lists for content filtering" },
    { kind: "taxonomy", label: "Taxonomies", desc: "Tree-shaped category hierarchies" },
    { kind: "link-list", label: "Link lists", desc: "Footer 'legal', related resources" },
    { kind: "theme", label: "Theme tokens", desc: "Single 'site' set — see /security/theme" },
  ];

  const setsByKind = $derived(
    KINDS.map((k) => ({
      ...k,
      sets: data.sets.filter((s: { kind: string }) => s.kind === k.kind),
    })),
  );
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Structured data</h1>
    <p class="text-sm text-muted-foreground">
      Owner-curated typed lists. Each kind drives a per-row Zod validator + a renderer at preview /
      deploy. AI can edit and create sets but cannot delete them — use this surface to remove a set.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  {#each setsByKind as group (group.kind)}
    <Card>
      <CardHeader class="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle class="text-base">{group.label}</CardTitle>
          <p class="text-xs text-muted-foreground">{group.desc}</p>
        </div>
        <a
          href={`/security/structured/${group.kind}/new`}
          class={buttonVariants({ variant: "outline", size: "sm" })}>
          + New
        </a>
      </CardHeader>
      <CardContent>
        {#if group.sets.length === 0}
          <p class="text-sm text-muted-foreground">No {group.label.toLowerCase()} yet.</p>
        {:else}
          <ul class="space-y-2">
            {#each group.sets as set (set.id)}
              {@const items = Array.isArray(set.items) ? (set.items as unknown[]) : []}
              <li class="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                <strong>{set.slug}</strong>
                <span class="text-muted-foreground">— {set.displayName}</span>
                <Badge variant="outline">{items.length} item{items.length === 1 ? "" : "s"}</Badge>
                <div class="ml-auto flex items-center gap-2">
                  <a
                    href={`/security/structured/${set.kind}/${set.slug}`}
                    class={buttonVariants({ variant: "outline", size: "sm" })}>
                    Edit
                  </a>
                  <form method="post" action="?/delete">
                    <input type="hidden" name="_csrf" value={data.csrfToken} />
                    <input type="hidden" name="setId" value={set.id} />
                    <Button type="submit" size="sm" variant="destructive">Delete</Button>
                  </form>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </CardContent>
    </Card>
  {/each}
</div>

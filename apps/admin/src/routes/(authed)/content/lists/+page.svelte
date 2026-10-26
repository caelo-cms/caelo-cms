<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { enhance } from "$app/forms";
  import { ListTree } from "lucide-svelte";
  import EmptyStatePlaceholder from "#lib/components/EmptyStatePlaceholder.svelte";
  import AreaHeader from "#lib/components/lists/AreaHeader.svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import { usageSummary } from "#lib/lists/usage.js";

  let { data } = $props();

  const canWrite = $derived((data.permissions as string[]).includes("content.write"));
  const ROLE_ORDER = { navigation: 0, vocabulary: 1, content: 2 } as const;
  const ROLE_LABEL = { navigation: "Navigation", vocabulary: "Vocabulary", content: "Content" };

  /** Lists grouped by type; types without lists are left out of the overview. */
  const groups = $derived(
    [...data.listTypes]
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name))
      .map((t) => ({ type: t, lists: data.lists.filter((l) => l.type === t.slug) }))
      .filter((g) => g.lists.length > 0),
  );

  let name = $state("");
  let slugEdited = $state(false);
  let slug = $state("");
  $effect(() => {
    if (!slugEdited) {
      slug = name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
    }
  });
</script>

<div class="space-y-6">
  <AreaHeader
    active="lists"
    description="Menus, footer links, categories, tags and any other repeated content — each a list of a fitting type."
  />

  {#if groups.length === 0}
    <EmptyStatePlaceholder
      icon={ListTree}
      title="No lists yet"
      description="Ask the AI for a menu or a set of categories in Live edit, or create a list below."
    />
  {/if}

  {#each groups as g (g.type.id)}
    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2 text-base">
          {g.type.name}
          <Badge variant="secondary">{ROLE_LABEL[g.type.role]}</Badge>
        </CardTitle>
        <CardDescription>{g.type.purpose}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul class="divide-y">
          {#each g.lists as l (l.id)}
            <li class="flex flex-wrap items-baseline justify-between gap-2 py-2" data-testid="list-row">
              <div class="min-w-0">
                <a class="font-medium underline-offset-2 hover:underline" href={`/content/lists/${l.slug}`}
                  >{l.name}</a
                >
                <p class="text-sm text-muted-foreground">{l.purpose}</p>
              </div>
              <div class="text-right text-sm text-muted-foreground">
                <div>{l.itemCount} entr{l.itemCount === 1 ? "y" : "ies"}</div>
                <div>{usageSummary(l.usage)}</div>
              </div>
            </li>
          {/each}
        </ul>
      </CardContent>
    </Card>
  {/each}

  {#if canWrite}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">New list</CardTitle>
        <CardDescription>
          Pick the type that fits: a menu for navigation, links for a flat group of links,
          categories or tags to sort pages.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/create" class="grid gap-4 md:grid-cols-2" use:enhance>
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <div class="space-y-2">
            <Label for="list-name">Name</Label>
            <Input id="list-name" name="name" bind:value={name} required maxlength={200} />
          </div>
          <div class="space-y-2">
            <Label for="list-slug">Address name</Label>
            <Input
              id="list-slug"
              name="slug"
              bind:value={slug}
              oninput={() => (slugEdited = true)}
              required
              pattern={"[a-z0-9](?:[a-z0-9\\-]{0,62}[a-z0-9])?"}
            />
          </div>
          <div class="space-y-2 md:col-span-2">
            <Label for="list-purpose">What it is for</Label>
            <Textarea
              id="list-purpose"
              name="purpose"
              required
              maxlength={1000}
              placeholder="e.g. The main navigation in the site header."
            />
          </div>
          <div class="space-y-2">
            <Label for="list-type">Type</Label>
            <Select id="list-type" name="type" required>
              {#each data.listTypes as t (t.id)}
                <option value={t.slug}>{t.name}</option>
              {/each}
            </Select>
          </div>
          <div class="flex items-end">
            <Button type="submit" data-testid="create-list">Create list</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  {/if}
</div>

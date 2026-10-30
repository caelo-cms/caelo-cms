<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { enhance } from "$app/forms";
  import AreaHeader from "#lib/components/lists/AreaHeader.svelte";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
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

  let { data } = $props();
  const ROLE_LABEL = { navigation: "Navigation", vocabulary: "Vocabulary", content: "Content" };
</script>

<div class="space-y-6">
  <AreaHeader
    active="types"
    description="The shapes behind lists and pages: what an entry carries, what a page of a kind carries, and how they nest."
  />

  {#if !data.canStructure}
    <Alert data-testid="types-readonly">
      <AlertDescription>
        Read-only: defining types needs the "content.structure" permission.
      </AlertDescription>
    </Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">List types</CardTitle>
      <CardDescription>What the entries of a list can be and how they nest.</CardDescription>
    </CardHeader>
    <CardContent>
      <ul class="divide-y">
        {#each data.listTypes as t (t.id)}
          <li class="flex flex-wrap items-baseline justify-between gap-2 py-2" data-testid="list-type-row">
            <div class="min-w-0">
              <a class="font-medium underline-offset-2 hover:underline" href={`/content/lists/types/list/${t.slug}`}>{t.name}</a>
              <Badge variant="secondary" class="ml-1">{ROLE_LABEL[t.role]}</Badge>
              <p class="text-sm text-muted-foreground">{t.purpose}</p>
            </div>
            <span class="text-sm text-muted-foreground">{t.listCount} list{t.listCount === 1 ? "" : "s"}</span>
          </li>
        {/each}
      </ul>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Page types</CardTitle>
      <CardDescription>What a page is — its properties, categories and tags, and the templates it may use.</CardDescription>
    </CardHeader>
    <CardContent>
      <ul class="divide-y">
        {#each data.pageTypes as t (t.id)}
          <li class="flex flex-wrap items-baseline justify-between gap-2 py-2" data-testid="page-type-row">
            <div class="min-w-0">
              <a class="font-medium underline-offset-2 hover:underline" href={`/content/lists/types/page/${t.slug}`}>{t.name}</a>
              <p class="text-sm text-muted-foreground">{t.purpose}</p>
            </div>
            <span class="text-sm text-muted-foreground">
              {t.pageCount} page{t.pageCount === 1 ? "" : "s"} · {t.properties.length} propert{t.properties.length === 1 ? "y" : "ies"}{t.vocabularySlugs.length > 0 ? ` · ${t.vocabularySlugs.join(", ")}` : ""}
            </span>
          </li>
        {/each}
      </ul>
    </CardContent>
  </Card>

  {#if data.canStructure}
    <div class="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle class="text-base">New list type</CardTitle></CardHeader>
        <CardContent>
          <form method="post" action="?/createListType" class="space-y-3" use:enhance>
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-1"><Label for="lt-name">Name</Label><Input id="lt-name" name="name" required /></div>
              <div class="space-y-1"><Label for="lt-slug">Address name</Label><Input id="lt-slug" name="slug" required pattern={"[a-z0-9](?:[a-z0-9\\-]{0,62}[a-z0-9])?"} /></div>
              <div class="space-y-1">
                <Label for="lt-role">Used for</Label>
                <Select id="lt-role" name="role">
                  <option value="content">Content</option>
                  <option value="navigation">Navigation</option>
                  <option value="vocabulary">Vocabulary</option>
                </Select>
              </div>
              <div class="space-y-1"><Label for="lt-entry">First entry kind</Label><Input id="lt-entry" name="entryLabel" placeholder="Entry" /></div>
            </div>
            <div class="space-y-1"><Label for="lt-purpose">What it is for</Label><Textarea id="lt-purpose" name="purpose" required /></div>
            <Button type="submit">Create list type</Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle class="text-base">New page type</CardTitle></CardHeader>
        <CardContent>
          <form method="post" action="?/createPageType" class="space-y-3" use:enhance>
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-1"><Label for="pt-name">Name</Label><Input id="pt-name" name="name" required /></div>
              <div class="space-y-1"><Label for="pt-slug">Address name</Label><Input id="pt-slug" name="slug" required pattern={"[a-z0-9](?:[a-z0-9\\-]{0,62}[a-z0-9])?"} /></div>
              <div class="space-y-1 sm:col-span-2">
                <Label for="pt-template">Template</Label>
                <Select id="pt-template" name="templateId" required>
                  {#each data.templates as t (t.id)}<option value={t.id}>{t.displayName}</option>{/each}
                </Select>
              </div>
            </div>
            <div class="space-y-1"><Label for="pt-purpose">What it is for</Label><Textarea id="pt-purpose" name="purpose" required /></div>
            <!-- #1276 — a type that reads like an existing one (blogs / blog) is refused unless named here. -->
            <div class="space-y-1">
              <Label for="pt-distinct">Different from (optional)</Label>
              <Input id="pt-distinct" name="distinctFrom" placeholder="address names of similar types, comma-separated" />
            </div>
            <Button type="submit">Create page type</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  {/if}
</div>

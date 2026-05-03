<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { FlaskConical } from "lucide-svelte";
  import { enhance } from "$app/forms";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";

  let { data, form } = $props();

  function fmt(s: string | null): string {
    if (!s) return "—";
    return new Date(s).toLocaleString();
  }
  function statusVariant(s: string): "default" | "secondary" | "outline" {
    if (s === "active") return "default";
    if (s === "completed") return "secondary";
    return "outline";
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
      <FlaskConical class="size-6" />
      A/B experiments
    </h1>
    <p class="text-sm text-muted-foreground">
      Client-side variant routing. Stable per-visitor hash means the same visitor sees the same
      variant across reloads. Add the inline script
      <code>&lt;script src="/api/variant.js" data-experiment="{`{slug}`}" data-page="/blog/x"&gt;&lt;/script&gt;</code>
      to the static page.
    </p>
  </div>

  {#if form?.error}
    <div class="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-300">{form.error}</div>
  {/if}
  {#if form?.ok}
    <div class="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-300">{form.message}</div>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle>Create experiment</CardTitle>
      <CardDescription>2–10 variants; weights must sum to 1.0.</CardDescription>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/create" use:enhance class="grid gap-3 max-w-xl">
        <label class="grid gap-1 text-sm">
          <span>Slug</span>
          <Input name="slug" placeholder="hero-cta-test" required />
        </label>
        <label class="grid gap-1 text-sm">
          <span>Page id (uuid)</span>
          <Input name="pageId" placeholder="…" required />
        </label>
        <label class="grid gap-1 text-sm">
          <span>Variants (JSON)</span>
          <textarea name="variants" required rows="3" class="rounded border px-3 py-2 font-mono text-xs">{'[{"label":"a","weight":0.5},{"label":"b","weight":0.5}]'}</textarea>
        </label>
        <div>
          <Button type="submit">Create</Button>
        </div>
      </form>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle>All experiments</CardTitle>
      <CardDescription>{data.experiments.length} total</CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      {#if data.experiments.length === 0}
        <p class="text-sm text-muted-foreground">No experiments yet.</p>
      {:else}
        {#each data.experiments as e (e.id)}
          <div class="rounded border p-3">
            <div class="mb-2 flex items-center gap-2">
              <span class="font-mono text-sm">{e.slug}</span>
              <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
              <span class="text-xs text-muted-foreground">created {fmt(e.createdAt)}</span>
            </div>
            <div class="mb-3 text-sm">
              <p>Page: <code>{e.pageId.slice(0, 8)}</code> · started {fmt(e.startedAt)} · completed {fmt(e.completedAt)} {#if e.winningVariant}<Badge>winner: {e.winningVariant}</Badge>{/if}</p>
              <ul class="ml-6 list-disc">
                {#each e.variants as v (v.label)}
                  <li>{v.label} ({(v.weight * 100).toFixed(0)}%)</li>
                {/each}
              </ul>
            </div>
            <div class="flex gap-2">
              {#if e.status === "draft"}
                <form method="post" action="?/activate" use:enhance>
                  <input type="hidden" name="experimentId" value={e.id} />
                  <Button type="submit" size="sm">Activate</Button>
                </form>
              {/if}
              {#if e.status === "active"}
                <form method="post" action="?/complete" use:enhance class="flex items-center gap-2">
                  <input type="hidden" name="experimentId" value={e.id} />
                  <input name="winningVariant" placeholder="Winner label (optional)" class="rounded border px-2 py-1 text-sm" />
                  <Button type="submit" size="sm" variant="secondary">Complete</Button>
                </form>
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </CardContent>
  </Card>
</div>

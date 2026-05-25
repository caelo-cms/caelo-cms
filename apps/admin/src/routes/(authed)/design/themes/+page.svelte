<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  // v0.11.1 (issue #76) — /design/themes list-view.
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { parseColor } from "$lib/color/oklch.js";
  import { Palette, Plus } from "lucide-svelte";

  let { data, form } = $props();
  let createOpen = $state(false);

  function primarySwatch(theme: { tokens: unknown }): string {
    // Best-effort read of color.primary.$value (handles light/dark
    // pair shape + flat string + group-with-DEFAULT-alias).
    const t = theme.tokens as Record<string, unknown> | null;
    const colorGroup = t?.color as Record<string, unknown> | undefined;
    const primary = colorGroup?.primary as Record<string, unknown> | undefined;
    if (!primary) return "#e5e5e5";
    if (typeof primary.$value === "string") return safeColor(primary.$value);
    if (primary.$value && typeof primary.$value === "object" && "light" in primary.$value) {
      return safeColor(String((primary.$value as { light: unknown }).light ?? "#e5e5e5"));
    }
    // Group shape: pick the 500 stop if present, else DEFAULT.
    const stop500 = primary["500"] as Record<string, unknown> | undefined;
    if (stop500 && typeof stop500.$value === "string") return safeColor(stop500.$value);
    return "#e5e5e5";
  }

  function safeColor(v: string): string {
    try {
      return parseColor(v).hex;
    } catch {
      return "#e5e5e5";
    }
  }
</script>

<div class="space-y-6">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        <Palette class="size-6" /> Themes
      </h1>
      <p class="text-sm text-muted-foreground">
        Design tokens shipped to the public site as CSS variables. The active theme's tokens become
        a <code>:root</code> block on every page. Create / Activate / Delete actions queue for
        Owner approval at <a href="/security/themes/pending" class="underline">/security/themes/pending</a>.
        {#if data.pendingCount > 0}
          <Badge variant="secondary" class="ml-2">
            {data.pendingCount} pending
          </Badge>
        {/if}
      </p>
    </div>
    <Button onclick={() => (createOpen = true)}>
      <Plus class="size-4" /> Create theme
    </Button>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {:else if form?.ok}
    <Alert>
      <AlertDescription>
        {form.message}
        {#if form.pendingPath}
          — <a href={form.pendingPath} class="underline">Open approval queue</a>
        {/if}
      </AlertDescription>
    </Alert>
  {/if}

  {#if data.themes.length === 0}
    <Card>
      <CardContent class="py-12 text-center text-sm text-muted-foreground">
        No themes on this install. Click <strong>Create theme</strong> above to mint the first.
      </CardContent>
    </Card>
  {:else}
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {#each data.themes as theme (theme.id)}
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-3 text-base">
              <span
                class="inline-block size-8 shrink-0 rounded-md border"
                style="background-color: {primarySwatch(theme)};"
                aria-label="Primary color swatch"
                data-caelo-primary-swatch
              ></span>
              <div class="flex-1 min-w-0">
                <div class="truncate">{theme.displayName}</div>
                <div class="font-mono text-xs text-muted-foreground truncate">{theme.slug}</div>
              </div>
              {#if theme.isActive}
                <Badge aria-label="Active theme">Active</Badge>
              {/if}
            </CardTitle>
          </CardHeader>
          <CardContent class="text-sm text-muted-foreground">
            {#if theme.description}
              <p class="line-clamp-2">{theme.description}</p>
            {:else}
              <p class="italic">No description.</p>
            {/if}
          </CardContent>
          <CardFooter class="flex flex-wrap items-center gap-2">
            <a href={`/design/themes/${theme.slug}`} class="contents">
              <Button variant="outline" size="sm">Edit</Button>
            </a>
            {#if !theme.isActive}
              <form method="post" action="?/activate">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="themeId" value={theme.id} />
                <Button type="submit" variant="outline" size="sm">Activate</Button>
              </form>
            {/if}
            <form method="post" action="?/clone" class="flex items-center gap-1">
              <input type="hidden" name="_csrf" value={data.csrfToken} />
              <input type="hidden" name="sourceSlug" value={theme.slug} />
              <input
                type="text"
                name="newSlug"
                placeholder="new-slug"
                required
                pattern="[a-z0-9][a-z0-9-]*"
                class="w-24 rounded-md border bg-background p-1 text-xs"
              />
              <input
                type="text"
                name="newDisplayName"
                placeholder="Display name"
                required
                class="w-32 rounded-md border bg-background p-1 text-xs"
              />
              <Button type="submit" variant="ghost" size="sm">Clone</Button>
            </form>
            {#if !theme.isActive}
              <form method="post" action="?/delete">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="themeId" value={theme.id} />
                <Button type="submit" variant="ghost" size="sm">Delete</Button>
              </form>
            {/if}
          </CardFooter>
        </Card>
      {/each}
    </div>
  {/if}
</div>

<Dialog bind:open={createOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Create theme</DialogTitle>
      <DialogDescription>
        Pick a preset and (optionally) a brand primary color. Setting a primary color derives a
        50–900 OKLCh lightness ramp on the server so you get a full palette out of the box. Approval
        happens at <code>/security/themes/pending</code>.
      </DialogDescription>
    </DialogHeader>
    <form method="post" action="?/create" class="grid gap-3 py-2">
      <input type="hidden" name="_csrf" value={data.csrfToken} />
      <div class="grid gap-1.5">
        <Label for="ct-slug">Slug</Label>
        <Input id="ct-slug" name="slug" required pattern="[a-z0-9][a-z0-9-]*" placeholder="brand-orange" />
      </div>
      <div class="grid gap-1.5">
        <Label for="ct-displayName">Display name</Label>
        <Input id="ct-displayName" name="displayName" required placeholder="Brand orange" />
      </div>
      <div class="grid gap-1.5">
        <Label for="ct-preset">Preset</Label>
        <select
          id="ct-preset"
          name="preset"
          class="rounded-md border bg-background p-2 text-sm"
        >
          <option value="shadcn-default">shadcn-default — neutral palette</option>
          <option value="minimal">minimal — high-contrast grayscale</option>
          <option value="warm">warm — earthy palette, serif headings</option>
          <option value="playful">playful — saturated, large radii</option>
        </select>
      </div>
      <div class="grid gap-1.5">
        <Label for="ct-primaryColor">Primary color (optional)</Label>
        <Input
          id="ct-primaryColor"
          name="primaryColor"
          placeholder="#ff6600 or oklch(0.7 0.18 30)"
        />
        <p class="text-xs text-muted-foreground">
          Triggers the 50–900 OKLCh ramp (each stop annotated <code>_derived: true</code>).
        </p>
      </div>
      <div class="grid gap-1.5">
        <Label for="ct-description">Description (optional)</Label>
        <Input id="ct-description" name="description" placeholder="Campaign-page variant" />
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
        <Button type="submit">Queue proposal</Button>
      </DialogFooter>
    </form>
  </DialogContent>
</Dialog>

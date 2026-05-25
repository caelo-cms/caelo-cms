<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.11.1 (issue #76) — /design/themes/[slug] edit page.
   *
   * Tabbed shell (Colors / Typography / Spacing / Radii / Shadows /
   * Assets) on a 2/3 grid with a sticky live-preview pane on the right.
   * Each tab's editor lifts in-progress tokens via onTokensChange so
   * the preview re-renders without a server round-trip; submission
   * (per-tab form action) commits via themes.update_tokens.
   */
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
  } from "$lib/components/ui/tabs/index.js";
  import AssetsEditor from "$lib/components/theme/AssetsEditor.svelte";
  import ColorEditor from "$lib/components/theme/ColorEditor.svelte";
  import LivePreview from "$lib/components/theme/LivePreview.svelte";
  import RadiiEditor from "$lib/components/theme/RadiiEditor.svelte";
  import ShadowsEditor from "$lib/components/theme/ShadowsEditor.svelte";
  import SpacingEditor from "$lib/components/theme/SpacingEditor.svelte";
  import TypographyEditor from "$lib/components/theme/TypographyEditor.svelte";
  import type { ThemeDocument } from "@caelo-cms/shared";

  let { data, form } = $props();

  // Local in-progress tokens — start from server state, mutate via
  // child onTokensChange. Submission commits via themes.update_tokens.
  let editedTokens = $state<ThemeDocument>(data.theme.tokens);
  let darkMode = $state(false);
  let activeTab = $state("colors");

  // Re-sync edited tokens when the server returns a new snapshot
  // (e.g. after Save). $effect on data.theme handles that.
  $effect(() => {
    editedTokens = data.theme.tokens;
  });

  function handleTokensChange(next: ThemeDocument): void {
    editedTokens = next;
  }
</script>

<div class="space-y-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">{data.theme.displayName}</h1>
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <code>{data.theme.slug}</code>
        {#if data.theme.isActive}
          <Badge>Active</Badge>
        {/if}
      </div>
      {#if data.theme.description}
        <p class="mt-2 text-sm text-muted-foreground">{data.theme.description}</p>
      {/if}
    </div>
    <a href="/design/themes" class="text-sm text-muted-foreground underline">← All themes</a>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {:else if form?.ok}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  <div class="grid gap-6 lg:grid-cols-3">
    <div class="lg:col-span-2">
      <Tabs bind:value={activeTab}>
        <TabsList>
          <TabsTrigger value="colors">Colors</TabsTrigger>
          <TabsTrigger value="typography">Typography</TabsTrigger>
          <TabsTrigger value="spacing">Spacing</TabsTrigger>
          <TabsTrigger value="radii">Radii</TabsTrigger>
          <TabsTrigger value="shadows">Shadows</TabsTrigger>
          <TabsTrigger value="assets">Assets</TabsTrigger>
        </TabsList>
        <TabsContent value="colors" class="mt-4">
          <ColorEditor
            tokens={editedTokens}
            csrfToken={data.csrfToken}
            themeSlug={data.theme.slug}
            {darkMode}
            onSetDarkMode={(v) => (darkMode = v)}
            onTokensChange={handleTokensChange}
          />
        </TabsContent>
        <TabsContent value="typography" class="mt-4">
          <TypographyEditor
            tokens={editedTokens}
            csrfToken={data.csrfToken}
            themeSlug={data.theme.slug}
            onTokensChange={handleTokensChange}
          />
        </TabsContent>
        <TabsContent value="spacing" class="mt-4">
          <SpacingEditor
            tokens={editedTokens}
            csrfToken={data.csrfToken}
            themeSlug={data.theme.slug}
            onTokensChange={handleTokensChange}
          />
        </TabsContent>
        <TabsContent value="radii" class="mt-4">
          <RadiiEditor
            tokens={editedTokens}
            csrfToken={data.csrfToken}
            themeSlug={data.theme.slug}
            onTokensChange={handleTokensChange}
          />
        </TabsContent>
        <TabsContent value="shadows" class="mt-4">
          <ShadowsEditor
            tokens={editedTokens}
            csrfToken={data.csrfToken}
            themeSlug={data.theme.slug}
            onTokensChange={handleTokensChange}
          />
        </TabsContent>
        <TabsContent value="assets" class="mt-4">
          <AssetsEditor
            assets={data.theme.assets}
            csrfToken={data.csrfToken}
            themeSlug={data.theme.slug}
          />
        </TabsContent>
      </Tabs>
    </div>
    <div class="lg:col-span-1">
      <div class="sticky top-4">
        <LivePreview tokens={editedTokens} {darkMode} />
      </div>
    </div>
  </div>
</div>

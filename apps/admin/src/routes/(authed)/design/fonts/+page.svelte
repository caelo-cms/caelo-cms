<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import FontSpecimen from "$lib/components/theme/FontSpecimen.svelte";
  let { data, form } = $props();
  let specimen = $state("Große Geschichten beginnen mit kleinen Buchstaben. ÄÖÜ äöü ß 0123456789");
  let size = $state(32);
  let family = $state("");
  let variants = $state<{ filename: string; label: string }[]>([]);
  let variantError = $state("");
  let loadingVariants = $state(false);
  async function loadVariants() {
    const requestedFamily = family;
    loadingVariants = true; variantError = ""; variants = [];
    try {
      const response = await fetch(`/design/fonts/variants?family=${encodeURIComponent(family)}`);
      const result = await response.json();
      if (family !== requestedFamily) return;
      if (!response.ok) throw new Error(result.error);
      variants = result.variants;
    } catch (e) { variantError = e instanceof Error ? e.message : "Could not load styles"; }
    finally { loadingVariants = false; }
  }
</script>
<svelte:head><title>Fonts · Caelo</title></svelte:head>
<div class="mx-auto max-w-5xl space-y-8 p-6">
  <div><h1 class="text-2xl font-semibold">Fonts</h1><p class="text-muted-foreground">Your shared font library for websites and approved plugins. Each import keeps an immutable version of the file and its license.</p></div>
  {#if form && 'error' in form}<p role="alert" class="text-destructive">{form.error}</p>{/if}
  {#if form && 'message' in form}<p role="status">{form.message}</p>{/if}
  <form method="get" class="flex gap-3"><Input name="q" aria-label="Search fonts" value={data.query} placeholder="Search font families" /><Button type="submit">Search</Button></form>
  <section class="space-y-3 rounded-lg border p-4">
    <h2 class="text-lg font-semibold">Google Fonts</h2>
    <p class="text-sm text-muted-foreground">Catalog: {data.catalog.status}. {data.catalog.status === 'curated' ? 'A curated selection is shown; configure GOOGLE_FONTS_API_KEY for the full catalog.' : data.catalog.status === 'unavailable' ? 'Google’s catalog is unavailable; showing the curated selection.' : ''} Imports include a complete font file and its Open Font License. Visitor pages serve the files locally.</p>
    <form method="post" action="?/acquire" class="flex flex-wrap gap-3">
      <input type="hidden" name="_csrf" value={data.csrfToken} />
      <Input name="family" bind:value={family} oninput={() => { variants = []; variantError = ""; }} list="font-catalog" aria-label="Google font family" placeholder="e.g. Nunito" required />
      <datalist id="font-catalog">{#each data.catalog.families as family}<option value={family.family}>{family.category ?? ''}</option>{/each}</datalist>
      <Button type="button" variant="outline" disabled={!family || loadingVariants} onclick={loadVariants}>{loadingVariants ? 'Loading styles…' : 'Choose a style'}</Button>
      {#if variants.length}<select name="filename" aria-label="Font style" class="rounded border bg-background p-2">{#each variants as variant}<option value={variant.filename}>{variant.label}</option>{/each}</select>{/if}
      {#if variantError}<p role="alert" class="text-sm text-destructive">{variantError}</p>{/if}
      <Button type="submit">Import from Google Fonts</Button>
    </form>
  </section>
  <details class="rounded-lg border p-4"><summary class="cursor-pointer font-semibold">Upload a licensed font</summary>
    <form method="post" action="?/import" enctype="multipart/form-data" class="mt-4 space-y-3">
      <input type="hidden" name="_csrf" value={data.csrfToken} />
      <Label for="font-file">Font file (TTF, OTF, WOFF, WOFF2; up to 8 MiB)</Label><Input id="font-file" name="file" type="file" accept=".ttf,.otf,.woff,.woff2" required />
      <Input name="licenseName" aria-label="License name" placeholder="License name" required />
      <label class="block">License text<textarea name="licenseText" class="mt-1 block min-h-24 w-full rounded border p-2" required></textarea></label>
      <label class="block"><input name="web" type="checkbox" /> My license permits embedding on websites</label>
      <label class="block"><input name="document" type="checkbox" /> My license permits embedding in documents</label>
      <Button type="submit">Import font file</Button>
    </form>
  </details>
  <section class="space-y-4">
    <h2 class="text-lg font-semibold">Installed fonts ({data.fonts.length})</h2>
    <Label for="font-specimen">Preview text (checked by your Caelo server; never sent to Google)</Label><Input id="font-specimen" bind:value={specimen} />
    <label class="block">Size: {size}px <input type="range" min="12" max="96" bind:value={size} /></label>
    {#each data.fonts as font (font.id)}
      <article class="space-y-3 rounded-lg border p-4">
        <h3 class="font-semibold">{font.family} · {font.subfamily}</h3>
        <p class="text-sm">{font.format.toUpperCase()} · {font.weight} · {font.style} · {font.glyphCount} glyphs · {font.license.name}</p>
        <p class="text-sm">Web embedding: {font.embedding.web ? 'yes' : 'no'} · Document embedding: {font.embedding.document ? 'yes' : 'no'}</p>
        {#if font.embedding.web}<FontSpecimen {font} text={specimen} {size} />{:else}<p>Web preview unavailable: web embedding is not permitted.</p>{/if}
        <details><summary class="cursor-pointer text-sm">Version, source and license</summary><p class="break-all text-xs">{font.id} · SHA-256 {font.sha256}<br />{font.source}<br />{font.createdAt}</p><pre class="max-h-52 overflow-auto whitespace-pre-wrap text-xs">{font.license.text}</pre></details>
        {#if font.embedding.web && data.themes.length}
          <form method="post" action="?/bind" class="flex flex-wrap items-center gap-3">
            <input type="hidden" name="_csrf" value={data.csrfToken} /><input type="hidden" name="id" value={font.id} /><input type="hidden" name="sha256" value={font.sha256} />
            <select name="themeSlug" aria-label="Theme" class="rounded border bg-background p-2">{#each data.themes as theme}<option value={theme.slug}>{theme.displayName}{theme.isActive ? ' (active)' : ''}</option>{/each}</select>
            <select name="role" aria-label="Typography role" class="rounded border bg-background p-2"><option value="body">Body</option><option value="heading">Heading</option><option value="display">Display</option><option value="mono">Monospace</option></select>
            <Button type="submit" variant="outline">Assign to theme</Button>
          </form>
        {/if}
      </article>
    {/each}
    {#if data.hasMore}<p>More font revisions are available. Narrow your search to see them.</p>{/if}
    {#if !data.fonts.length}<p>No imported fonts match this search. Import a Google font or upload your own font file to begin.</p>{/if}
  </section>
</div>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { FontMetadata } from "@caelo-cms/shared";
  let { font, text = "Große Geschichten beginnen mit kleinen Buchstaben. ÄÖÜ äöü ß 0123456789", size = 32 }: { font: FontMetadata; text?: string; size?: number } = $props();
  let status = $state("Loading font…");
  let ready = $state(false);
  $effect(() => {
    let active = true;
    ready = false;
    status = "Loading font…";
    const face = new FontFace(font.cssFamily, `url("/design/fonts/${font.id}?sha256=${font.sha256}")`, { weight: font.axes.wght ? `${font.axes.wght.min} ${font.axes.wght.max}` : String(font.weight), style: font.style });
    const specimen = text;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
    try {
      const response = await fetch("/design/fonts/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: font.id, sha256: font.sha256, use: "web", formats: [font.format], text: specimen }), signal: controller.signal });
      const validation = await response.json();
      if (!response.ok || !validation.ok) throw new Error(validation.error ?? "Font validation failed");
      const loaded = await face.load();
      if (!active) return;
      document.fonts.add(loaded); ready = true; status = "Loaded exact font revision";
    } catch (e) { if (active) status = e instanceof Error ? e.message : "Font could not be loaded. Preview unavailable."; }
    }, 200);
    return () => { active = false; clearTimeout(timer); controller.abort(); document.fonts.delete(face); };
  });
</script>
<p class="text-xs text-muted-foreground" role="status">{status}</p>
{#if ready}
  <p data-font-specimen={font.id} class="break-words py-4" style:font-family={font.cssFamily} style:font-weight={font.weight} style:font-style={font.style} style:font-size={`${size}px`}>{text}</p>
{/if}

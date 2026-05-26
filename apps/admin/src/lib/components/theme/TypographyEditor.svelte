<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.11.1 (issue #76) — Typography tab.
   *
   * Two sections:
   *   1. **Named text styles** (heading / body / mono / display) —
   *      composite rows with fontFamily / fontSize / fontWeight /
   *      lineHeight. fontFamily uses the FontFamilyPicker dropdown
   *      backed by /design/themes/api/fonts.
   *   2. **Type scale** (xs / sm / base / lg / xl / 2xl / 3xl / 4xl /
   *      5xl) — Tailwind-shaped tier rows with just fontSize, plus a
   *      preview line rendered at the assigned size. Renderer emits
   *      `--text-<tier>` for each (typography.<tier>.fontSize).
   *
   * Both sections post to ?/updateTokens with loose names; the server
   * normalizer maps to canonical DTCG paths.
   */
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import type { ThemeDocument } from "@caelo-cms/shared";
  import FontFamilyPicker from "./FontFamilyPicker.svelte";

  interface Props {
    tokens: ThemeDocument;
    csrfToken: string;
    themeSlug: string;
    onTokensChange: (next: ThemeDocument) => void;
  }
  let { tokens, csrfToken, themeSlug, onTokensChange }: Props = $props();

  const NAMED_STYLES = ["heading", "body", "mono", "display"] as const;
  const TYPE_SCALE = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl"] as const;
  type SubField = "fontFamily" | "fontSize" | "fontWeight" | "lineHeight";

  function read(style: string, sub: SubField): string {
    const t = tokens as Record<string, unknown> | null;
    const tg = t?.typography as Record<string, unknown> | undefined;
    const tok = tg?.[style] as Record<string, unknown> | undefined;
    const v = tok?.$value as Record<string, unknown> | undefined;
    const raw = v?.[sub];
    return raw === undefined || raw === null ? "" : String(raw);
  }

  function setSub(style: string, sub: SubField, value: string): void {
    const next: Record<string, unknown> = JSON.parse(JSON.stringify(tokens));
    const tg = (next.typography as Record<string, unknown> | undefined) ?? {};
    const existing = tg[style] as Record<string, unknown> | undefined;
    const existingValue = (existing?.$value as Record<string, unknown> | undefined) ?? {};
    let parsed: unknown = value;
    if (sub === "fontWeight" && value.trim().length > 0 && /^\d+$/.test(value.trim())) {
      parsed = Number(value);
    } else if (sub === "lineHeight" && /^[0-9.]+$/.test(value.trim())) {
      parsed = Number(value);
    }
    const nextValue = { ...existingValue, [sub]: parsed };
    tg[style] = { ...(existing ?? {}), $value: nextValue, $type: "typography" };
    next.typography = tg;
    onTokensChange(next as ThemeDocument);
  }

  /**
   * v0.11.0 normalizer maps loose `font<NameCap>` → typography.<name>.fontFamily.
   * For named styles we keep that pattern. For type-scale tiers (xs/sm/...)
   * we send the canonical path directly so the normalizer doesn't have
   * to infer (the names don't carry a font/text/spacing hint).
   */
  function looseFormName(style: string, sub: SubField): string {
    if (sub === "fontFamily" && /^(heading|body|mono|display)$/.test(style)) {
      return `font${style.charAt(0).toUpperCase()}${style.slice(1)}`;
    }
    return `typography.${style}.${sub}`;
  }
</script>

<form method="post" action="?/updateTokens" class="space-y-6">
  <input type="hidden" name="_csrf" value={csrfToken} />
  <input type="hidden" name="themeSlug" value={themeSlug} />

  <!-- ─── Named text styles ─── -->
  <section class="space-y-3">
    <div>
      <h3 class="text-sm font-medium">Named text styles</h3>
      <p class="text-xs text-muted-foreground">
        Each sub-field maps to a CSS variable
        (<code>--font-heading</code>, <code>--text-heading</code>,
        <code>--font-weight-heading</code>, <code>--leading-heading</code>).
      </p>
    </div>
    {#each NAMED_STYLES as style (style)}
      {@const fontFamily = read(style, "fontFamily")}
      {@const fontSize = read(style, "fontSize")}
      {@const fontWeight = read(style, "fontWeight")}
      <div class="rounded-md border p-3 space-y-2">
        <div class="flex items-center gap-2">
          <Label class="text-xs font-mono">typography.{style}</Label>
          <p
            class="ml-auto text-xs italic text-muted-foreground truncate max-w-xs"
            style={`font-family: ${fontFamily || "inherit"}; font-size: ${fontSize || "inherit"}; font-weight: ${fontWeight || "inherit"};`}
          >
            Preview: The quick brown fox
          </p>
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div class="grid gap-1">
            <Label for={`t-${style}-ff`} class="text-xs">Font family</Label>
            <FontFamilyPicker
              name={looseFormName(style, "fontFamily")}
              value={fontFamily}
              placeholder="Inter, system-ui, sans-serif"
              onChange={(v) => setSub(style, "fontFamily", v)}
            />
          </div>
          <div class="grid gap-1">
            <Label for={`t-${style}-fs`} class="text-xs">Font size</Label>
            <Input
              id={`t-${style}-fs`}
              name={looseFormName(style, "fontSize")}
              value={fontSize}
              oninput={(e) => setSub(style, "fontSize", (e.target as HTMLInputElement).value)}
              placeholder="1rem"
              class="text-xs"
            />
          </div>
          <div class="grid gap-1">
            <Label for={`t-${style}-fw`} class="text-xs">Font weight</Label>
            <Input
              id={`t-${style}-fw`}
              name={looseFormName(style, "fontWeight")}
              value={fontWeight}
              oninput={(e) => setSub(style, "fontWeight", (e.target as HTMLInputElement).value)}
              placeholder="400"
              class="text-xs"
            />
          </div>
          <div class="grid gap-1">
            <Label for={`t-${style}-lh`} class="text-xs">Line height</Label>
            <Input
              id={`t-${style}-lh`}
              name={looseFormName(style, "lineHeight")}
              value={read(style, "lineHeight")}
              oninput={(e) => setSub(style, "lineHeight", (e.target as HTMLInputElement).value)}
              placeholder="1.5"
              class="text-xs"
            />
          </div>
        </div>
      </div>
    {/each}
  </section>

  <!-- ─── Type scale ─── -->
  <section class="space-y-3">
    <div>
      <h3 class="text-sm font-medium">Type scale</h3>
      <p class="text-xs text-muted-foreground">
        Tailwind-shaped scale: each tier emits a <code>--text-&lt;tier&gt;</code> CSS variable
        modules use to size body / heading text by tier.
      </p>
    </div>
    <div class="space-y-2">
      {#each TYPE_SCALE as tier (tier)}
        {@const fs = read(tier, "fontSize")}
        <div class="flex items-center gap-3 rounded-md border p-2">
          <Label for={`t-scale-${tier}`} class="w-12 text-xs font-mono">{tier}</Label>
          <Input
            id={`t-scale-${tier}`}
            name={looseFormName(tier, "fontSize")}
            value={fs}
            oninput={(e) => setSub(tier, "fontSize", (e.target as HTMLInputElement).value)}
            placeholder="1rem"
            class="w-28 font-mono text-xs"
          />
          <p
            class="flex-1 truncate italic text-muted-foreground"
            style={`font-size: ${fs || "1rem"}; line-height: 1.1;`}
          >
            Preview: The quick brown fox
          </p>
        </div>
      {/each}
    </div>
  </section>

  <div class="flex justify-end">
    <Button type="submit">Save typography</Button>
  </div>
</form>

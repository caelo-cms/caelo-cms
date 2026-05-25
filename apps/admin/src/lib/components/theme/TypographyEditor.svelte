<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  // v0.11.1 (issue #76) — Typography tab. Per-named-style row with
  // fontFamily / fontSize / fontWeight / lineHeight inputs. Submits
  // via themes.update_tokens loose-name path.
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import type { ThemeDocument } from "@caelo-cms/shared";

  interface Props {
    tokens: ThemeDocument;
    csrfToken: string;
    themeSlug: string;
    onTokensChange: (next: ThemeDocument) => void;
  }
  let { tokens, csrfToken, themeSlug, onTokensChange }: Props = $props();

  const NAMED_STYLES = ["heading", "body", "mono", "display"] as const;
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
</script>

<form method="post" action="?/updateTokens" class="space-y-4">
  <input type="hidden" name="_csrf" value={csrfToken} />
  <input type="hidden" name="themeSlug" value={themeSlug} />
  <p class="text-sm text-muted-foreground">
    Named text styles. Each sub-field maps to a CSS variable
    (<code>--font-heading</code>, <code>--text-heading</code>,
    <code>--font-weight-heading</code>, <code>--leading-heading</code>).
  </p>
  <div class="space-y-3">
    {#each NAMED_STYLES as style (style)}
      <div class="rounded-md border p-3 space-y-2">
        <div class="flex items-center gap-2">
          <Label class="text-xs font-mono">typography.{style}</Label>
          <p
            class="ml-auto text-xs italic text-muted-foreground"
            style="font-family: {read(style, 'fontFamily') || 'inherit'}; font-size: {read(style, 'fontSize') || 'inherit'}; font-weight: {read(style, 'fontWeight') || 'inherit'};"
          >
            Preview: The quick brown fox
          </p>
        </div>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div class="grid gap-1">
            <Label for={`t-${style}-ff`} class="text-xs">Font family</Label>
            <Input
              id={`t-${style}-ff`}
              name={`font${style.charAt(0).toUpperCase()}${style.slice(1)}`}
              value={read(style, "fontFamily")}
              oninput={(e) => setSub(style, "fontFamily", (e.target as HTMLInputElement).value)}
              placeholder="Inter, system-ui, sans-serif"
              class="text-xs"
            />
          </div>
          <div class="grid gap-1">
            <Label for={`t-${style}-fs`} class="text-xs">Font size</Label>
            <Input
              id={`t-${style}-fs`}
              value={read(style, "fontSize")}
              oninput={(e) => setSub(style, "fontSize", (e.target as HTMLInputElement).value)}
              placeholder="1rem"
              class="text-xs"
            />
          </div>
          <div class="grid gap-1">
            <Label for={`t-${style}-fw`} class="text-xs">Font weight</Label>
            <Input
              id={`t-${style}-fw`}
              value={read(style, "fontWeight")}
              oninput={(e) => setSub(style, "fontWeight", (e.target as HTMLInputElement).value)}
              placeholder="400"
              class="text-xs"
            />
          </div>
          <div class="grid gap-1">
            <Label for={`t-${style}-lh`} class="text-xs">Line height</Label>
            <Input
              id={`t-${style}-lh`}
              value={read(style, "lineHeight")}
              oninput={(e) => setSub(style, "lineHeight", (e.target as HTMLInputElement).value)}
              placeholder="1.5"
              class="text-xs"
            />
          </div>
        </div>
      </div>
    {/each}
  </div>
  <div class="flex justify-end">
    <Button type="submit">Save typography</Button>
  </div>
</form>

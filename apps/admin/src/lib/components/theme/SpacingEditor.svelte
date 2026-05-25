<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  // v0.11.1 (issue #76) — Spacing tab with horizontal-bar previews.
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

  const STOPS = ["xs", "sm", "md", "lg", "xl", "2xl"] as const;

  function read(stop: string): string {
    const t = tokens as Record<string, unknown> | null;
    const sg = t?.spacing as Record<string, unknown> | undefined;
    const tok = sg?.[stop] as Record<string, unknown> | undefined;
    const v = tok?.$value;
    return typeof v === "string" ? v : "";
  }

  function set(stop: string, value: string): void {
    const next: Record<string, unknown> = JSON.parse(JSON.stringify(tokens));
    const sg = (next.spacing as Record<string, unknown> | undefined) ?? {};
    sg[stop] = { $value: value, $type: "dimension" };
    next.spacing = sg;
    onTokensChange(next as ThemeDocument);
  }

  function barWidth(value: string): string {
    const m = /^(\d+(?:\.\d+)?)/.exec(value);
    if (!m) return "0";
    const px = parseFloat(m[1]!) * 16; // rem ≈ 16px reference
    return `${Math.max(2, Math.min(192, px))}px`;
  }
</script>

<form method="post" action="?/updateTokens" class="space-y-4">
  <input type="hidden" name="_csrf" value={csrfToken} />
  <input type="hidden" name="themeSlug" value={themeSlug} />
  <p class="text-sm text-muted-foreground">
    Spacing scale shipped as <code>--spacing-xs</code> through <code>--spacing-2xl</code>.
  </p>
  <div class="space-y-2">
    {#each STOPS as stop (stop)}
      <div class="flex items-center gap-3">
        <Label for={`s-${stop}`} class="w-12 text-xs font-mono">{stop}</Label>
        <Input
          id={`s-${stop}`}
          name={`spacing${stop.charAt(0).toUpperCase()}${stop.slice(1)}`}
          value={read(stop)}
          oninput={(e) => set(stop, (e.target as HTMLInputElement).value)}
          placeholder="1rem"
          class="w-32 font-mono text-xs"
        />
        <div
          class="h-3 rounded bg-primary"
          style={`width: ${barWidth(read(stop))};`}
          aria-hidden="true"
        ></div>
      </div>
    {/each}
  </div>
  <div class="flex justify-end">
    <Button type="submit">Save spacing</Button>
  </div>
</form>

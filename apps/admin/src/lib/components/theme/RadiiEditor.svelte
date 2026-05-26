<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  // v0.11.1 (issue #76) — Radii tab with sample-button previews.
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

  const STOPS = ["sm", "md", "lg", "xl", "2xl", "full"] as const;

  function read(stop: string): string {
    const t = tokens as Record<string, unknown> | null;
    const rg = t?.radius as Record<string, unknown> | undefined;
    const tok = rg?.[stop] as Record<string, unknown> | undefined;
    const v = tok?.$value;
    return typeof v === "string" ? v : "";
  }

  function set(stop: string, value: string): void {
    const next: Record<string, unknown> = JSON.parse(JSON.stringify(tokens));
    const rg = (next.radius as Record<string, unknown> | undefined) ?? {};
    rg[stop] = { $value: value, $type: "dimension" };
    next.radius = rg;
    onTokensChange(next as ThemeDocument);
  }
</script>

<form method="post" action="?/updateTokens" class="space-y-4">
  <input type="hidden" name="_csrf" value={csrfToken} />
  <input type="hidden" name="themeSlug" value={themeSlug} />
  <p class="text-sm text-muted-foreground">
    Border-radius scale shipped as <code>--radius-sm</code> through <code>--radius-full</code>.
  </p>
  <div class="space-y-3">
    {#each STOPS as stop (stop)}
      <div class="flex items-center gap-3 rounded-md border p-3">
        <Label for={`r-${stop}`} class="w-12 text-xs font-mono">{stop}</Label>
        <Input
          id={`r-${stop}`}
          name={`radius${stop.charAt(0).toUpperCase()}${stop.slice(1)}`}
          value={read(stop)}
          oninput={(e) => set(stop, (e.target as HTMLInputElement).value)}
          placeholder="0.5rem"
          class="w-32 font-mono text-xs"
        />
        <div
          class="size-16 shrink-0 bg-primary"
          style={`border-radius: ${read(stop) || '0'};`}
          aria-hidden="true"
        ></div>
      </div>
    {/each}
  </div>
  <div class="flex justify-end">
    <Button type="submit">Save radii</Button>
  </div>
</form>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  // v0.11.1 (issue #76) — Shadows tab. Shows a preview card per stop,
  // plus the raw composite (color/offsetX/offsetY/blur/spread) sub-
  // fields editable inline.
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

  const STOPS = ["sm", "md", "lg", "xl", "2xl"] as const;
  const SUBFIELDS = ["color", "offsetX", "offsetY", "blur", "spread"] as const;
  type SubField = (typeof SUBFIELDS)[number];

  function readShadow(stop: string): Record<string, string> {
    const t = tokens as Record<string, unknown> | null;
    const sg = t?.shadow as Record<string, unknown> | undefined;
    const tok = sg?.[stop] as Record<string, unknown> | undefined;
    const v = tok?.$value;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const r: Record<string, string> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        r[k] = typeof vv === "string" ? vv : String(vv);
      }
      return r;
    }
    return {};
  }

  function setSub(stop: string, sub: SubField, value: string): void {
    const next: Record<string, unknown> = JSON.parse(JSON.stringify(tokens));
    const sg = (next.shadow as Record<string, unknown> | undefined) ?? {};
    const existing = sg[stop] as Record<string, unknown> | undefined;
    const existingValue =
      (existing?.$value as Record<string, unknown> | undefined) ?? {
        offsetX: "0",
        offsetY: "0",
        blur: "0",
        color: "rgba(0,0,0,0.1)",
      };
    sg[stop] = {
      ...(existing ?? {}),
      $value: { ...existingValue, [sub]: value },
      $type: "shadow",
    };
    next.shadow = sg;
    onTokensChange(next as ThemeDocument);
  }

  function previewCss(stop: string): string {
    const s = readShadow(stop);
    if (Object.keys(s).length === 0) return "none";
    const spread = s.spread ? ` ${s.spread}` : "";
    return `${s.offsetX ?? "0"} ${s.offsetY ?? "0"} ${s.blur ?? "0"}${spread} ${s.color ?? "rgba(0,0,0,0.1)"}`;
  }
</script>

<form method="post" action="?/updateTokens" class="space-y-4">
  <input type="hidden" name="_csrf" value={csrfToken} />
  <input type="hidden" name="themeSlug" value={themeSlug} />
  <p class="text-sm text-muted-foreground">
    Box-shadow scale shipped as <code>--shadow-sm</code> through <code>--shadow-2xl</code>.
  </p>
  <div class="space-y-3">
    {#each STOPS as stop (stop)}
      {@const s = readShadow(stop)}
      <div class="rounded-md border p-3 space-y-2">
        <div class="flex items-center gap-3">
          <Label class="w-12 text-xs font-mono">{stop}</Label>
          <div
            class="size-12 rounded bg-card"
            style={`box-shadow: ${previewCss(stop)};`}
            aria-hidden="true"
          ></div>
        </div>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {#each SUBFIELDS as sub (sub)}
            <div class="grid gap-1">
              <Label for={`sh-${stop}-${sub}`} class="text-xs">{sub}</Label>
              <Input
                id={`sh-${stop}-${sub}`}
                value={s[sub] ?? ""}
                oninput={(e) => setSub(stop, sub, (e.target as HTMLInputElement).value)}
                placeholder={sub === "color" ? "rgba(0,0,0,0.1)" : "0"}
                class="text-xs"
              />
            </div>
          {/each}
        </div>
      </div>
    {/each}
  </div>
  <div class="flex justify-end">
    <Button type="submit">Save shadows</Button>
  </div>
</form>

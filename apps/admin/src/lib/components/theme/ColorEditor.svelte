<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.11.1 (issue #76) — Colors tab.
   *
   * Swatch grid grouped by category. Each swatch is editable inline via
   * a paired `<input type="color">` (sRGB fallback) + a text input that
   * accepts hex / oklch / rgb / hsl. Light/dark variant toggle binds
   * `{light, dark}` color tokens.
   *
   * Form submission uses the loose-name path — `{set: {primary: "#…",
   * "primary-foreground": "#…"}}` to themes.update_tokens. v0.11.0's
   * server-side normalizeTokens converts to canonical DTCG paths.
   * No client-side canonicalisation (per plan §S4).
   *
   * WCAG contrast badges appear next to obvious paired tokens
   * (foreground vs background, each *-foreground vs * pair).
   */
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { parseColor } from "$lib/color/oklch.js";
  import type { ThemeDocument } from "@caelo-cms/shared";
  import ContrastWarning from "./ContrastWarning.svelte";

  interface Props {
    tokens: ThemeDocument;
    csrfToken: string;
    themeSlug: string;
    darkMode: boolean;
    onSetDarkMode: (next: boolean) => void;
    /** Called as the operator edits; component lifts the in-progress
     *  tokens to the parent so the LivePreview re-renders without
     *  needing a server round-trip. */
    onTokensChange: (next: ThemeDocument) => void;
  }
  let {
    tokens,
    csrfToken,
    themeSlug,
    darkMode,
    onSetDarkMode,
    onTokensChange,
  }: Props = $props();

  // Canonical color slot list. Mirrors the seeded default theme's
  // color group + the optional semantic warning/success names.
  const COLOR_SLOTS = [
    "background",
    "foreground",
    "primary",
    "primary-foreground",
    "secondary",
    "secondary-foreground",
    "accent",
    "accent-foreground",
    "muted",
    "muted-foreground",
    "card",
    "card-foreground",
    "border",
    "ring",
    "destructive",
    "destructive-foreground",
    "warning",
    "success",
  ] as const;

  // The obvious text-on-background pairs we show contrast warnings for.
  // N×N would be noise; only pairs that are visually adjacent in the UI
  // get a badge (per plan Risk §6.10).
  const CONTRAST_PAIRS: ReadonlyArray<{ fg: string; bg: string }> = [
    { fg: "foreground", bg: "background" },
    { fg: "card-foreground", bg: "card" },
    { fg: "primary-foreground", bg: "primary" },
    { fg: "secondary-foreground", bg: "secondary" },
    { fg: "accent-foreground", bg: "accent" },
    { fg: "muted-foreground", bg: "muted" },
    { fg: "destructive-foreground", bg: "destructive" },
  ];

  /** Read the active variant's color value for a slot. */
  function readColor(slot: string): string {
    const t = tokens as Record<string, unknown> | null;
    const colorGroup = t?.color as Record<string, unknown> | undefined;
    const token = colorGroup?.[slot] as Record<string, unknown> | undefined;
    if (!token) return "";
    if (typeof token.$value === "string") return token.$value;
    if (token.$value && typeof token.$value === "object") {
      const pair = token.$value as { light?: unknown; dark?: unknown };
      const v = darkMode ? pair.dark : pair.light;
      return typeof v === "string" ? v : "";
    }
    return "";
  }

  /** Best-effort hex for the <input type="color"> picker. */
  function readHex(slot: string): string {
    const raw = readColor(slot);
    if (!raw) return "#e5e5e5";
    try {
      return parseColor(raw).hex;
    } catch {
      return "#e5e5e5";
    }
  }

  /**
   * Lift a per-slot color edit to the parent tokens tree (in-memory)
   * so the LivePreview reflects it immediately. The actual server
   * write happens on form submission.
   */
  function setColorLocal(slot: string, value: string): void {
    const next: Record<string, unknown> = JSON.parse(JSON.stringify(tokens));
    const colorGroup = (next.color as Record<string, unknown> | undefined) ?? {};
    const existing = colorGroup[slot] as Record<string, unknown> | undefined;
    if (existing && existing.$value && typeof existing.$value === "object") {
      // Light/dark composite — only flip the active variant.
      const pair = { ...(existing.$value as { light?: unknown; dark?: unknown }) };
      if (darkMode) pair.dark = value;
      else pair.light = value;
      colorGroup[slot] = { ...existing, $value: pair };
    } else {
      // Flat or absent — set as a flat color leaf.
      colorGroup[slot] = { ...(existing ?? {}), $value: value, $type: "color" };
    }
    next.color = colorGroup;
    onTokensChange(next as ThemeDocument);
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between gap-2">
    <p class="text-sm text-muted-foreground">
      Edit color tokens. Pass hex (<code>#ff6600</code>), OKLCh (<code>oklch(0.7 0.18 30)</code>),
      or any CSS color string. Server normalises loose names to canonical DTCG paths on save.
    </p>
    <div class="flex items-center gap-2">
      <Label class="text-xs">Variant:</Label>
      <Button
        type="button"
        variant={darkMode ? "ghost" : "default"}
        size="sm"
        onclick={() => onSetDarkMode(false)}
      >Light</Button>
      <Button
        type="button"
        variant={darkMode ? "default" : "ghost"}
        size="sm"
        onclick={() => onSetDarkMode(true)}
      >Dark</Button>
    </div>
  </div>

  <form method="post" action="?/updateTokens" class="space-y-4">
    <input type="hidden" name="_csrf" value={csrfToken} />
    <input type="hidden" name="themeSlug" value={themeSlug} />

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {#each COLOR_SLOTS as slot (slot)}
        <div class="rounded-md border p-3">
          <div class="flex items-center justify-between gap-2">
            <Label for={`color-${slot}`} class="text-xs font-mono">{slot}</Label>
            {#each CONTRAST_PAIRS as p (`${p.fg}-${p.bg}`)}
              {#if p.fg === slot && readColor(p.bg)}
                <ContrastWarning
                  fg={readColor(p.fg)}
                  bg={readColor(p.bg)}
                  pair={`${p.fg} on ${p.bg}`}
                />
              {/if}
            {/each}
          </div>
          <div class="mt-2 flex items-center gap-2">
            <input
              id={`color-${slot}-picker`}
              type="color"
              value={readHex(slot)}
              onchange={(e) => setColorLocal(slot, (e.target as HTMLInputElement).value)}
              class="h-9 w-9 shrink-0 rounded border bg-background"
              aria-label={`${slot} color picker`}
            />
            <Input
              id={`color-${slot}`}
              name={slot}
              value={readColor(slot)}
              oninput={(e) => setColorLocal(slot, (e.target as HTMLInputElement).value)}
              placeholder="#hex / oklch(...)"
              class="font-mono text-xs"
            />
          </div>
        </div>
      {/each}
    </div>

    <div class="flex items-center justify-end gap-2">
      <Button type="submit">Save colors</Button>
    </div>
  </form>
</div>

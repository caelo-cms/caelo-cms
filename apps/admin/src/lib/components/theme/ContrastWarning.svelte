<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  // v0.11.1 (issue #76) — WCAG-AA contrast badge for the Colors tab.
  // AC #4: surface contrast on text-on-background swatch pairs.
  //
  // We DON'T grade every N×N swatch combination — that would be noise.
  // ColorEditor passes only the obvious paired tokens (foreground vs
  // background, primary-foreground vs primary, etc.); the badge shows
  // AAA / AA / AA Large / Fail per WCAG 2.1 thresholds.
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { wcagBadge, wcagContrast } from "$lib/color/contrast.js";

  interface Props {
    fg: string;
    bg: string;
    /** Label like "primary-foreground on primary" — read by screen readers. */
    pair: string;
  }
  let { fg, bg, pair }: Props = $props();

  const result = $derived.by(() => {
    try {
      const ratio = wcagContrast(fg, bg);
      return { ratio, grade: wcagBadge(ratio), error: null as string | null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ratio: NaN, grade: "Fail" as const, error: msg };
    }
  });

  const variant = $derived(
    result.grade === "AAA" || result.grade === "AA"
      ? "default"
      : result.grade === "AA Large"
        ? "secondary"
        : "destructive",
  );
</script>

<Badge {variant} aria-label={`Contrast for ${pair}: ${result.grade}`} title={`${pair}: ratio ${result.ratio.toFixed(2)}`}>
  {result.grade}
  {#if isFinite(result.ratio)}
    <span class="ml-1 text-[10px] opacity-80">{result.ratio.toFixed(1)}</span>
  {/if}
</Badge>

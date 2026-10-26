<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * One value of a plugin panel, as text. Plugin data can be visitor-
   * written (#635): every format renders through text interpolation,
   * never as markup.
   */

  import type { PanelValueDisplay } from "@caelo-cms/plugin-sdk";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { badgeVariant, formatValue } from "#lib/plugin-panels.js";

  interface Props {
    display: PanelValueDisplay;
    value: unknown;
  }
  let { display, value }: Props = $props();

  const text = $derived(formatValue(display, value));
</script>

{#if text === ""}
  <span class="text-muted-foreground" aria-label="empty">–</span>
{:else if display.format === "badge"}
  <Badge variant={badgeVariant(display, value)}>{text}</Badge>
{:else if display.format === "json"}
  <pre class="max-w-md overflow-auto whitespace-pre-wrap break-words text-xs">{text}</pre>
{:else if display.format === "multiline"}
  <p class="max-w-prose whitespace-pre-wrap break-words">{text}</p>
{:else if display.format === "code"}
  <span class="break-all font-mono text-xs">{text}</span>
{:else}
  <span>{text}</span>
{/if}

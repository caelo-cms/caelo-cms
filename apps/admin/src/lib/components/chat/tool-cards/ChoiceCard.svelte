<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Card for `offer_choices` tool results: the question plus one
   * BUTTON per option. Clicking posts "<key> — <label>" back as the
   * operator's message (via ChatPanel's sendAutoMessage), so the AI
   * receives an unambiguous answer without the operator typing.
   *
   * Content contract (see offer-choices.ts):
   *   "Choices offered: <question>\n<KEY>) <label> — <description>"
   *
   * `chosen` only guards double-clicks within this render; after a
   * reload the buttons are clickable again, which is harmless — the
   * AI simply receives the answer once more.
   */

  import { Button } from "$lib/components/ui/button/index.js";

  interface Props {
    content: string;
    disabled?: boolean;
    onChoose?: (answer: string) => void;
  }
  let { content, disabled = false, onChoose }: Props = $props();

  interface ParsedChoice {
    key: string;
    label: string;
    description: string | null;
  }

  const parsed = $derived.by(() => {
    const lines = content.split("\n");
    const first = lines[0] ?? "";
    if (!first.startsWith("Choices offered: ")) return null;
    const question = first.slice("Choices offered: ".length).trim();
    const options: ParsedChoice[] = [];
    for (const line of lines.slice(1)) {
      const m = /^([^)]{1,3})\)\s+(.+?)(?:\s+—\s+(.+))?$/.exec(line.trim());
      if (m?.[1] && m[2]) options.push({ key: m[1], label: m[2], description: m[3] ?? null });
    }
    if (!question || options.length < 2) return null;
    return { question, options };
  });

  let chosen = $state<string | null>(null);
</script>

{#if parsed}
  <div class="space-y-2 rounded-md border bg-card p-3 text-sm" data-testid="choice-card">
    <p class="font-medium">{parsed.question}</p>
    <div class="flex flex-col gap-1.5">
      {#each parsed.options as o (o.key)}
        <Button
          type="button"
          variant={chosen === o.key ? "default" : "outline"}
          class="h-auto justify-start whitespace-normal py-2 text-left"
          disabled={disabled || (chosen !== null && chosen !== o.key)}
          data-testid="choice-option"
          onclick={() => {
            if (chosen !== null) return;
            chosen = o.key;
            onChoose?.(`${o.key} — ${o.label}`);
          }}
        >
          <span class="mr-2 font-mono text-xs opacity-70">{o.key}</span>
          <span>
            {o.label}
            {#if o.description}
              <span class="block text-xs font-normal text-muted-foreground">{o.description}</span>
            {/if}
          </span>
        </Button>
      {/each}
    </div>
  </div>
{:else}
  <!-- Non-canonical content (future drift) degrades to plain text
       rather than hiding the question. -->
  <p class="text-sm">{content}</p>
{/if}

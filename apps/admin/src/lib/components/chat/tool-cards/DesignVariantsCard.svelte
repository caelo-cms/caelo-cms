<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * issue #375 — card for `present_design_variants` tool results: one
   * live preview per design variant + a pick button. Each variant
   * renders via /design/drafts/<id>/preview, where the server composes
   * fragments into the site's REAL theme shell — so the operator judges
   * the variant in the site's actual fonts and palette, not a mock.
   *
   * Sandbox stance (see the preview route): `allow-same-origin` keeps
   * the session cookie on font/media subresource requests; NO
   * `allow-scripts` — script execution stays impossible on top of the
   * storage-boundary strip.
   *
   * Content contract (see design-draft-tools.ts):
   *   "Design variants ready: <heading>\nset <uuid>\n- <id> | <direction> | <rationale>"
   *
   * Clicking Pick posts the draft id back as the operator's message
   * (the ChoiceCard precedent) — the AI then runs select_design_draft
   * and materialises. `chosen` only guards double-clicks within this
   * render; after a reload the buttons are clickable again, which is
   * harmless — the AI simply receives the answer once more.
   */

  import { Button } from "$lib/components/ui/button/index.js";

  interface Props {
    content: string;
    disabled?: boolean;
    onChoose?: (answer: string) => void;
  }
  let { content, disabled = false, onChoose }: Props = $props();

  interface ParsedVariant {
    id: string;
    direction: string;
    rationale: string;
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  const parsed = $derived.by(() => {
    const lines = content.split("\n");
    const first = lines[0] ?? "";
    if (!first.startsWith("Design variants ready: ")) return null;
    const heading = first.slice("Design variants ready: ".length).trim();
    const variants: ParsedVariant[] = [];
    for (const line of lines.slice(1)) {
      if (!line.startsWith("- ")) continue;
      const [id, direction, rationale] = line.slice(2).split(" | ", 3);
      if (id !== undefined && UUID_RE.test(id.trim()) && direction) {
        variants.push({
          id: id.trim(),
          direction: direction.trim(),
          rationale: rationale?.trim() ?? "",
        });
      }
    }
    if (variants.length === 0) return null;
    return { heading, variants };
  });

  let chosen = $state<string | null>(null);
</script>

{#if parsed}
  <div class="space-y-3 rounded-md border bg-card p-3 text-sm" data-testid="design-variants-card">
    <p class="font-medium">{parsed.heading}</p>
    {#each parsed.variants as v (v.id)}
      <div
        class="overflow-hidden rounded-md border {chosen === v.id ? 'ring-primary ring-2' : ''}"
        data-testid="design-variant"
      >
        <iframe
          title={v.direction}
          src={`/design/drafts/${v.id}/preview`}
          sandbox="allow-same-origin"
          loading="lazy"
          class="bg-background h-64 w-full border-b"
        ></iframe>
        <div class="flex items-start justify-between gap-3 p-2.5">
          <div class="min-w-0">
            <div class="text-sm font-medium">{v.direction}</div>
            {#if v.rationale}
              <p class="text-muted-foreground mt-0.5 text-xs">{v.rationale}</p>
            {/if}
          </div>
          <Button
            type="button"
            size="sm"
            variant={chosen === v.id ? "default" : "outline"}
            disabled={disabled || (chosen !== null && chosen !== v.id)}
            data-testid="design-variant-pick"
            onclick={() => {
              if (chosen !== null) return;
              chosen = v.id;
              onChoose?.(`I pick the variant "${v.direction}" (draft ${v.id}) — please implement it.`);
            }}
          >
            Pick
          </Button>
        </div>
      </div>
    {/each}
    <p class="text-muted-foreground text-xs">
      Compare full-size at <a href="/design/genesis" class="underline">/design/genesis</a> — or
      describe what you'd change about any variant.
    </p>
  </div>
{:else}
  <!-- Non-canonical content (future drift) degrades to plain text
       rather than hiding the result. -->
  <p class="text-sm">{content}</p>
{/if}

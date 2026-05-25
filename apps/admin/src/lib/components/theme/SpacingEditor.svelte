<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.11.1 (issue #76) — Spacing tab with horizontal-bar previews
   * and add/remove row UI.
   *
   * Rows derive from the current tokens.spacing keys (plus any keys
   * the operator has locally added but not yet saved). Add appends a
   * new row with an empty value — the operator types the value and
   * clicks Save (which posts the loose-name set via
   * themes.update_tokens). Remove submits a per-row form to
   * ?/removeToken which calls themes.update_tokens with the canonical
   * path in `remove`.
   *
   * Save committing both adds AND mutations of existing rows works
   * because update_tokens treats `set` as upsert-per-canonical-path.
   *
   * v0.11.1 (e2e round 1 fix #1) — the per-row remove form CANNOT be
   * a descendant of the outer save form (HTML invalid; Svelte 5
   * fails to hydrate via `TypeError: input.hasAttribute is not a function`
   * because the browser auto-closes the outer form when it parses the
   * nested one). DOM layout is now flat: the save form contains only
   * its own hidden inputs + Save button. Each row's value Input is
   * a sibling of the save form and links to it via the `form="..."`
   * attribute (well-supported, modern browsers). Each row's Remove
   * form is also a sibling. Visually, CSS lays them out as
   * grid/flex rows.
   */
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

  // v0.11.1 — extra stops the operator has added in this session but
  // not yet saved. Tracked locally because tokens reflects the most
  // recent in-progress edits already (via onTokensChange) but we want
  // brand-new keys to appear immediately even when their value is
  // empty (operator can't type into an input that doesn't render yet).
  let pendingNewStops = $state<string[]>([]);
  let newStopName = $state("");

  // v0.11.1 — stable id for the outer save form so per-row inputs
  // can opt-in via `form="..."`. Generated once at mount so multiple
  // SpacingEditor instances on the same page wouldn't collide.
  const formId = `spacing-save-${Math.random().toString(36).slice(2, 10)}`;

  /** Sorted list of stop keys: existing tokens.spacing keys + pending new. */
  const stops = $derived.by(() => {
    const t = tokens as Record<string, unknown> | null;
    const sg = t?.spacing as Record<string, unknown> | undefined;
    const existing = sg ? Object.keys(sg).filter((k) => !k.startsWith("$")) : [];
    const all = new Set([...existing, ...pendingNewStops]);
    return [...all].sort((a, b) => spacingSortKey(a) - spacingSortKey(b));
  });

  /**
   * Approximate sort key so xs < sm < md < lg < xl < 2xl < 3xl < ... .
   * Unknown / custom names fall to the end alphabetically.
   */
  function spacingSortKey(name: string): number {
    const idx = ["xs", "sm", "md", "base", "lg", "xl"].indexOf(name);
    if (idx >= 0) return idx;
    const m = /^(\d+)xl$/.exec(name);
    if (m) return 6 + parseInt(m[1]!, 10);
    return 100; // unknown names sort last
  }

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

  function addStop(): void {
    const name = newStopName.trim();
    if (name.length === 0) return;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return;
    if (stops.includes(name)) return;
    pendingNewStops = [...pendingNewStops, name];
    newStopName = "";
  }

  function looseFormName(stop: string): string {
    // Canonical DTCG path so the normalizer doesn't have to infer
    // (custom names like `3xl` lack a category hint).
    return `spacing.${stop}`;
  }

  function barWidth(value: string): string {
    const m = /^(\d+(?:\.\d+)?)/.exec(value);
    if (!m) return "0";
    const px = parseFloat(m[1]!) * 16; // rem ≈ 16px reference
    return `${Math.max(2, Math.min(192, px))}px`;
  }
</script>

<div class="space-y-4">
  <p class="text-sm text-muted-foreground">
    Spacing scale shipped as <code>--spacing-&lt;key&gt;</code>. Add custom stops below; per-row
    <strong>Remove</strong> drops the canonical path.
  </p>

  <!--
    Save form — owns only the hidden setup fields and the Save button.
    Per-row inputs link to it via `form={formId}` (HTML form-attribute,
    not DOM parentage) so the save submission sends every row's value
    in one batch. v0.11.1 (e2e round 1 fix #1): NO per-row forms are
    nested inside this one, so the browser doesn't auto-close it and
    Svelte 5 hydrates cleanly.
  -->
  <form method="post" action="?/updateTokens" id={formId}>
    <input type="hidden" name="_csrf" value={csrfToken} />
    <input type="hidden" name="themeSlug" value={themeSlug} />
  </form>

  <div class="space-y-2">
    {#each stops as stop (stop)}
      <div class="flex items-center gap-3 rounded-md border p-2">
        <Label for={`s-${stop}`} class="w-12 text-xs font-mono">{stop}</Label>
        <!-- Input belongs to the save form via the form="..." attribute,
             not DOM nesting. Modern browsers honour this. -->
        <Input
          id={`s-${stop}`}
          name={looseFormName(stop)}
          value={read(stop)}
          oninput={(e) => set(stop, (e.target as HTMLInputElement).value)}
          placeholder="1rem"
          class="w-32 font-mono text-xs"
          form={formId}
        />
        <div
          class="h-3 rounded bg-primary"
          style={`width: ${barWidth(read(stop))};`}
          aria-hidden="true"
        ></div>
        <!-- Per-row remove form is a SIBLING of the save form, not a
             descendant. Submits immediately on click; the layout
             keeps it visually inside the row via the parent flex. -->
        <form method="post" action="?/removeToken" class="ml-auto">
          <input type="hidden" name="_csrf" value={csrfToken} />
          <input type="hidden" name="themeSlug" value={themeSlug} />
          <input type="hidden" name="path" value={looseFormName(stop)} />
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            aria-label={`Remove ${stop}`}
            title={`Remove ${stop}`}
          >
            ×
          </Button>
        </form>
      </div>
    {/each}
  </div>

  <div class="flex justify-end">
    <Button type="submit" form={formId}>Save spacing</Button>
  </div>

  <div class="flex items-end gap-2 rounded-md border bg-muted/30 p-3">
    <div class="grid gap-1">
      <Label for="s-new-name" class="text-xs">Add stop</Label>
      <!-- v0.11.1 (e2e round 1 fix #2): pattern uses non-character-
           class alternation so it parses under modern Chrome's
           v-flag regex (bare `-` in [a-z0-9-] was rejected as
           "Invalid character class"). -->
      <Input
        id="s-new-name"
        bind:value={newStopName}
        placeholder="3xl"
        pattern={"[a-z0-9](?:[a-z0-9]|-)*"}
        class="w-28 font-mono text-xs"
      />
    </div>
    <Button type="button" variant="outline" size="sm" onclick={addStop}>Add stop</Button>
    <p class="ml-2 text-xs text-muted-foreground">
      Then enter a value above and click <strong>Save spacing</strong>.
    </p>
  </div>
</div>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.11.1 (issue #76) — sticky right-pane live preview.
   *
   * Renders representative sample DOM (heading, two buttons, a card,
   * an input form) scoped under `.theme-preview` so the previewed CSS
   * variables don't leak onto the admin chrome. Uses the public
   * site's `renderThemeCss` path with the new v0.11.1 `selector`
   * option — what the operator sees is byte-for-byte what visitors
   * will see (AC #3 byte-for-byte invariant).
   *
   * Re-renders on every token mutation with a 50ms debounce (Risk §6.12
   * mitigation) so rapid keystrokes coalesce into one renderThemeCss
   * call instead of N. For shadcn-default-sized themes the per-call
   * cost is sub-millisecond, but a slow client or a large multi-theme
   * install benefits from coalescing; the 50ms delay is below the
   * human-perception threshold (~100ms) so the operator still sees an
   * 'immediate' update.
   */
  import { renderThemeCss, type ThemeDocument } from "@caelo-cms/shared";

  interface Props {
    tokens: ThemeDocument;
    /** Toggle the dark variant class for previewing dark-mode tokens. */
    darkMode?: boolean;
  }
  let { tokens, darkMode = false }: Props = $props();

  // Debounced mirror of `tokens` — drives the preview render so a
  // typing burst coalesces into a single CSS recompute. Initialise
  // with the first incoming value so the first paint is immediate.
  let debouncedTokens = $state<ThemeDocument>(tokens);
  $effect(() => {
    const next = tokens;
    const id = setTimeout(() => {
      debouncedTokens = next;
    }, 50);
    return () => clearTimeout(id);
  });

  // Scope to `.theme-preview` so the CSS variables only apply inside
  // the sample DOM below — not the surrounding admin shell.
  function safeRender(t: ThemeDocument): string {
    try {
      return renderThemeCss(t, { selector: ".theme-preview" });
    } catch (_e) {
      // Render error (e.g. broken alias) — keep the preview visible
      // even if the document is mid-edit and not yet valid.
      return ".theme-preview{}";
    }
  }
  const themeCss = $derived(safeRender(debouncedTokens));
  const themeStyleTag = $derived(`<style>${themeCss}</style>`);
</script>

<aside class="space-y-3">
  <h2 class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Live preview</h2>
  <div class="rounded-lg border p-4 shadow-sm">
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html themeStyleTag}
    <div
      class={"theme-preview" + (darkMode ? " dark" : "")}
      data-testid="theme-preview"
      style="background:var(--color-background, white); color:var(--color-foreground, black); padding:1.25rem; border-radius:var(--radius-md, 0.5rem);"
    >
      <h3
        style="font-family:var(--font-heading, system-ui); font-size:var(--text-heading, 1.5rem); font-weight:var(--font-weight-heading, 700); margin:0 0 0.5rem 0;"
      >
        Preview heading
      </h3>
      <p
        style="font-family:var(--font-body, system-ui); font-size:var(--text-body, 1rem); margin:0 0 1rem 0; color:var(--color-muted-foreground, #666);"
      >
        Sample body text — this is what visitors will see with the active theme tokens applied.
      </p>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:1rem;">
        <button
          type="button"
          style="background:var(--color-primary, #171717); color:var(--color-primary-foreground, white); padding:0.5rem 1rem; border-radius:var(--radius-md, 0.5rem); border:none; font-size:0.875rem; cursor:pointer;"
        >
          Primary
        </button>
        <button
          type="button"
          style="background:var(--color-secondary, #f5f5f5); color:var(--color-secondary-foreground, #171717); padding:0.5rem 1rem; border-radius:var(--radius-md, 0.5rem); border:1px solid var(--color-border, #e5e5e5); font-size:0.875rem; cursor:pointer;"
        >
          Secondary
        </button>
        <button
          type="button"
          style="background:var(--color-destructive, #dc2626); color:var(--color-destructive-foreground, white); padding:0.5rem 1rem; border-radius:var(--radius-md, 0.5rem); border:none; font-size:0.875rem; cursor:pointer;"
        >
          Destructive
        </button>
      </div>
      <div
        style="border:1px solid var(--color-border, #e5e5e5); border-radius:var(--radius-md, 0.5rem); padding:1rem; background:var(--color-card, white); box-shadow:var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.05));"
      >
        <p
          style="font-size:0.875rem; color:var(--color-card-foreground, #171717); margin:0 0 0.5rem 0;"
        >
          Card with input:
        </p>
        <input
          type="text"
          placeholder="Sample input"
          style="width:100%; padding:0.5rem; border:1px solid var(--color-border, #e5e5e5); border-radius:var(--radius-sm, 0.25rem); background:var(--color-background, white); color:var(--color-foreground, black); font-size:0.875rem;"
        />
      </div>
    </div>
  </div>
</aside>

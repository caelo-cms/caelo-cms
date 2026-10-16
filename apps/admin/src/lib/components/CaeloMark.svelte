<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Caelo's brand mark (Caelatum "vault with dot"): an outer arc, an
   * inner engraved arc and a dot. The single source for every in-app
   * rendering of the logo — the shell sidebar and the auth screens —
   * so a swap of the mark touches this file and the static favicons.
   *
   * Two variants, per the Caelatum concept:
   * - `open`: no background; the outer arc is `currentColor`, so the
   *   mark follows the surrounding text colour through light/dark mode.
   * - `plate`: the dark rounded square used at small sizes (the concept
   *   prescribes the plate below 24 px); colours are fixed because the
   *   plate carries its own background. Same geometry as favicon.svg.
   *
   * Always decorative (`aria-hidden`): the mark sits next to the "Caelo"
   * wordmark or inside a labelled link, which carries the accessible name.
   */

  interface Props {
    /** `open` (theme-following, default) or `plate` (fixed dark square). */
    variant?: "open" | "plate";
    /** Rendered width and height in px (the mark is square). */
    size?: number;
    class?: string;
  }
  let { variant = "open", size = 28, class: className = "" }: Props = $props();
</script>

<svg
  viewBox="0 0 32 32"
  width={size}
  height={size}
  class={className}
  aria-hidden="true"
  focusable="false"
  data-caelo-mark={variant}
>
  {#if variant === "plate"}
    <rect x="1" y="1" width="30" height="30" rx="8" fill="#0e1a2e" />
    <path
      d="M22.4 9.1A9.3 9.3 0 1 0 22.4 22.9"
      fill="none"
      stroke="#f3f5f9"
      stroke-width="3"
      stroke-linecap="round"
    />
    <path
      d="M20.2 11.6A6 6 0 1 0 20.2 20.4"
      fill="none"
      stroke="#c9952f"
      stroke-width="1"
      stroke-linecap="round"
    />
    <circle cx="24" cy="16" r="2.2" fill="#e8684a" />
  {:else}
    <path
      d="M23.07 7.57A11 11 0 1 0 23.07 24.43"
      fill="none"
      stroke="currentColor"
      stroke-width="3.4"
      stroke-linecap="round"
    />
    <path
      d="M20.5 10.64A7 7 0 1 0 20.5 21.36"
      fill="none"
      stroke="#c9952f"
      stroke-width="1.1"
      stroke-linecap="round"
    />
    <circle cx="25.2" cy="16" r="2.6" fill="#e8684a" />
  {/if}
</svg>

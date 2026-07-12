<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Caelo's mascot: a small friendly cloud (caelum, the sky) that
   * conjures pages out of thin air. Lives in empty states, building
   * moments, and error pages — it brands CAELO, never the AI
   * provider (CLAUDE.md 2: provider brand stays out of the editor).
   *
   * Pure inline SVG so it inherits the theme via currentColor. The
   * entrance is a one-time float-in; the idle bob is deliberately
   * slow and small (a mascot breathes, it doesn't blink for
   * attention). Both respect prefers-reduced-motion.
   */

  interface Props {
    /** Rendered width in px; height follows the 120:84 viewBox. */
    size?: number;
    class?: string;
  }
  let { size = 120, class: className = "" }: Props = $props();
</script>

<div class="caelo-mascot {className}" style:width="{size}px">
  <svg
    viewBox="0 0 120 84"
    width={size}
    height={size * 0.7}
    role="img"
    aria-label="Caelo, the friendly cloud"
  >
    <!-- sparkles: the "conjuring" hint -->
    <g class="caelo-sparkle text-primary" opacity="0.9">
      <path d="M99 16 l1.6 4.2 L105 22 l-4.4 1.8 L99 28 l-1.6 -4.2 L93 22 l4.4 -1.8 Z" fill="currentColor" />
      <path d="M17 30 l1.1 2.9 L21 34 l-2.9 1.1 L17 38 l-1.1 -2.9 L13 34 l2.9 -1.1 Z" fill="currentColor" opacity="0.7" />
      <circle cx="106" cy="38" r="1.6" fill="currentColor" opacity="0.6" />
    </g>
    <!-- cloud body -->
    <g class="text-muted-foreground">
      <path
        d="M30 62
           a14 14 0 0 1 -2 -27.8
           a19 19 0 0 1 36.5 -7.4
           a16 16 0 0 1 26.3 10.2
           a12.5 12.5 0 0 1 -1.8 25
           Z"
        fill="var(--card, #fff)"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linejoin="round"
      />
      <!-- face -->
      <circle cx="50" cy="46" r="2.6" fill="currentColor" />
      <circle cx="70" cy="46" r="2.6" fill="currentColor" />
      <path
        d="M53 53 q7 6 14 0"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      />
      <!-- cheeks -->
      <circle cx="42" cy="52" r="3" fill="currentColor" opacity="0.18" />
      <circle cx="78" cy="52" r="3" fill="currentColor" opacity="0.18" />
    </g>
  </svg>
</div>

<style>
  /* One-time entrance, then a slow breathe. Motion-sensitive users
     get a static mascot. */
  .caelo-mascot {
    animation: caelo-enter 0.9s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .caelo-mascot svg {
    animation: caelo-bob 5.5s ease-in-out 1.2s infinite;
  }
  .caelo-sparkle {
    animation: caelo-twinkle 5.5s ease-in-out 1.2s infinite;
  }
  @keyframes caelo-enter {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
  @keyframes caelo-bob {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-4px);
    }
  }
  @keyframes caelo-twinkle {
    0%,
    100% {
      opacity: 0.9;
    }
    50% {
      opacity: 0.45;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .caelo-mascot,
    .caelo-mascot svg,
    .caelo-sparkle {
      animation: none;
    }
  }
</style>

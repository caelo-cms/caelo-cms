<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Issue #685 — "Quality check found N issues on M pages … Let the AI fix
   * them?" The AI starts only on the button; "Not now" settles the offer
   * (Publish live stays blocked as the gate says). The operator may also
   * just type a message instead — the card stays until they decide.
   */

  import { ShieldAlert } from "lucide-svelte";
  import { Button } from "#lib/components/ui/button/index.js";

  interface Props {
    text: string;
    actionLabel: string;
    /** A click is being handled (claim / send / dismiss). */
    busy: boolean;
    /** The chat's AI is answering right now — one turn at a time. */
    aiBusy: boolean;
    error: string | null;
    onFix: () => void;
    onDismiss: () => void;
  }
  let { text, actionLabel, busy, aiBusy, error, onFix, onDismiss }: Props = $props();
</script>

<div
  class="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs"
  data-testid="quality-fix-offer"
>
  <div class="flex items-start gap-2">
    <ShieldAlert class="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />
    <p class="min-w-0 flex-1" data-testid="quality-fix-offer-text">{text}</p>
  </div>
  <div class="mt-2 flex flex-wrap items-center gap-2">
    <Button
      type="button"
      size="sm"
      disabled={busy || aiBusy}
      title={aiBusy ? "The AI is answering — wait until it is done" : undefined}
      data-testid="quality-fix-offer-fix"
      onclick={onFix}
    >
      {actionLabel}
    </Button>
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={busy}
      data-testid="quality-fix-offer-dismiss"
      onclick={onDismiss}
    >
      Not now
    </Button>
    <span class="text-muted-foreground">Or type what you want instead.</span>
  </div>
  {#if error}
    <p role="alert" class="mt-1.5 text-destructive" data-testid="quality-fix-offer-error">{error}</p>
  {/if}
</div>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * The single confirm dialog behind `requestConfirm` / `use:confirmSubmit`
   * (`#lib/confirm.svelte.ts`). Mounted once in the authed layout.
   *
   * `shown` keeps the last options while the dialog animates out — the
   * pending request is already cleared by then, and blanking the text
   * mid-fade reads as a glitch. Cancel sits first so the dialog's
   * initial focus lands on the safe choice; Enter does not delete.
   */
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "#lib/components/ui/dialog/index.js";
  import { type ConfirmOptions, confirmState, settleConfirm } from "#lib/confirm.svelte.js";

  let shown = $state<ConfirmOptions | null>(null);
  $effect(() => {
    if (confirmState.current) shown = confirmState.current;
  });
</script>

<Dialog
  open={confirmState.current !== null}
  onOpenChange={(open) => {
    if (!open) settleConfirm(false);
  }}
>
  <DialogContent data-testid="confirm-dialog">
    {#if shown}
      <DialogHeader>
        <DialogTitle>{shown.title}</DialogTitle>
        {#if shown.description}
          <DialogDescription>{shown.description}</DialogDescription>
        {/if}
      </DialogHeader>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onclick={() => settleConfirm(false)}
          data-testid="confirm-cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          onclick={() => settleConfirm(true)}
          data-testid="confirm-accept"
        >
          {shown.confirmLabel}
        </Button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>

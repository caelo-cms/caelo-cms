<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * A type change that would delete stored values (epic #1107): the server
   * refused it and named what would be lost. Confirming resends the same
   * change with `dropValues`; the deletion is a snapshot like any change,
   * so it can be undone.
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

  interface Props {
    /** The server's message; null = closed. */
    message: string | null;
    onconfirm: () => void;
    onclose: () => void;
  }
  let { message, onconfirm, onclose }: Props = $props();
</script>

<Dialog open={message !== null} onOpenChange={(o) => { if (!o) onclose(); }}>
  <DialogContent data-testid="drop-values-dialog">
    <DialogHeader>
      <DialogTitle>This change deletes stored content</DialogTitle>
      <DialogDescription>{message}</DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="outline" onclick={onclose}>Keep the content</Button>
      <Button variant="destructive" onclick={onconfirm} data-testid="confirm-drop-values"
        >Delete it and save</Button
      >
    </DialogFooter>
  </DialogContent>
</Dialog>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * A stale write (epic #1107): someone — another editor or the AI — saved
   * the same list or type after this page loaded. The server refused to
   * overwrite it; the operator reloads to see the newer version. Local edits
   * stay in memory until they do, so nothing is lost by cancelling.
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
    /** The server's conflict message; null = closed. */
    message: string | null;
    what: string;
    onclose: () => void;
  }
  let { message, what, onclose }: Props = $props();
</script>

<Dialog open={message !== null} onOpenChange={(o) => { if (!o) onclose(); }}>
  <DialogContent data-testid="conflict-dialog">
    <DialogHeader>
      <DialogTitle>{what} changed since you opened it</DialogTitle>
      <DialogDescription>
        Someone saved a newer version, so your change was not applied. Reload to see it, then make
        your change again. Your edits stay here until you reload.
      </DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="outline" onclick={onclose}>Cancel</Button>
      <Button onclick={() => location.reload()}>Reload</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

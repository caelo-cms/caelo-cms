<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /** One command (or value) with a copy button — Settings → Updates (#696). */

  import { Check, Copy } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "#lib/components/ui/button/index.js";

  let { value, label, testid }: { value: string; label: string; testid?: string } = $props();
  let copied = $state(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
      toast.success(`${label} copied.`);
      setTimeout(() => (copied = false), 2000);
    } catch {
      toast.error("Could not copy. Select the text and copy it by hand.");
    }
  }
</script>

<div class="flex items-start gap-2">
  <pre
    class="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted p-3 text-xs"
    data-testid={testid}><code>{value}</code></pre>
  <Button variant="outline" size="sm" aria-label={`Copy ${label}`} onclick={copy}>
    {#if copied}<Check class="size-4" />{:else}<Copy class="size-4" />{/if}
    Copy
  </Button>
</div>

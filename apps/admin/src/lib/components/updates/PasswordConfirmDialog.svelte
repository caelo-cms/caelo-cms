<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #757 — the step-up for update actions: the Owner re-enters their
   * password, and the same submit runs the action. The dialog renders in a
   * portal, so its password field and submit button join the action's form
   * through the `form` attribute (`formId`) instead of nesting in it.
   */

  import type { Snippet } from "svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "#lib/components/ui/dialog/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";

  let {
    open = $bindable(false),
    formId,
    title,
    description = null,
    submitLabel,
    error = null,
    testid,
    children,
  }: {
    open?: boolean;
    /** The id of the `<form>` that runs the action. */
    formId: string;
    title: string;
    description?: string | null;
    submitLabel: string;
    /** The last failed attempt's message (wrong password, …). */
    error?: string | null;
    testid: string;
    /** What the action does, above the password field. */
    children?: Snippet;
  } = $props();
</script>

<Dialog bind:open>
  <DialogContent data-testid={testid}>
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      {#if description}
        <DialogDescription>{description}</DialogDescription>
      {/if}
    </DialogHeader>
    {@render children?.()}
    <div class="grid gap-1.5">
      <Label for={`${formId}-password`}>Your Caelo password</Label>
      <!-- autocomplete="off": the point is that a person types it now; it
           does not stop every password manager (#725 closes that gap). -->
      <Input
        id={`${formId}-password`}
        form={formId}
        name="password"
        type="password"
        autocomplete="off"
        required
        data-testid={`${testid}-password`}
      />
      <p class="text-xs text-muted-foreground">
        Asked again for every update action, so nobody can install from a computer you left
        signed in.
      </p>
    </div>
    {#if error}
      <p class="text-sm text-destructive" data-testid={`${testid}-error`}>{error}</p>
    {/if}
    <DialogFooter>
      <Button type="button" variant="ghost" onclick={() => (open = false)}>Not now</Button>
      <Button type="submit" form={formId} data-testid={`${testid}-submit`}>{submitLabel}</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

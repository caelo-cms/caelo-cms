<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * One button of a plugin panel that posts a form action: the hidden
   * fields name the section, the action and its arguments; the server
   * resolves everything else from the panel declaration. With `confirm`,
   * the shared confirm dialog asks first.
   */

  import type { PanelConfirm } from "@caelo-cms/plugin-sdk";
  import { enhance } from "$app/forms";
  import { Button } from "#lib/components/ui/button/index.js";
  import { confirmSubmit } from "#lib/confirm.svelte.js";

  interface Props {
    /** The form action, e.g. `?/row`. */
    action: string;
    csrfToken: string;
    fields: Record<string, string>;
    label: string;
    variant: "default" | "secondary" | "outline" | "destructive";
    size?: "sm" | "default";
    confirm?: PanelConfirm | null;
    disabled?: boolean;
    testId?: string;
  }
  let {
    action,
    csrfToken,
    fields,
    label,
    variant,
    size = "sm",
    confirm = null,
    disabled = false,
    testId,
  }: Props = $props();
</script>

{#snippet body()}
  <input type="hidden" name="_csrf" value={csrfToken} />
  {#each Object.entries(fields) as [name, value] (name)}
    <input type="hidden" {name} {value} />
  {/each}
  <Button type="submit" {variant} {size} {disabled} data-testid={testId}>{label}</Button>
{/snippet}

{#if confirm}
  <form
    method="post"
    {action}
    use:enhance
    use:confirmSubmit={{
      title: confirm.title,
      description: confirm.description,
      confirmLabel: confirm.confirmLabel,
    }}
  >
    {@render body()}
  </form>
{:else}
  <form method="post" {action} use:enhance>
    {@render body()}
  </form>
{/if}

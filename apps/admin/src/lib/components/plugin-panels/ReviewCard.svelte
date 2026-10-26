<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * The review step of a row action: what the action will act on, as text,
   * and a submit carrying exactly those values (the plugin refuses when
   * the data changed after this was shown).
   */

  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { buttonVariants } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import type { ReviewState } from "#lib/plugin-panels.js";
  import ActionForm from "./ActionForm.svelte";
  import PanelValue from "./PanelValue.svelte";

  interface Props {
    review: ReviewState;
    csrfToken: string;
  }
  let { review, csrfToken }: Props = $props();
</script>

<Card data-testid="panel-review">
  <CardHeader>
    <CardTitle>{review.title}</CardTitle>
    {#if review.description}
      <CardDescription>{review.description}</CardDescription>
    {/if}
  </CardHeader>
  <CardContent class="grid gap-4">
    {#if review.error}
      <Alert variant="destructive">
        <AlertDescription>{review.error}</AlertDescription>
      </Alert>
    {/if}
    {#if review.fields.length > 0}
      <dl class="grid gap-3">
        {#each review.fields as field, i (i)}
          <div class="grid gap-1">
            <dt class="text-xs text-muted-foreground">{field.label}</dt>
            <dd
              class={field.display.format === "multiline"
                ? "max-h-96 overflow-y-auto rounded-md border p-2 font-mono text-xs"
                : "text-sm"}
            >
              <PanelValue display={field.display} value={field.value} />
            </dd>
          </div>
        {/each}
      </dl>
    {/if}
    <div class="flex flex-wrap items-center gap-2">
      {#if review.submitArgs !== null}
        <ActionForm
          action="?/submit"
          {csrfToken}
          fields={{ section: review.sectionId, action: review.actionId, args: review.submitArgs }}
          label={review.submitLabel}
          variant="default"
          size="default"
          confirm={review.confirm}
        />
      {:else if review.unavailableMessage}
        <p class="text-sm text-muted-foreground">{review.unavailableMessage}</p>
      {/if}
      <a href={review.closeHref} class={buttonVariants({ variant: "ghost" })}>Close</a>
    </div>
  </CardContent>
</Card>

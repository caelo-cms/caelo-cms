<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Part 2 — card for the screenshot / page-capture tools
   * (screenshot_page, screenshot_external_page, get_import_page_screenshot,
   * inspect_external_page), so the operator can verify the capture worked
   * — the AI already got its own copy.
   *
   * `image.src` is one of two sources, chosen by ChatPanel: a data URL of the
   * capture streamed in this tab (the `tool-result` event's `image`), or,
   * after a reload, the chat's images route serving the copy persisted on
   * the tool row (#356 stores it, #359 serves it). Without either — a row
   * from before #356, or one the weekly chat-image sweep cleared — the card
   * shows the summary text alone, and an image the store no longer has
   * hides itself instead of rendering broken. A failed capture reports
   * ok=false and never reaches this card — the router renders the failure
   * uniformly.
   */

  import { Camera } from "lucide-svelte";
  import StreamingMarkdown from "../StreamingMarkdown.svelte";

  interface Props {
    name: string;
    content: string;
    /** The capture to preview: a data URL (this tab) or the stored copy's URL. */
    image?: { src: string; mediaType: string };
  }
  let { name, content, image }: Props = $props();

  // The stored copy can be gone (swept between the transcript load and the
  // image request): drop the preview rather than show a broken image.
  let failedSrc = $state<string | null>(null);
  const shown = $derived(image && image.src !== failedSrc ? image : undefined);

  // Auto-expand only the PURE screenshot tools (short summary + one image) so
  // the operator verifies the capture at a glance. inspect_external_page
  // carries a large text payload (gist/markdown/meta/links) — auto-expanding
  // it floods the chat, so it stays collapsed (click to open), matching the
  // fallback card's "generic output is collapsed" rule.
  const autoOpen = $derived(!!shown && name !== "inspect_external_page");
</script>

<details
  class="rounded-md border bg-card p-2 text-xs"
  open={autoOpen}
  data-testid="tool-card-screenshot"
>
  <summary class="flex cursor-pointer select-none items-center gap-1.5 text-muted-foreground">
    <Camera class="size-3" />
    <span class="font-mono text-[10px]">{name.replaceAll("_", " ")}</span>
    <span class="text-[10px]">— {shown ? "screenshot captured, click to view" : "done"}</span>
  </summary>
  <StreamingMarkdown text={content} class="mt-1.5" />
  {#if shown}
    {@const src = shown.src}
    <!-- Full-page screenshots can be very tall; cap the preview height and
         scroll inside the card so a single capture never floods the chat. -->
    <div class="mt-2 max-h-96 overflow-y-auto rounded border">
      <img
        {src}
        class="w-full"
        loading="lazy"
        alt="captured screenshot"
        data-testid="tool-card-screenshot-image"
        onerror={() => (failedSrc = src)}
      />
    </div>
  {/if}
</details>

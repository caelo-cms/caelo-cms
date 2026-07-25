<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Part 2 — card for the screenshot / page-capture tools
   * (screenshot_page, screenshot_external_page, get_import_page_screenshot,
   * inspect_external_page). The captured image rides on the `tool-result`
   * SSE event's `image` field and is threaded in here so the operator can
   * verify the capture worked — the AI already got its own copy.
   *
   * The image is LIVE for the session only: it lives in ChatPanel's
   * `toolImages` map, never persisted to chat_messages. On a reloaded
   * transcript `image` is undefined and the card falls back to the summary
   * text alone (no broken <img>). A failed capture reports ok=false and
   * never reaches this card — the router renders the failure uniformly.
   */

  import { Camera } from "lucide-svelte";
  import StreamingMarkdown from "../StreamingMarkdown.svelte";

  interface Props {
    name: string;
    content: string;
    /** Present only when a screenshot was captured THIS session. */
    image?: { base64: string; mediaType: string };
  }
  let { name, content, image }: Props = $props();

  // Auto-expand only the PURE screenshot tools (short summary + one image) so
  // the operator verifies the capture at a glance. inspect_external_page
  // carries a large text payload (gist/markdown/meta/links) — auto-expanding
  // it floods the chat, so it stays collapsed (click to open), matching the
  // fallback card's "generic output is collapsed" rule.
  const autoOpen = $derived(!!image && name !== "inspect_external_page");
</script>

<details
  class="rounded-md border bg-card p-2 text-xs"
  open={autoOpen}
  data-testid="tool-card-screenshot"
>
  <summary class="flex cursor-pointer select-none items-center gap-1.5 text-muted-foreground">
    <Camera class="size-3" />
    <span class="font-mono text-[10px]">{name.replaceAll("_", " ")}</span>
    <span class="text-[10px]">— {image ? "screenshot captured, click to view" : "done"}</span>
  </summary>
  <StreamingMarkdown text={content} class="mt-1.5" />
  {#if image}
    <!-- Full-page screenshots can be very tall; cap the preview height and
         scroll inside the card so a single capture never floods the chat. -->
    <div class="mt-2 max-h-96 overflow-y-auto rounded border">
      <img
        src={`data:${image.mediaType};base64,${image.base64}`}
        class="w-full"
        loading="lazy"
        alt="captured screenshot"
      />
    </div>
    <p class="mt-1 text-[10px] text-muted-foreground">
      Live-Vorschau — nach Reload nicht mehr sichtbar
    </p>
  {/if}
</details>

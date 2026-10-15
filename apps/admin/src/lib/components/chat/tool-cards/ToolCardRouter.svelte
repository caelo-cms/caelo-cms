<script lang="ts">
  import type { DecidedProposal } from "./decided-proposal.js";
  // SPDX-License-Identifier: MPL-2.0

  /**
   * v0.2.46 — dispatcher for per-tool result cards. Picks a card
   * component by tool name (or domain prefix), falls back to a plain
   * markdown render of the tool's content string when no card matches.
   *
   * Why a router pattern: the AI tool catalogue is ~80 entries. We
   * don't need a card per entry — most generic shapes look fine as
   * markdown. The cards here cover the high-frequency surfaces where
   * the raw content string is harder to read than a structured render
   * (proposals, edits, bulk ops).
   *
   * Adding a new card: drop a file in this directory, import below,
   * add a case to the switch.
   */

  import StreamingMarkdown from "../StreamingMarkdown.svelte";
  import BulkOpCard from "./BulkOpCard.svelte";
import ChoiceCard from "./ChoiceCard.svelte";
  import DesignVariantsCard from "./DesignVariantsCard.svelte";
  import EditContentCard from "./EditContentCard.svelte";
  import EditModuleCard from "./EditModuleCard.svelte";
  import FindResultsCard from "./FindResultsCard.svelte";
  import ProposeCard from "./ProposeCard.svelte";
  import ScreenshotCard from "./ScreenshotCard.svelte";
  import { toolCardKind } from "./tool-card-kind.js";

  interface Props {
    name: string;
    content: string;
    ok: boolean;
    args?: Record<string, unknown>;
    /**
     * v0.2.62 — passed through to ProposeCard so Approve / Reject can
     * fetch the queue's `?/approve` form action without sending the
     * operator off to /settings/<domain>/pending. Omit when the card
     * is rendered outside a chat (none today, but contract is clean).
     */
    csrfToken?: string;
    /** v0.2.75 — propagated to ProposeCard's Approve / Reject. */
    onDecided?: (info: DecidedProposal) => void;
    /** Issue #658 — propagated to ProposeCard (see there). */
    onDecisionStart?: () => number;
    /** offer_choices → the clicked option posts back as the operator's message. */
    onChoose?: (answer: string) => void;
    /**
     * Part 2 — live screenshot bytes for the image-returning tools. Present
     * only for the session that captured it (never persisted); ScreenshotCard
     * renders the preview when set and falls back to text-only when absent.
     */
    image?: { base64: string; mediaType: string };
  }
  let {
    name,
    content,
    ok,
    args = {},
    csrfToken,
    onDecided,
    onDecisionStart,
    onChoose,
    image,
  }: Props = $props();

  // Routing lives in tool-card-kind.ts (unit-tested). A plugin result is
  // recognised by its content before any name-based card (#635).
  const kind = $derived(toolCardKind(name, content, ok));
  // Tools conventionally prefix their own error content with "<name> failed:".
  // The failure header below already renders "{name} failed:", so strip a
  // redundant leading copy of THIS tool's own prefix to avoid the doubled
  // "get_import_page_screenshot failed: get_import_page_screenshot failed: …".
  // A different op-name prefix (e.g. "imports.get_… failed:") is left intact —
  // that is useful which-op context, not a duplicate of the header.
  const failBody = $derived.by(() => {
    const prefix = `${name} failed:`;
    return content.toLowerCase().startsWith(prefix.toLowerCase())
      ? content.slice(prefix.length).trimStart()
      : content;
  });
</script>

{#if kind === "error"}
  <!-- Failed tool calls render uniformly so the operator can spot
       them without per-tool-card knowledge. -->
  <div
    class="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
    data-testid="tool-card-error"
  >
    <strong>{name} failed:</strong>
    <span class="ml-1">{failBody}</span>
  </div>
{:else if kind === "untrusted"}
  <!-- #635 — a plugin tool's result may carry visitor-written text. Shown
       as plain text, never through the markdown renderer or an action
       card: a visitor's `![](https://…)` must not become a live image or
       link in the admin. Collapsed like any generic result. -->
  <details class="rounded-md bg-emerald-500/5 p-2 text-xs" data-testid="tool-card-collapsed">
    <summary class="cursor-pointer select-none text-muted-foreground">
      <span class="font-mono text-[10px]">{name.replaceAll("_", " ")}</span>
      <span class="ml-1 text-[10px]">— done, click for details</span>
    </summary>
    <pre
      class="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]"
      data-testid="tool-card-untrusted">{content}</pre>
  </details>
{:else if kind === "propose"}
  <ProposeCard {name} {content} {args} {csrfToken} {onDecided} {onDecisionStart} />
{:else if kind === "choices"}
  <ChoiceCard {content} {onChoose} />
{:else if kind === "design-variants"}
  <!-- issue #375 — inline design-variant previews; the pick posts back
       as the operator's message, same flow as ChoiceCard. -->
  <DesignVariantsCard {content} {onChoose} />
{:else if kind === "edit-module"}
  <EditModuleCard {content} {args} />
{:else if kind === "edit-content"}
  <!-- Non-gated (module) edit_content renders the minimal old→new diff.
       A gated template edit returns a "Queued proposal …" string and takes
       the isPropose branch above instead. -->
  <EditContentCard {content} {args} />
{:else if kind === "screenshot"}
  <ScreenshotCard {name} {content} {image} />
{:else if kind === "bulk"}
  <BulkOpCard {name} {content} />
{:else if kind === "find"}
  <FindResultsCard {name} {content} />
{:else}
  <!-- Fallback — ALWAYS collapsed (operator decision): generic tool
       output is the AI's working material, not operator reading. The
       one-liner keeps the progress trace; details are a click away.
       Interactive cards (Approve buttons, diff Accept/Reject) and
       failures never take this branch and stay fully visible. -->
  <details class="rounded-md bg-emerald-500/5 p-2 text-xs" data-testid="tool-card-collapsed">
    <summary class="cursor-pointer select-none text-muted-foreground">
      <span class="font-mono text-[10px]">{name.replaceAll("_", " ")}</span>
      <span class="ml-1 text-[10px]">— done, click for details</span>
    </summary>
    <StreamingMarkdown text={content} class="mt-1" />
  </details>
{/if}

<script lang="ts">
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
  import EditModuleCard from "./EditModuleCard.svelte";
  import FindResultsCard from "./FindResultsCard.svelte";
  import ProposeCard from "./ProposeCard.svelte";

  interface Props {
    name: string;
    content: string;
    ok: boolean;
    args?: Record<string, unknown>;
    /**
     * v0.2.62 — passed through to ProposeCard so Approve / Reject can
     * fetch the queue's `?/approve` form action without sending the
     * operator off to /security/<domain>/pending. Omit when the card
     * is rendered outside a chat (none today, but contract is clean).
     */
    csrfToken?: string;
    /** v0.2.75 — propagated to ProposeCard's Approve. */
    onApproved?: (info: { proposalId: string; kind: string }) => void;
  }
  let { name, content, ok, args = {}, csrfToken, onApproved }: Props = $props();

  // Domain-prefix bucketing for the propose tools (25 of them across
  // 13 domains; one card handles all).
  // v0.5.11 — content-based predicate. The previous name.startsWith
  // ("propose_") check missed tools that route through a propose
  // pipeline but don't carry the prefix (create_layout, tune_rate_limit,
  // bootstrap-site's create_layout call). With v0.5.11 every propose-
  // style tool emits the canonical "Queued proposal <uuid>: …" content
  // shape; matching that prefix routes them all uniformly.
  const isPropose = $derived(
    name.startsWith("propose_") || /^Queued proposal [0-9a-f-]{36}:/.test(content),
  );
  const isBulk = $derived(
    name === "bulk_create_redirects" ||
      name === "bulk_delete_redirects" ||
      name === "bulk_optimize_seo" ||
      name === "delete_pages_many" ||
      name === "update_pages_many" ||
      name === "update_modules_many",
  );
  const isFind = $derived(name === "find_media" || name === "find_redirects");
</script>

{#if !ok}
  <!-- Failed tool calls render uniformly so the operator can spot
       them without per-tool-card knowledge. -->
  <div
    class="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
    data-testid="tool-card-error"
  >
    <strong>{name} failed:</strong>
    <span class="ml-1">{content}</span>
  </div>
{:else if isPropose}
  <ProposeCard {name} {content} {args} {csrfToken} {onApproved} />
{:else if name === "edit_module"}
  <EditModuleCard {content} {args} />
{:else if isBulk}
  <BulkOpCard {name} {content} />
{:else if isFind}
  <FindResultsCard {name} {content} />
{:else}
  <!-- Fallback — plain markdown render of the content. Most generic
       tool shapes look fine here (no_op tools, status checks, etc.). -->
  <div class="rounded-md bg-emerald-500/5 p-2 text-xs">
    <span class="font-mono text-[10px] text-muted-foreground">{name}</span>
    <StreamingMarkdown text={content} class="mt-1" />
  </div>
{/if}

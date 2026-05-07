<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * v0.2.46 — inline diff card. Renders a before/after diff for a
   * proposed module change, with Accept / Reject buttons positioned
   * directly in the message stream so the operator can decide
   * per-change without scrolling to a sidebar.
   *
   * Accept = leave it staged on the chat branch (default — the AI's
   *   tool call already wrote it). The button just records the
   *   operator's intent so the bulk Publish surface knows it's
   *   been reviewed.
   * Reject = the operator wants the change reverted on this branch.
   *   For now we just toggle the chat-panel-level "selected" flag
   *   on the matching ProposedDiff so it doesn't ride the bulk
   *   publish. A full revert (snapshots.revert_module on the chat
   *   branch) is a follow-up since it touches the chat-runner's
   *   branch lifecycle.
   *
   * The visible state is driven by the parent (ChatPanel.svelte's
   *   `proposedDiffs[i].selected`) so the inline card and the
   *   sidebar stay in sync.
   */

  import { Check, X } from "lucide-svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { cn } from "$lib/utils.js";

  interface Props {
    moduleId: string;
    before: string;
    after: string;
    selected: boolean;
    onAccept: () => void;
    onReject: () => void;
  }
  let { moduleId, before, after, selected, onAccept, onReject }: Props = $props();

  // Same line-diff shape as ChatPanel's lineDiff helper. Inlined to
  // keep the component self-contained.
  function lineDiff(a: string, b: string): { kind: "ctx" | "del" | "add"; text: string }[] {
    const aL = a.split("\n");
    const bL = b.split("\n");
    const out: { kind: "ctx" | "del" | "add"; text: string }[] = [];
    const max = Math.max(aL.length, bL.length);
    for (let i = 0; i < max; i++) {
      if (aL[i] === bL[i]) {
        if (aL[i] !== undefined) out.push({ kind: "ctx", text: aL[i] ?? "" });
      } else {
        if (aL[i] !== undefined) out.push({ kind: "del", text: aL[i] ?? "" });
        if (bL[i] !== undefined) out.push({ kind: "add", text: bL[i] ?? "" });
      }
    }
    return out;
  }
  const diff = $derived(lineDiff(before, after));
</script>

<div
  class={cn(
    "rounded-md border bg-card text-xs",
    selected ? "border-primary/40" : "border-muted-foreground/30 opacity-60",
  )}
  data-testid="inline-diff"
>
  <div class="flex items-center gap-2 px-3 py-2 border-b">
    <span class="font-mono text-[10px] text-muted-foreground">module {moduleId.slice(0, 8)}…</span>
    <span class="ml-auto flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant={selected ? "default" : "outline"}
        class="h-7 gap-1 px-2 text-xs"
        onclick={onAccept}
        data-testid="inline-diff-accept"
      >
        <Check class="size-3" />
        <span>{selected ? "Will publish" : "Accept"}</span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant={selected ? "outline" : "destructive"}
        class="h-7 gap-1 px-2 text-xs"
        onclick={onReject}
        data-testid="inline-diff-reject"
      >
        <X class="size-3" />
        <span>{selected ? "Reject" : "Rejected"}</span>
      </Button>
    </span>
  </div>
  <pre
    class="m-0 max-h-48 overflow-auto px-3 py-2 font-mono text-[11px]">{#each diff as ln, i (i)}<span
        class={cn(
          "block",
          ln.kind === "add"
            ? "bg-green-500/10"
            : ln.kind === "del"
              ? "bg-red-500/10"
              : "",
        )}
        >{ln.kind === "add" ? "+ " : ln.kind === "del" ? "- " : "  "}{ln.text}</span
      >{/each}</pre>
</div>

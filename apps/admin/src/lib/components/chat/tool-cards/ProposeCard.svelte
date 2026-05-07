<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * v0.2.46 — card for any propose_* tool result. The
   * makeProposeTool factory (ai/tools/_make-propose-tool.ts) emits
   * this content shape verbatim:
   *
   *   "Queued proposal <id>: <summary>. An Owner must click Approve at
   *    /security/<domain>/pending to apply."
   *
   * We parse that shape, render the proposal id + summary as a Badge
   * + headline, and put a primary "Review at /security/.../pending"
   * link button so the operator's next click is one tap away.
   */

  import { ExternalLink } from "lucide-svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button-variants.js";

  interface Props {
    name: string;
    content: string;
    args: Record<string, unknown>;
  }
  let { name, content, args }: Props = $props();

  // Parse "Queued proposal <id>: <summary>. ... /security/<path>/pending ..."
  const proposalMatch = $derived(content.match(/Queued proposal ([0-9a-f-]{36}):\s*([^.]+)\./));
  const queueMatch = $derived(content.match(/(\/security\/[^\s.]+\/pending)/));
  const proposalId = $derived(proposalMatch?.[1] ?? null);
  const summary = $derived(proposalMatch?.[2]?.trim() ?? content);
  const queueUrl = $derived(queueMatch?.[1] ?? null);

  // Map propose_create_user → "users.create" badge text. Strip the
  // "propose_" prefix and the singular shape.
  const kindLabel = $derived(name.replace(/^propose_/, "").replace(/_/g, " "));

  // Visual emphasis: revert / delete / clear / remove are destructive.
  const isDestructive = $derived(
    /^(delete|remove|revert|clear|deactivate|cancel)/i.test(kindLabel),
  );
  void args;
</script>

<div
  class="rounded-md border bg-card p-3 text-sm shadow-sm"
  data-testid="tool-card-propose"
>
  <div class="flex items-center gap-2">
    <Badge variant={isDestructive ? "destructive" : "secondary"}>{kindLabel}</Badge>
    {#if proposalId}
      <span class="font-mono text-[10px] text-muted-foreground">{proposalId.slice(0, 8)}…</span>
    {/if}
    <span class="ml-auto text-[10px] text-muted-foreground">queued</span>
  </div>
  <p class="mt-1.5 text-sm">{summary}</p>
  {#if queueUrl}
    <a
      href={queueUrl}
      class={`${buttonVariants({ variant: "outline", size: "sm" })} mt-2 inline-flex items-center gap-1`}
    >
      <span>Review at {queueUrl}</span>
      <ExternalLink class="size-3" />
    </a>
  {/if}
</div>

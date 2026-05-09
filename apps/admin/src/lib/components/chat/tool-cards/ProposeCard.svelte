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
   * v0.2.62 — Inline Approve / Reject. Pre-v0.2.62 the card carried
   * a "Review at /security/<domain>/pending" link button that sent
   * the operator off to a separate page to click Approve. The user
   * asked for the buttons to live inline ("i want to see the button
   * direct in chat and can click it there"). Each /security/.../pending
   * route already exposes `?/approve` and `?/reject` form actions
   * accepting a `proposalId` form field; we POST to those directly
   * from the card via fetch with the chat's csrfToken. On success we
   * flip the card to a small "applied" / "rejected" badge so the
   * outcome is visible without navigation.
   */

  import { Check, ExternalLink, X } from "lucide-svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button-variants.js";

  interface Props {
    name: string;
    content: string;
    args: Record<string, unknown>;
    /** Required to POST to the queue's ?/approve action. Optional
     *  for backwards-compat with any caller that doesn't have one. */
    csrfToken?: string;
    /**
     * v0.2.75 — Fires after a successful Approve. Lets the parent
     * (ChatPanel) reload the preview iframe + auto-send a follow-up
     * to the AI so it knows to continue.
     */
    onApproved?: (info: { proposalId: string; kind: string }) => void;
  }
  let { name, content, args, csrfToken, onApproved }: Props = $props();

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

  // v0.2.62 — local outcome state. null = pending (default), or one of
  // the post-action terminal states. The pending row in the DB has its
  // own status flip; this is purely UI.
  let outcome = $state<"approving" | "rejecting" | "applied" | "rejected" | null>(null);
  let outcomeError = $state<string | null>(null);

  async function postAction(
    action: "approve" | "reject",
  ): Promise<void> {
    if (!queueUrl || !proposalId || !csrfToken) {
      outcomeError = "Missing csrf or queue url — open the pending page directly to approve.";
      return;
    }
    outcome = action === "approve" ? "approving" : "rejecting";
    outcomeError = null;
    try {
      const fd = new FormData();
      fd.set("_csrf", csrfToken);
      fd.set("proposalId", proposalId);
      const res = await fetch(`${queueUrl}?/${action}`, {
        method: "POST",
        body: fd,
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        outcomeError = `${action} failed (HTTP ${res.status}).`;
        outcome = null;
        return;
      }
      // SvelteKit form-action JSON response wraps the action result;
      // 200 + { type: "success" | "failure" } in the body. We parse
      // shallowly — if the action returned a fail() the body has
      // `{ type: "failure" }` even on HTTP 200.
      try {
        const data = (await res.json()) as { type?: string; data?: string };
        // SvelteKit serializes the action's return value into
        // `data.data` as a JSON string. We don't strictly need it
        // here, but a "failure" type means we should bubble.
        if (data.type === "failure") {
          outcomeError = `${action} rejected by server`;
          outcome = null;
          return;
        }
      } catch {
        // Non-JSON body — assume success.
      }
      outcome = action === "approve" ? "applied" : "rejected";
      // v0.2.75 — notify parent so the preview iframe reloads + the
      // AI gets a continue-with-it message.
      if (action === "approve" && proposalId) {
        onApproved?.({ proposalId, kind: name.replace(/^propose_/, "") });
      }
    } catch (e) {
      outcomeError = `${action} threw: ${(e as Error).message ?? "unknown"}`;
      outcome = null;
    }
  }
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
    <span class="ml-auto text-[10px] text-muted-foreground">
      {#if outcome === "applied"}
        applied
      {:else if outcome === "rejected"}
        rejected
      {:else if outcome === "approving"}
        approving…
      {:else if outcome === "rejecting"}
        rejecting…
      {:else}
        queued
      {/if}
    </span>
  </div>
  <p class="mt-1.5 text-sm">{summary}</p>

  {#if outcome === "applied"}
    <div
      class="mt-2 flex items-center gap-1.5 rounded border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-400"
    >
      <Check class="size-3" />
      <span>Approved — proposal applied.</span>
    </div>
  {:else if outcome === "rejected"}
    <div
      class="mt-2 flex items-center gap-1.5 rounded border border-muted-foreground/30 bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
    >
      <X class="size-3" />
      <span>Rejected.</span>
    </div>
  {:else if proposalId && queueUrl && csrfToken}
    <!-- v0.2.62 — inline action buttons. Disabled while a
         submission is in flight. -->
    <div class="mt-2 flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant={isDestructive ? "destructive" : "default"}
        disabled={outcome === "approving" || outcome === "rejecting"}
        onclick={() => postAction("approve")}
        data-testid="propose-approve"
      >
        <Check class="mr-1 size-3" />
        {outcome === "approving" ? "Approving…" : "Approve"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={outcome === "approving" || outcome === "rejecting"}
        onclick={() => postAction("reject")}
        data-testid="propose-reject"
      >
        <X class="mr-1 size-3" />
        {outcome === "rejecting" ? "Rejecting…" : "Reject"}
      </Button>
      <a
        href={queueUrl}
        class={`${buttonVariants({ variant: "ghost", size: "sm" })} ml-auto inline-flex items-center gap-1 text-muted-foreground`}
        title="Open the queue in a new view to see the full preview"
      >
        <span class="text-xs">Queue</span>
        <ExternalLink class="size-3" />
      </a>
    </div>
  {:else if queueUrl}
    <!-- Fallback: no csrf available; surface the link only. -->
    <a
      href={queueUrl}
      class={`${buttonVariants({ variant: "outline", size: "sm" })} mt-2 inline-flex items-center gap-1`}
    >
      <span>Review at {queueUrl}</span>
      <ExternalLink class="size-3" />
    </a>
  {/if}

  {#if outcomeError}
    <p class="mt-2 text-xs text-destructive" data-testid="propose-error">{outcomeError}</p>
  {/if}
</div>

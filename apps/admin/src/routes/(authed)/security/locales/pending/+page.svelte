<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P9 — Owner queue for AI-proposed locale changes (CLAUDE.md §11.A).
   * Approve runs the requested action; Reject closes the proposal with
   * an optional note.
   */

  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  let { data, form } = $props();
  const csrfToken = $derived(
    typeof window === "undefined" ? "" : (document.cookie.match(/caelo_csrf=([^;]+)/)?.[1] ?? ""),
  );

  function describeAction(kind: string, payload: unknown): string {
    const p = payload as Record<string, unknown>;
    switch (kind) {
      case "create":
        return `Add locale '${p.code}' (${p.displayName}) with strategy '${p.urlStrategy}'${p.urlHost ? ` host=${p.urlHost}` : ""}`;
      case "delete":
        return `Remove locale '${p.code}'`;
      case "set_default":
        return `Set '${p.code}' as the default locale`;
      case "update_strategy":
        return `Change locale '${p.code}' to URL strategy '${p.urlStrategy}'${p.urlHost ? ` host=${p.urlHost}` : ""}`;
      default:
        return JSON.stringify(payload);
    }
  }

  function describePreview(preview: unknown): string {
    const p = preview as { affectedPageCount?: number; redirectsToCreate?: number; warnings?: string[] };
    const parts: string[] = [];
    if (typeof p.affectedPageCount === "number")
      parts.push(`${p.affectedPageCount} page${p.affectedPageCount === 1 ? "" : "s"} affected`);
    if (typeof p.redirectsToCreate === "number" && p.redirectsToCreate > 0)
      parts.push(`${p.redirectsToCreate} redirects to create`);
    if (Array.isArray(p.warnings) && p.warnings.length > 0)
      parts.push(`${p.warnings.length} warning${p.warnings.length === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Pending locale proposals</h1>
    <p class="text-sm text-muted-foreground">
      AI-queued changes to the locale registry. Approve to apply; reject to discard. Per CLAUDE.md
      §11.A, hard-to-revert config changes always require this human confirmation step.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message ?? "Saved."}</AlertDescription></Alert>
  {/if}

  <div class="flex gap-2 text-sm">
    <a
      href="?status=pending"
      class:font-semibold={data.status === "pending"}
      class="underline">Pending</a
    >
    <a
      href="?status=applied"
      class:font-semibold={data.status === "applied"}
      class="underline">Applied</a
    >
    <a
      href="?status=rejected"
      class:font-semibold={data.status === "rejected"}
      class="underline">Rejected</a
    >
    <a href="?status=all" class:font-semibold={data.status === "all"} class="underline">All</a>
  </div>

  {#if data.proposals.length === 0}
    <Card>
      <CardContent class="py-8 text-center text-sm text-muted-foreground">
        No proposals in this view.
      </CardContent>
    </Card>
  {/if}

  {#each data.proposals as p (p.id)}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">{describeAction(p.actionKind, p.payload)}</CardTitle>
        <CardDescription>
          {describePreview(p.preview)} · queued {new Date(p.proposedAt).toLocaleString()}
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        {#if Array.isArray((p.preview as { warnings?: string[] }).warnings) && (p.preview as { warnings: string[] }).warnings.length > 0}
          <ul class="space-y-1 text-sm">
            {#each (p.preview as { warnings: string[] }).warnings as w}
              <li class="text-yellow-700 dark:text-yellow-400">⚠ {w}</li>
            {/each}
          </ul>
        {/if}

        <details class="text-xs">
          <summary class="cursor-pointer text-muted-foreground">Raw payload</summary>
          <pre class="mt-2 rounded bg-muted p-2 font-mono">{JSON.stringify(p.payload, null, 2)}</pre>
        </details>

        {#if p.status === "pending"}
          <div class="flex gap-2">
            <form method="post" action="?/approve">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <input type="hidden" name="proposalId" value={p.id} />
              <Button type="submit" size="sm">Approve</Button>
            </form>
            <form method="post" action="?/reject" class="flex items-center gap-2">
              <input type="hidden" name="_csrf" value={csrfToken} />
              <input type="hidden" name="proposalId" value={p.id} />
              <input
                type="text"
                name="note"
                placeholder="Reason (optional)"
                class="rounded border px-2 py-1 text-sm"
                maxlength="500"
              />
              <Button type="submit" size="sm" variant="outline">Reject</Button>
            </form>
          </div>
        {:else}
          <p class="text-xs text-muted-foreground">
            {p.status}{p.decidedAt
              ? ` ${new Date(p.decidedAt).toLocaleString()}`
              : ""}{p.decisionNote ? ` — ${p.decisionNote}` : ""}
          </p>
        {/if}
      </CardContent>
    </Card>
  {/each}
</div>

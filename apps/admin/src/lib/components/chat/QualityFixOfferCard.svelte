<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Issue #685 — "Quality check found … Let the AI fix them?" The AI starts
   * only on a click; "Not now" settles the offer (Publish live stays blocked
   * as the gate says). The operator may also just type a message instead.
   *
   * Issue #727 — "optimum, not good enough": the open problems come grouped
   * by rule across pages, and the operator decides per GROUP, not per page:
   * Fix all (the AI fixes that group), Accept all (an editor's acceptance
   * of every page in the group, with a reason — applied by this click, never
   * by the AI), or Pick pages (tick pages, then fix or accept just those).
   */

  import { ShieldAlert } from "lucide-svelte";
  import type {
    QualityGroupSelection,
    QualityProblemGroup,
  } from "#lib/components/edit/quality-status.svelte.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { groupSelection, MIN_ACCEPT_REASON, selectionPageCount } from "./quality-offer.js";

  interface Props {
    text: string;
    actionLabel: string;
    groups: readonly QualityProblemGroup[];
    /** A click is being handled (claim / send / accept / dismiss). */
    busy: boolean;
    /** The chat's AI is answering right now — one turn at a time. */
    aiBusy: boolean;
    error: string | null;
    /** Fix everything (null) or only the selected groups / pages. */
    onFix: (selection: QualityGroupSelection[] | null) => void;
    /** Accept the selection with the operator's reason. */
    onAccept: (selection: QualityGroupSelection[], reason: string) => void;
    onDismiss: () => void;
  }
  let { text, actionLabel, groups, busy, aiBusy, error, onFix, onAccept, onDismiss }: Props =
    $props();

  /** Per group: the ticked pages while picking (absent / null = not picking). */
  let picking = $state<Record<string, string[] | null>>({});
  /** The group whose accept form is open. */
  let accepting = $state<string | null>(null);
  let reason = $state("");

  function pickedSet(key: string): ReadonlySet<string> | null {
    const p = picking[key];
    return p === undefined || p === null ? null : new Set(p);
  }

  function togglePick(group: QualityProblemGroup): void {
    picking[group.key] = picking[group.key] ? null : [];
  }

  function togglePage(key: string, path: string, on: boolean): void {
    const current = picking[key] ?? [];
    picking[key] = on ? [...current, path] : current.filter((p) => p !== path);
  }

  function selectAll(group: QualityProblemGroup, on: boolean): void {
    picking[group.key] = on ? group.pages.map((p) => p.pagePath) : [];
  }

  function selectionOf(group: QualityProblemGroup): QualityGroupSelection | null {
    return groupSelection(group, pickedSet(group.key));
  }

  function fixGroup(group: QualityProblemGroup): void {
    const sel = selectionOf(group);
    if (sel) onFix([sel]);
  }

  function confirmAccept(group: QualityProblemGroup): void {
    const sel = selectionOf(group);
    if (!sel || reason.trim().length < MIN_ACCEPT_REASON) return;
    onAccept([sel], reason.trim());
    // The card stays mounted across the acceptance (the groups shrink in
    // place): close this group's pick too, so what is left of it starts
    // from "all of the group" like a fresh card.
    picking[group.key] = null;
    accepting = null;
    reason = "";
  }
</script>

<div
  class="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs"
  data-testid="quality-fix-offer"
>
  <div class="flex items-start gap-2">
    <ShieldAlert class="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />
    <p class="min-w-0 flex-1" data-testid="quality-fix-offer-text">{text}</p>
  </div>

  {#if groups.length > 0}
    <ul class="mt-2 space-y-1.5" aria-label="Quality findings by group">
      {#each groups as group (group.key)}
        {@const picked = picking[group.key] ?? null}
        {@const sel = selectionOf(group)}
        {@const count = sel ? selectionPageCount(group, sel) : 0}
        <li
          class="rounded border border-amber-500/30 bg-background/60 p-1.5"
          data-testid="quality-offer-group"
          data-group-key={group.key}
          data-page-count={group.pages.length}
        >
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="min-w-0 flex-1">
              <strong>{group.title}</strong>
              <span class="text-muted-foreground">· {group.pages.length} page(s) ·</span>
              <code class="text-muted-foreground">{group.key}</code>
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              class="h-6 px-2 text-xs"
              disabled={busy || aiBusy || count === 0}
              title={aiBusy ? "The AI is answering — wait until it is done" : undefined}
              data-testid="quality-offer-group-fix"
              onclick={() => fixGroup(group)}
            >
              {picked ? `Fix ${count} selected` : "Fix all"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              class="h-6 px-2 text-xs"
              disabled={busy || count === 0}
              data-testid="quality-offer-group-accept"
              onclick={() => {
                accepting = accepting === group.key ? null : group.key;
                reason = "";
              }}
            >
              {picked ? `Accept ${count} selected…` : "Accept all…"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              class="h-6 px-2 text-xs"
              disabled={busy}
              aria-expanded={picked !== null}
              data-testid="quality-offer-group-pick"
              onclick={() => togglePick(group)}
            >
              {picked ? "Done picking" : "Pick pages"}
            </Button>
          </div>

          {#if picked}
            <div
              class="mt-1.5 max-h-40 overflow-y-auto rounded border p-1"
              data-testid="quality-offer-pick-list"
            >
              <label class="flex items-center gap-1.5 font-medium">
                <input
                  type="checkbox"
                  checked={picked.length === group.pages.length}
                  onchange={(e) => selectAll(group, e.currentTarget.checked)}
                  data-testid="quality-offer-pick-all"
                />
                All {group.pages.length} page(s)
              </label>
              {#each group.pages as page (page.pagePath)}
                <label class="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={picked.includes(page.pagePath)}
                    onchange={(e) => togglePage(group.key, page.pagePath, e.currentTarget.checked)}
                    data-testid="quality-offer-pick-page"
                    data-page-path={page.pagePath}
                  />
                  <span class="min-w-0 truncate">{page.pagePath}</span>
                  <span class="text-muted-foreground">{page.detail}</span>
                </label>
              {/each}
            </div>
          {/if}

          {#if accepting === group.key}
            <form
              class="mt-1.5 flex flex-wrap items-center gap-1.5"
              onsubmit={(e) => {
                e.preventDefault();
                confirmAccept(group);
              }}
            >
              <input
                type="text"
                bind:value={reason}
                required
                minlength={MIN_ACCEPT_REASON}
                maxlength={500}
                placeholder="Why is this acceptable?"
                aria-label={`Reason for accepting ${group.title}`}
                class="min-w-40 flex-1 rounded-md border bg-background p-1 text-xs"
                data-testid="quality-offer-accept-reason"
              />
              <Button
                type="submit"
                size="sm"
                class="h-6 px-2 text-xs"
                disabled={busy || count === 0 || reason.trim().length < MIN_ACCEPT_REASON}
                data-testid="quality-offer-accept-confirm"
              >
                Accept on {count} page(s)
              </Button>
              <span class="w-full text-muted-foreground">
                Counts at once. A worse value later blocks again; revoke it any time under
                Settings → Quality.
              </span>
            </form>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <div class="mt-2 flex flex-wrap items-center gap-2">
    <Button
      type="button"
      size="sm"
      disabled={busy || aiBusy}
      title={aiBusy ? "The AI is answering — wait until it is done" : undefined}
      data-testid="quality-fix-offer-fix"
      onclick={() => onFix(null)}
    >
      {actionLabel}
    </Button>
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={busy}
      data-testid="quality-fix-offer-dismiss"
      onclick={onDismiss}
    >
      Not now
    </Button>
    <span class="text-muted-foreground">Or type what you want instead.</span>
  </div>
  {#if error}
    <p role="alert" class="mt-1.5 text-destructive" data-testid="quality-fix-offer-error">{error}</p>
  {/if}
</div>

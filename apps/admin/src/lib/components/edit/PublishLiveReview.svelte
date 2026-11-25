<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * The Publish live review: what the click puts live, before the click.
   * Numbers first (pages new / changed / removed, site-wide changes,
   * redirects, settings), the quality check's verdict, then three examples
   * per area with the full list on request. Publish live sits at the top
   * and at the bottom, so a long release needs no scrolling to decide.
   *
   * It always opens (decision 2026-11-17), also when no redirect goes live.
   * The form posts the staged run it showed (`stagedRunId`: deploy.promote
   * refuses a newer build) and the redirect changes it listed as going live
   * (#1550), so exactly what it showed goes live.
   *
   * Every new or changed page, and a page that shows each site-wide part,
   * links to staging, so the operator can look at it again before the click.
   */
  import { LoaderCircle } from "lucide-svelte";
  import { enhance, type SubmitFunction } from "$app/forms";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from "#lib/components/ui/dialog/index.js";
  import { countOf } from "./draft-chats.js";
  import {
    confirmedRedirects,
    examplePages,
    groupRedirects,
    pageBreakdown,
    pageTotal,
    type PublishReviewData,
    redirectRule,
    reviewPageHref,
    reviewPages,
    shipsNothingVisible,
  } from "./publish-review.js";
  import { stagingPageHref } from "#lib/staging-href.js";
  import type { QualityGate } from "./quality-status.svelte.js";

  let {
    open = $bindable(false),
    csrfToken,
    submit,
    busy = false,
    gate = null,
    draftChangeCount = 0,
  }: {
    open?: boolean;
    csrfToken: string;
    /** The toolbar's Publish live submit (it tracks progress and errors). */
    submit: SubmitFunction;
    /** A Stage or Publish live is running. */
    busy?: boolean;
    /** The staged build's quality gate; Publish live opens only when it is open. */
    gate?: QualityGate | null;
    /** The operator's draft changes, which this build does not contain. */
    draftChangeCount?: number;
  } = $props();

  const FORM_ID = "publish-live-review-form";

  let data = $state<PublishReviewData | null>(null);
  let loadError = $state<string | null>(null);
  let showAllPages = $state(false);
  let showAllSiteWide = $state(false);
  let showAllRedirects = $state(false);
  let showWaiting = $state(false);
  let redirectQuery = $state("");

  // Every open reads anew: the review shows the build that goes live now.
  $effect(() => {
    if (!open) return;
    data = null;
    loadError = null;
    showAllPages = showAllSiteWide = showAllRedirects = showWaiting = false;
    redirectQuery = "";
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/deploy/publish-preview", {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? `HTTP ${res.status}`);
        }
        data = (await res.json()) as PublishReviewData;
      } catch (e) {
        if (controller.signal.aborted) return;
        // Loud, never a Publish live without its review.
        loadError = `What this Publish live changes could not be read (${e instanceof Error ? e.message : String(e)}). Nothing was published. Close and try again.`;
      }
    })();
    return () => controller.abort();
  });

  const preview = $derived(data?.preview ?? null);
  const pages = $derived(preview ? reviewPages(preview) : []);
  const shownPages = $derived(showAllPages ? pages : examplePages(pages));
  const unlistedPages = $derived(preview ? pageTotal(preview) - pages.length : 0);
  const siteWide = $derived(preview?.siteWide ?? []);
  const shownSiteWide = $derived(showAllSiteWide ? siteWide : siteWide.slice(0, 3));
  const goingLive = $derived(data?.redirects.goingLive ?? []);
  const redirectGroups = $derived(groupRedirects(goingLive));
  const filteredRedirects = $derived(
    goingLive.filter((r) =>
      redirectRule(r).toLowerCase().includes(redirectQuery.trim().toLowerCase()),
    ),
  );
  const canPublish = $derived(data !== null && preview?.staged !== null && !busy);

  function jumpTo(id: string): void {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(id)?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
  }

  function when(iso: string | null | undefined): string {
    if (!iso) return "";
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  /** What the quality check said about this build, from the gate it passed. */
  const checkLine = $derived(
    gate === null
      ? null
      : gate.state === "accepted"
        ? "Quality check passed, with findings you accepted"
        : gate.state === "overridden"
          ? "Published over a failed quality check (recorded with its reason)"
          : gate.open
            ? "Quality check passed"
            : null,
  );
</script>

{#snippet publishButton(testid: string)}
  <Button
    type="submit"
    form={FORM_ID}
    size="sm"
    variant="decide"
    disabled={!canPublish}
    data-testid={testid}
  >
    {#if busy}<LoaderCircle class="size-3.5 animate-spin motion-reduce:animate-none" />Publishing…{:else}Publish live{/if}
  </Button>
{/snippet}

{#snippet stagingLink(title: string, href: string | null)}
  {#if href}
    <a href={href} target="_blank" rel="noopener noreferrer" class="font-medium text-link underline-offset-2 [overflow-wrap:anywhere] hover:underline" data-testid="publish-review-staging-link">{title}</a>
  {:else}
    <span class="font-medium [overflow-wrap:anywhere]">{title}</span>
  {/if}
{/snippet}

{#snippet pageTag(change: "new" | "changed" | "removed")}
  {#if change === "new"}
    <span class="rounded bg-emerald-500/15 px-1 text-[10px] font-semibold text-emerald-800 dark:text-emerald-300">New</span>
  {:else if change === "removed"}
    <span class="rounded bg-red-500/15 px-1 text-[10px] font-semibold text-red-800 dark:text-red-300">Removed</span>
  {/if}
{/snippet}

<Dialog bind:open>
  <DialogContent class="max-h-[90vh] overflow-y-auto sm:max-w-3xl" data-testid="publish-review">
    <DialogHeader>
      <div class="flex flex-wrap items-start justify-between gap-3 pr-6">
        <div class="min-w-0 space-y-1">
          <DialogTitle>Publish live</DialogTitle>
          <DialogDescription>
            {#if preview?.staged}
              Staging from {when(preview.staged.finishedAt ?? preview.staged.startedAt)}
              {#if preview.live}replaces live from {when(preview.live.finishedAt)}{:else}goes live for the first time{/if}.
            {:else}
              What this click puts live for visitors.
            {/if}
          </DialogDescription>
        </div>
        <div class="flex gap-2">
          <Button type="button" variant="outline" size="sm" onclick={() => (open = false)}>Cancel</Button>
          {@render publishButton("publish-review-confirm-top")}
        </div>
      </div>
    </DialogHeader>

    {#if loadError}
      <p role="alert" class="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200" data-testid="publish-review-error">
        {loadError}
      </p>
    {:else if !data || !preview}
      <p class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <LoaderCircle class="size-4 animate-spin motion-reduce:animate-none" />Reading what changes…
      </p>
    {:else}
      <div class="space-y-4 text-sm">
        {#if preview.notice}
          <p class="rounded-md bg-muted px-3 py-2 text-xs" data-testid="publish-review-notice">{preview.notice}</p>
        {/if}

        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="publish-review-tiles">
          {#each [
            { id: "review-pages", n: pageTotal(preview), label: "Pages", sub: pageBreakdown(preview) },
            { id: "review-site", n: siteWide.length, label: "Site-wide", sub: siteWide.slice(0, 2).map((s) => s.title).join(", ") || "none" },
            { id: "review-redirects", n: goingLive.length, label: "Redirects", sub: data.redirects.waiting.length > 0 ? `${countOf(data.redirects.waiting.length, "waits", "wait")} for their page` : goingLive.length > 0 ? "go live" : "none" },
            { id: "review-settings", n: preview.settings.length, label: "Settings", sub: preview.settings.slice(0, 2).map((s) => s.title).join(", ") || "none" },
          ] as tile (tile.id)}
            <button
              type="button"
              class="min-w-0 rounded-lg bg-muted px-3 py-2 text-left hover:ring-1 hover:ring-border disabled:cursor-default disabled:opacity-60"
              disabled={tile.n === 0}
              onclick={() => jumpTo(tile.id)}
              data-testid="publish-review-tile"
            >
              <span class="block text-2xl font-semibold tabular-nums">{tile.n}</span>
              <span class="block text-xs font-medium">{tile.label}</span>
              <span class="line-clamp-2 block text-[11px] text-muted-foreground">{tile.sub}</span>
            </button>
          {/each}
        </div>

        {#if checkLine}
          <p class="text-xs text-emerald-800 dark:text-emerald-300" data-testid="publish-review-check">✓ {checkLine}</p>
        {/if}

        {#if shipsNothingVisible(data) && !preview.notice}
          <p class="text-muted-foreground" data-testid="publish-review-nothing">
            No page, site-wide part, setting or redirect changes for visitors. Publish live still makes live match staging.
          </p>
        {/if}

        {#if pages.length > 0}
          <section id="review-pages" class="space-y-1 border-t pt-3" data-testid="publish-review-pages">
            <h3 class="font-medium">Pages <span class="text-xs font-normal text-muted-foreground">{pageBreakdown(preview)}</span></h3>
            <ul class="space-y-0.5">
              {#each shownPages as p (p.pageId)}
                <li class="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px]">
                  {@render pageTag(p.change)}
                  {@render stagingLink(p.title, reviewPageHref(data.staging, p))}
                  {#if p.path}<span class="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{p.path}</span>{/if}
                </li>
              {/each}
            </ul>
            {#if pages.length > 3}
              <button type="button" class="text-xs text-link underline-offset-2 hover:underline" onclick={() => (showAllPages = !showAllPages)}>
                {showAllPages ? "Show fewer" : `Show all ${pageTotal(preview)}`}
              </button>
            {/if}
            {#if showAllPages && unlistedPages > 0}
              <p class="text-xs text-muted-foreground">And {countOf(unlistedPages, "more page", "more pages")} not listed here.</p>
            {/if}
          </section>
        {/if}

        {#if siteWide.length > 0}
          <section id="review-site" class="space-y-1 border-t pt-3" data-testid="publish-review-site-wide">
            <h3 class="font-medium">Site-wide <span class="text-xs font-normal text-muted-foreground">shows on many pages</span></h3>
            <ul class="space-y-0.5">
              {#each shownSiteWide as s (s.key)}
                <li class="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px]">
                  {@render pageTag(s.change)}
                  {@render stagingLink(s.title, s.samplePath === null ? null : stagingPageHref(data.staging, s.samplePath))}
                  <span class="text-xs text-muted-foreground">{s.what}</span>
                </li>
              {/each}
            </ul>
            {#if siteWide.length > 3}
              <button type="button" class="text-xs text-link underline-offset-2 hover:underline" onclick={() => (showAllSiteWide = !showAllSiteWide)}>
                {showAllSiteWide ? "Show fewer" : `Show all ${siteWide.length}`}
              </button>
            {/if}
          </section>
        {/if}

        {#if goingLive.length > 0 || data.redirects.waiting.length > 0 || data.redirects.problem}
          <section id="review-redirects" class="space-y-1 border-t pt-3" data-testid="publish-redirects">
            <h3 class="font-medium">Redirects <span class="text-xs font-normal text-muted-foreground">{countOf(goingLive.length, "goes live", "go live")}</span></h3>
            {#if data.redirects.problem}
              <p role="alert" class="text-xs text-red-700 dark:text-red-300">{data.redirects.problem}</p>
            {/if}
            <ul class="space-y-0.5" data-testid="publish-redirects-going">
              {#each redirectGroups.slice(0, 3) as g (g.label)}
                <li class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span class="font-mono text-xs [overflow-wrap:anywhere]">{g.label}</span>
                  {#if g.count > 1}<span class="rounded-full bg-muted px-2 text-[11px] font-semibold tabular-nums">{g.count}</span>{/if}
                </li>
              {/each}
            </ul>
            {#if goingLive.length > 3}
              <button type="button" class="text-xs text-link underline-offset-2 hover:underline" onclick={() => (showAllRedirects = !showAllRedirects)}>
                {showAllRedirects ? "Hide the full list" : `Show all ${goingLive.length}`}
              </button>
            {/if}
            {#if showAllRedirects}
              <div class="space-y-1.5 pt-1">
                <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <input
                    id="publish-review-redirect-search"
                    type="search"
                    bind:value={redirectQuery}
                    placeholder="Search addresses"
                    aria-label="Search redirects"
                    class="min-w-0 max-w-xs flex-1 rounded-md border bg-background px-2 py-1 text-sm text-foreground"
                  />
                  <span class="tabular-nums">{filteredRedirects.length} of {goingLive.length}</span>
                </div>
                <ul class="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-2 font-mono text-xs">
                  {#each filteredRedirects as r (r.id)}<li class="[overflow-wrap:anywhere]">{redirectRule(r)}</li>{/each}
                </ul>
              </div>
            {/if}
            {#if data.redirects.waiting.length > 0}
              <p class="text-xs text-muted-foreground" data-testid="publish-redirects-waiting">
                {countOf(data.redirects.waiting.length, "more waits", "more wait")} for the page they lead to and go live with the Publish live that ships it.
                <button type="button" class="text-link underline-offset-2 hover:underline" onclick={() => (showWaiting = !showWaiting)}>{showWaiting ? "Hide" : "Show"}</button>
              </p>
              {#if showWaiting}
                <ul class="space-y-0.5 font-mono text-xs">
                  {#each data.redirects.waiting as r (r.id)}<li class="[overflow-wrap:anywhere]">{redirectRule(r)}</li>{/each}
                </ul>
              {/if}
            {/if}
          </section>
        {/if}

        {#if preview.settings.length > 0}
          <section id="review-settings" class="space-y-1 border-t pt-3" data-testid="publish-review-settings">
            <h3 class="font-medium">Settings</h3>
            <ul class="space-y-0.5">
              {#each preview.settings as s (s.key)}<li class="text-[13px]">{s.title}</li>{/each}
            </ul>
          </section>
        {/if}
      </div>
    {/if}

    <form id={FORM_ID} method="post" action="?/promoteToProduction" use:enhance={submit}>
      <input type="hidden" name="_csrf" value={csrfToken} />
      <input type="hidden" name="stagedRunId" value={preview?.staged?.runId ?? ""} />
      <input type="hidden" name="redirectChanges" value={data ? confirmedRedirects(data.redirects) : ""} />
    </form>
    <div class="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
      <p class="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="publish-review-drafts">
        {#if draftChangeCount > 0}
          Your {countOf(draftChangeCount, "draft change is", "draft changes are")} not in this build. Stage first to include them.
        {:else}
          You publish exactly this list.
        {/if}
      </p>
      <div class="flex gap-2">
        <Button type="button" variant="outline" size="sm" onclick={() => (open = false)}>Cancel</Button>
        {@render publishButton("publish-review-confirm")}
      </div>
    </div>
  </DialogContent>
</Dialog>

<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.8.0 — split-button Stage / Publish in the /edit toolbar.
   *
   * v0.7.x put this in the chat overlay (per-chat surface). v0.8.0 moves
   * it to the toolbar so the gesture lives in page-mental-model context
   * — chats stay the atomic revert unit under the hood, but the
   * operator never has to think about them to ship work.
   *
   * Two controls (the toolbar redesign of 2026-10):
   *
   *   [Staging ▾]            → its label says where staging stands
   *                            ("14 draft changes", staged, N problems,
   *                            check failed …), so a closed Publish live
   *                            always has its reason on screen. The menu
   *                            lists the operator's own conversations with
   *                            draft changes (DraftChatList: this chat
   *                            first, highlighted and ticked; Stage now,
   *                            Stage selected, Stage all), holds the
   *                            quality-gate actions and Stage again, and
   *                            links to staging.
   *   [Publish live | ▾]     → the human-only decision (coral). The click
   *                            opens the Publish live review (what goes
   *                            live, PublishLiveReview); the caret opens the
   *                            live-site menu: this page live, the live
   *                            site, and whether live matches staging.
   */
  import { pluginApprovals } from "#lib/plugin-approvals.svelte.js";
  import { Check, ChevronDown, ExternalLink, LoaderCircle } from "lucide-svelte";
  import { enhance, type SubmitFunction } from "$app/forms";
  import StateDot from "#lib/components/StateDot.svelte";
  import { Button, buttonVariants } from "#lib/components/ui/button/index.js";
  import { Popover, PopoverContent, PopoverTrigger } from "#lib/components/ui/popover/index.js";
  import { cn } from "#lib/utils.js";
  import LinkNoticeBanner from "#lib/components/LinkNoticeBanner.svelte";
  import { askInChat } from "./ask-in-chat.js";
  import DraftChatList from "./DraftChatList.svelte";
  import { type DraftChat, totalChanges } from "./draft-chats.js";
  import PublishLiveReview from "./PublishLiveReview.svelte";
  import StageRunProgress from "./StageRunProgress.svelte";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "#lib/components/ui/dialog/index.js";
  import {
    postQualityAction,
    type QualityGate,
    qualityStatusFor,
  } from "./quality-status.svelte.js";
  import {
    formResultError,
    offersStageAgain,
    publishButtonState,
    publishErrorNextStep,
    qualityBlockReason,
    type StagingTone,
    stageToolbarMode,
    stagingMenuState,
  } from "./stage-deploy-state.js";

  interface LastStaged {
    runId: string;
    finishedAt: string;
    previewUrl: string | null;
  }

  let {
    drafts,
    csrfToken,
    chatSessionId,
    chatBranchId,
    activePageId = null,
    sessionPublished = false,
    sessionLastStagedAt = null,
    lastStaged = null,
    lastPublishedLive = null,
    productionMatchesStaging = null,
    lastStageFailure = null,
    live,
  }: {
    /**
     * The operator's own conversations with draft changes (streamed in;
     * `chats` is null until they arrive, `error` says why they did not).
     */
    drafts: { chats: readonly DraftChat[] | null; loading: boolean; error: string | null };
    csrfToken: string;
    chatSessionId: string;
    /** The chat's branch: a status change on a link notice belongs to it. */
    chatBranchId: string;
    activePageId?: string | null;
    sessionPublished?: boolean;
    /**
     * v0.10.9 — `chat_sessions.last_staged_at`, set by chat.merge_to_main.
     * Combined with `lastStaged` (most-recent staging deploy_run) to
     * decide whether the count===0 branch shows "Promote staging" (chat
     * has been Staged before, has something to promote) or "No pending
     * changes" (fresh chat, never Staged, nothing to promote).
     */
    sessionLastStagedAt?: string | null;
    /**
     * v0.8.0 — last successful staging deploy. Shown atop the Promote
     * modal so the operator knows what they're about to push live.
     */
    lastStaged?: LastStaged | null;
    /**
     * v0.10.12 — whether the last succeeded production deploy was
     * sourced from the current `lastStaged` runId (i.e. live ===
     * staging). `null` means unknown (no production deploy yet or no
     * staging build to compare). Drives the inline "Live matches
     * staging" / "Newer staged build" indicator next to Publish live.
     */
    productionMatchesStaging?: boolean | null;
    /** The latest succeeded production deploy, for the live-site menu. */
    lastPublishedLive?: { finishedAt: string } | null;
    /** #1207 — the newest staging build, when it failed. */
    lastStageFailure?: { error: string } | null;
    /** Where the shown page and the site are live (`#lib/server/live-links.ts`). */
    live: {
      error: string | null;
      siteUrl: string | null;
      pageUrl: string | null;
      pageNote: string | null;
    };
  } = $props();

  /** The operator's draft changes across their conversations ("14 draft changes"). */
  const draftChangeCount = $derived(totalChanges(drafts.chats ?? []));
  /**
   * issue #262 — inline Stage failure text, rendered inside the dialog.
   * The layout-level toast dedups identical consecutive form results, so
   * a retried Stage that fails the same way a second time shows NO toast
   * at all (run #7's "silent no-op" experience). The dialog is where the
   * operator is looking; the failure must be visible there, persistently,
   * until the next attempt.
   */
  let stageError = $state<string | null>(null);
  /**
   * run #10 D6 — inline Publish-live failure text, same rationale as
   * `stageError` (#267): the layout toast dedups identical consecutive
   * form results, so a retried identical promote failure showed NO
   * feedback at all. Persistent next to the button until the next
   * attempt; immune to toast dedup.
   */
  let publishError = $state<string | null>(null);
  /** #835 — the next step under a parity refusal, kept out of the truncation. */
  const publishNextStep = $derived(publishErrorNextStep(publishError));
  /** #835 — inline Stage again failure, same persistence rule as `stageError`. */
  let restageError = $state<string | null>(null);
  const toolbarMode = $derived(
    stageToolbarMode({
      sessionPublished,
      draftChangeCount,
      hasStagedBuild: lastStaged !== null,
      sessionLastStagedAt,
    }),
  );
  let stagingMenuOpen = $state(false);
  let liveMenuOpen = $state(false);
  let publishing = $state(false);
  let staging = $state(false);
  /**
   * #553 — the quality gate of the staged build, polled with the chat panel
   * (one shared request stream per chat). Publish live is disabled with a
   * visible reason while the gate is closed; the server enforces it anyway.
   */
  const quality = $derived(qualityStatusFor(chatSessionId));
  $effect(() => {
    const poller = quality;
    poller.acquire();
    return () => poller.release();
  });
  const gate = $derived(quality.status?.gate ?? null);
  let qualityActionError = $state<string | null>(null);
  let qualityBusy = $state(false);
  let publishAnywayOpen = $state(false);
  let publishAnywayError = $state<string | null>(null);

  type TopProblem = QualityGate["topProblems"][number];

  /** #1207 — the composer text of a top problem's row: fix just this group. */
  function fixOnePrompt(problem: TopProblem): string {
    const paths = problem.pages.map((p) => p.pagePath).join(", ");
    const where =
      problem.pageCount === problem.pages.length ? paths : `${problem.pageCount} pages, e.g. ${paths}`;
    return `Fix the quality problem "${problem.title}" (${problem.key}) on ${where}.`;
  }

  /** The row's second line: a few pages with their measured value. */
  function problemPagesLine(problem: TopProblem): string {
    const shown = problem.pages.map((p) => (p.detail ? `${p.pagePath} (${p.detail})` : p.pagePath));
    return shown.join(", ") + (problem.pageCount > problem.pages.length ? ", …" : "");
  }

  async function retryQualityCheck(): Promise<void> {
    qualityBusy = true;
    qualityActionError = null;
    try {
      const r = await postQualityAction(chatSessionId, csrfToken, { action: "retry" });
      if (!r.ok) qualityActionError = r.error ?? "Could not start the quality check.";
    } finally {
      qualityBusy = false;
      await quality.refresh();
    }
  }

  /**
   * #1207 — why the newest Stage failed: refused in this view (kept until
   * the next attempt), or a failed staging build the server reports.
   */
  const stageFailure = $derived(stageError ?? restageError ?? lastStageFailure?.error ?? null);

  /** The Staging button's label: where staging stands, at a glance. */
  const stagingView = $derived(
    stagingMenuState({
      mode: toolbarMode,
      staging,
      hasStagedBuild: lastStaged !== null,
      draftChangeCount,
      qualityGate: gate,
      stageFailure,
      draftError: drafts.error,
    }),
  );
  const STAGING_TONE: Record<StagingTone, string> = {
    neutral: "",
    pending: "border-amber-500/50 text-amber-800 dark:text-amber-300",
    busy: "text-muted-foreground",
    ok: "border-emerald-500/50 text-emerald-800 dark:text-emerald-300",
    problem: "border-red-500/50 text-red-700 dark:text-red-300",
  };

  /** run #10 D6 — shared disabled/visible-reason logic (unit-tested). */
  const publishState = $derived(
    publishButtonState({
      busy: staging || publishing,
      hasStagedBuild: lastStaged !== null,
      productionMatchesStaging: productionMatchesStaging ?? null,
      qualityGate: gate,
      stageFailure,
    }),
  );

  /**
   * #1420 — the server refuses while a plugin is stopped, so the click goes
   * straight to the decision that unblocks it. Without the right to decide
   * the refusal itself explains it.
   */
  function openApprovalInstead(event: MouseEvent) {
    if (pluginApprovals.releases.length === 0 || !pluginApprovals.canApprove) return;
    event.preventDefault();
    pluginApprovals.dialogOpen = true;
  }

  /**
   * The Publish live review: every Publish live click opens it first
   * (decision 2026-11-17); its form posts the staged run and the redirect
   * changes it showed, so exactly that goes live.
   */
  let reviewOpen = $state(false);

  function openReview(event: MouseEvent): void {
    openApprovalInstead(event);
    if (event.defaultPrevented) return;
    publishError = null;
    liveMenuOpen = false;
    reviewOpen = true;
  }

  /** Publish live's form submit, shared by the button and the Live menu's override. */
  const publishEnhance: SubmitFunction = () => {
    publishing = true;
    publishError = null;
    liveMenuOpen = false;
    reviewOpen = false;
    return async ({ result, update }) => {
      try {
        await update({ reset: false });
      } finally {
        publishing = false;
      }
      publishError = formResultError(result);
      void quality.refresh();
    };
  };

  /**
   * The Draft changes list's Stage (Stage now / selected / all): the menu
   * closes, the toolbar shows the running Stage, a refusal stays on screen
   * until the next attempt (#262: the layout toast dedups repeats).
   */
  const stageEnhance: SubmitFunction = () => {
    staging = true;
    stageError = null;
    restageError = null;
    stagingMenuOpen = false;
    return async ({ result, update }) => {
      try {
        await update({ reset: false });
      } finally {
        staging = false;
      }
      stageError = formResultError(result);
      // A fresh Stage replaces what a refused Publish live compared against.
      if (stageError === null) publishError = null;
      // #553 — the Stage just queued (or skipped) a quality check.
      void quality.refresh();
    };
  };

  function formatRelativeTime(iso: string): string {
    const t = new Date(iso).getTime();
    const dt = Math.max(0, Date.now() - t);
    if (dt < 60_000) return "just now";
    if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
    if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
    return `${Math.floor(dt / 86_400_000)}d ago`;
  }
</script>

<!-- run #10 D6 — ONE Publish live control for every toolbar shape. Its
     click opens the review (PublishLiveReview), whose form publishes. A
     failed Publish renders a persistent inline alert, immune to toast dedup
     (#267). #779 — Publish live is a human-only decision, so it is coral
     (`decide`). Its caret opens the live-site menu: where the page is live,
     and whether live matches staging. -->
{#snippet liveControls(testid: string)}
  <div class="inline-flex" data-testid="live-controls">
    <Button
      type="button"
      size="sm"
      variant="decide"
      class="rounded-r-none"
      disabled={publishState.disabled}
      title={publishState.tooltip}
      data-testid={testid}
      onclick={openReview}
    >
      {#if publishing}
        <LoaderCircle class="size-3.5 animate-spin motion-reduce:animate-none" />Publishing…
      {:else if productionMatchesStaging === true}
        <Check class="size-3.5" />Live
      {:else}
        Publish live
      {/if}
    </Button>
    <Popover bind:open={liveMenuOpen}>
      <PopoverTrigger
        class={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "rounded-l-none border-l-0 px-1.5",
        )}
        aria-label="Live site"
        title="View the live site"
        data-testid="live-menu"
      >
        <ChevronDown class="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" class="w-72 p-0">
        <div class="space-y-1 p-3">
          <h2 class="text-sm font-semibold">Live site</h2>
          <p class="text-xs text-muted-foreground" data-testid="live-sync-indicator">
            {#if productionMatchesStaging === true}
              <StateDot state="live">Live matches staging</StateDot>
            {:else if productionMatchesStaging === false}
              <StateDot state="preview">A newer staged build is not live yet</StateDot>
            {:else if lastPublishedLive}
              Published live {formatRelativeTime(lastPublishedLive.finishedAt)}
            {:else}
              Nothing published live yet
            {/if}
          </p>
          {#if lastPublishedLive && productionMatchesStaging !== null}
            <p class="text-xs text-muted-foreground">
              Published live {formatRelativeTime(lastPublishedLive.finishedAt)}
            </p>
          {/if}
          {#if publishState.visibleReason}
            <p class="text-xs text-muted-foreground" data-testid="publish-disabled-reason">
              {publishState.visibleReason}
            </p>
          {/if}
        </div>
        {#if publishState.overridable && lastStaged}
          <!-- #1207 — the staged build passed its own checks; publishing it
               over a failed Stage is allowed, as a choice that says what goes live. -->
          <div class="space-y-2 border-t p-3" data-testid="publish-older-build">
            <p class="text-xs text-muted-foreground">
              Staging still holds the build from {formatRelativeTime(lastStaged.finishedAt)}, without
              the changes of the failed Stage.
            </p>
            <!-- The review shows that build: what it puts live, before the click. -->
            <Button
              type="button"
              size="sm"
              variant="outline"
              class="w-full"
              disabled={staging || publishing}
              onclick={openReview}
            >
              Publish that build live anyway…
            </Button>
          </div>
        {/if}
        <div class="border-t p-1">
          {#if live.error}
            <p class="px-2 py-1.5 text-xs text-red-700 dark:text-red-300" role="alert">
              The site address could not be read: {live.error}
            </p>
          {:else if live.siteUrl === null}
            <p class="px-2 py-1.5 text-xs text-muted-foreground">
              The site has no address yet. Set it in Settings, SEO.
            </p>
          {:else}
            {#if live.pageUrl}
              <a
                href={live.pageUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                data-testid="live-page-link"
              >
                <ExternalLink class="size-3.5" />This page live
              </a>
            {:else if live.pageNote}
              <p class="px-2 py-1.5 text-xs text-muted-foreground" data-testid="live-page-missing">
                {live.pageNote}
              </p>
            {/if}
            <a
              href={live.siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
              data-testid="live-site-link"
            >
              <ExternalLink class="size-3.5" />Live site
            </a>
          {/if}
        </div>
      </PopoverContent>
    </Popover>
  </div>
  {#if publishError}
    <span
      role="alert"
      data-testid="publish-error"
      title={publishError}
      class="inline-block max-w-72 truncate align-middle text-xs font-medium text-red-700 dark:text-red-300"
    >
      Publish failed: {publishError}
    </span>
  {/if}
  {#if publishNextStep}
    <span class="text-xs font-medium text-foreground" data-testid="publish-error-next-step">
      {publishNextStep}
    </span>
  {/if}
{/snippet}

<!-- #835 — Stage again without pending edits: rebuilds staging from the
     current main. The one re-Stage control of the promote-only shape,
     whatever the quality gate says — after a parity refusal, a Caelo
     upgrade or fixes written live, it is the operator's only way to a
     fresh Stage. -->
{#snippet stageAgainForm()}
  <form
    method="post"
    action="?/stageAndDeployStaging"
    use:enhance={() => {
      staging = true;
      // #1207 — one failure state for both Stage paths: a new attempt
      // replaces whatever the last one said, whichever button it came from.
      restageError = null;
      stageError = null;
      stagingMenuOpen = false;
      return async ({ result, update }) => {
        try {
          await update({ reset: false });
        } finally {
          staging = false;
        }
        restageError = formResultError(result);
        // A fresh Stage replaces what a refused Publish live compared against.
        if (restageError === null) publishError = null;
        void quality.refresh();
      };
    }}
    class="contents"
  >
    <input type="hidden" name="chatSessionId" value={chatSessionId} />
    {#if activePageId}<input type="hidden" name="pageId" value={activePageId} />{/if}
    <input type="hidden" name="_csrf" value={csrfToken} />
    <Button
      type="submit"
      size="sm"
      variant="outline"
      disabled={staging || publishing}
      title="Rebuild staging from the current site, then check it before Publish live"
      data-testid="restage-btn"
    >
      {staging ? "Staging…" : "Stage again"}
    </Button>
  </form>
{/snippet}

<!-- #553 — what to do when the quality gate keeps Publish live closed:
     fix the problems in the chat, retry a failed / missing check, publish
     anyway over a FAILED check (an explicit, recorded human decision). -->
{#snippet qualityGateControls()}
  {#if gate && !gate.open}
    <div class="space-y-2" data-testid="quality-gate-status" data-state={gate.state}>
      {#if gate.linkNotice}
        <!-- #1240 — the same list and actions as the publish click. -->
        <LinkNoticeBanner
          notice={gate.linkNotice}
          {csrfToken}
          draftAction="?/setPagesToDraft"
          chat={{ sessionId: chatSessionId, branchId: chatBranchId }}
          onFix={(prompt) => {
            stagingMenuOpen = false;
            askInChat(prompt);
          }}
        />
      {:else}
        <p class="text-xs">{qualityBlockReason(gate)}</p>
      {/if}
      <div class="flex flex-wrap gap-2">
        {#if gate.state === "problems"}
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="quality-fix-in-chat"
            onclick={() => {
              stagingMenuOpen = false;
              askInChat("Fix the quality problems of the staged build.");
            }}
          >
            Fix in chat
          </Button>
        {/if}
        {#if gate.state === "render"}
          <!-- #1604 — content the Stage could not render: only a repair and
               a new Stage open the gate, never an acceptance. -->
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="quality-repair-render-in-chat"
            onclick={() => {
              stagingMenuOpen = false;
              askInChat(
                "Repair the spots the staged build could not render, then Stage again.",
              );
            }}
          >
            Repair in chat
          </Button>
        {/if}
        {#if gate.state === "errored" || gate.state === "missing"}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={qualityBusy}
            data-testid="quality-retry-btn"
            onclick={() => void retryQualityCheck()}
          >
            {gate.state === "errored" ? "Retry check" : "Run quality check"}
          </Button>
        {/if}
        {#if gate.canPublishAnyway}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="quality-publish-anyway-btn"
            onclick={() => {
              stagingMenuOpen = false;
              publishAnywayError = null;
              publishAnywayOpen = true;
            }}
          >
            Publish anyway…
          </Button>
        {/if}
      </div>
      {#if gate.state === "problems" && gate.topProblems.length > 0}
        <!-- #1207 — what blocks Publish live, without opening the chat card:
             the largest groups by pages; a row asks the AI to fix just that one. -->
        <ul class="-mx-2 space-y-0.5" data-testid="quality-top-problems">
          {#each gate.topProblems as problem (problem.key)}
            <li>
              <button
                type="button"
                class="w-full rounded px-2 py-1.5 text-left hover:bg-accent"
                title="Ask the AI to fix this one"
                data-testid="quality-top-problem"
                onclick={() => {
                  stagingMenuOpen = false;
                  askInChat(fixOnePrompt(problem));
                }}
              >
                <span class="flex items-baseline gap-2 text-xs">
                  <span class="min-w-0 flex-1 truncate font-medium">{problem.title}</span>
                  <span class="shrink-0 text-muted-foreground tabular-nums">
                    {problem.pageCount} {problem.pageCount === 1 ? "page" : "pages"}
                  </span>
                </span>
                <span class="block truncate font-mono text-[11px] text-muted-foreground">
                  {problemPagesLine(problem)}
                </span>
              </button>
            </li>
          {/each}
        </ul>
        {#if gate.problemGroupCount > gate.topProblems.length}
          <p class="text-xs text-muted-foreground">
            And {gate.problemGroupCount - gate.topProblems.length} more kinds of problems — Fix in chat covers all of them.
          </p>
        {/if}
      {/if}
      {#if qualityActionError}
        <p role="alert" class="text-xs font-medium text-red-700 dark:text-red-300" data-testid="quality-action-error">
          {qualityActionError}
        </p>
      {/if}
    </div>
  {/if}
{/snippet}

<div
  class="inline-flex items-center gap-1.5"
  data-testid="stage-deploy"
  data-mode={toolbarMode}
  data-this-chat-pending={drafts.chats?.some((c) => c.chatSessionId === chatSessionId) ? "true" : "false"}
>
  <Popover bind:open={stagingMenuOpen}>
    <PopoverTrigger
      class={cn(buttonVariants({ variant: "outline", size: "sm" }), STAGING_TONE[stagingView.tone])}
      title={stagingView.tooltip}
      aria-label={`Staging: ${stagingView.tooltip}`}
      data-testid="staging-menu"
      data-tone={stagingView.tone}
    >
      {#if stagingView.tone === "busy"}
        <LoaderCircle class="size-3.5 animate-spin motion-reduce:animate-none" />
      {:else if stagingView.tone === "ok"}
        <Check class="size-3.5" />
      {:else if stagingView.tone !== "neutral"}
        <span class="size-2 rounded-full bg-current" aria-hidden="true"></span>
      {/if}
      {stagingView.label}
      <ChevronDown class="size-3.5 opacity-60" />
    </PopoverTrigger>
    <PopoverContent align="end" class="w-[26rem] max-w-[calc(100vw-2rem)] p-0" data-testid="staging-menu-content">
      <div class="space-y-3 p-3">
        <div class="flex items-baseline justify-between gap-3">
          <h2 class="text-sm font-semibold">Staging</h2>
          <span class="text-xs text-muted-foreground" data-testid="last-staged">
            {lastStaged ? `Built ${formatRelativeTime(lastStaged.finishedAt)}` : "Nothing staged yet"}
          </span>
        </div>
        <!-- #1288 — a running Stage's step, progress and time left. -->
        <StageRunProgress />

        {#if drafts.error}
          <!-- Loud: the list is unknown, never shown as "nothing to stage". -->
          <p role="alert" class="text-xs font-medium text-red-700 dark:text-red-300" data-testid="draft-chats-error">
            {drafts.error}
          </p>
        {:else if drafts.chats === null}
          <p class="text-xs text-muted-foreground" role="status" data-testid="draft-chats-loading">
            Reading your draft changes…
          </p>
        {:else if drafts.chats.length > 0}
          <div class="space-y-1.5" data-testid="draft-changes">
            <h3 class="text-xs font-medium text-muted-foreground">
              Draft changes · not on staging yet
            </h3>
            <DraftChatList
              chats={drafts.chats}
              activeChatId={chatSessionId}
              action="?/stageAndDeployStaging"
              {csrfToken}
              busy={staging || publishing}
              submit={stageEnhance}
              hidden={activePageId ? { pageId: activePageId } : {}}
            />
          </div>
        {:else if toolbarMode === "published"}
          <p class="text-xs text-muted-foreground">This chat's work was published live.</p>
        {:else if toolbarMode === "fresh"}
          <p class="text-xs text-muted-foreground">
            No draft changes yet. Ask the AI for a change, then stage it here.
          </p>
        {/if}
        {#if stageError}
          <p role="alert" class="text-xs font-medium text-red-700 dark:text-red-300" data-testid="stage-error">
            Stage failed: {stageError}
          </p>
        {/if}

        {@render qualityGateControls()}

        {#if offersStageAgain(toolbarMode)}
          <div>{@render stageAgainForm()}</div>
        {/if}
        {#if restageError}
          <p role="alert" class="text-xs font-medium text-red-700 dark:text-red-300" data-testid="restage-error">
            Stage failed: {restageError}
          </p>
        {/if}
      </div>
      {#if lastStaged?.previewUrl}
        <div class="border-t p-1">
          <a
            href={lastStaged.previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
            data-testid="staging-preview-link"
          >
            <ExternalLink class="size-3.5" />Open staging
          </a>
        </div>
      {/if}
    </PopoverContent>
  </Popover>
  {#if toolbarMode !== "published"}
    {@render liveControls(toolbarMode === "pending" ? "promote-btn" : "promote-only-btn")}
  {/if}
  {#if (stageError ?? restageError) && !stagingMenuOpen}
    <span role="alert" class="max-w-60 truncate text-xs font-medium text-red-700 dark:text-red-300" title={stageError ?? restageError}>
      Stage failed: {stageError ?? restageError}
    </span>
  {/if}
</div>

<PublishLiveReview
  bind:open={reviewOpen}
  {csrfToken}
  submit={publishEnhance}
  busy={staging || publishing}
  {gate}
  {draftChangeCount}
/>

<Dialog bind:open={publishAnywayOpen}>
  <DialogContent class="sm:max-w-md">
    <DialogHeader>
      <DialogTitle>Publish without a quality result?</DialogTitle>
      <DialogDescription>
        The quality check of the staged build failed, so nobody knows whether it has new
        accessibility, SEO or performance problems. Publishing anyway is recorded with your name
        and reason.
      </DialogDescription>
    </DialogHeader>
    {#if gate}
      <p class="text-xs text-muted-foreground" data-testid="publish-anyway-failure">{gate.message}</p>
    {/if}
    <form
      method="post"
      action="?/publishAnyway"
      use:enhance={() => {
        publishing = true;
        publishAnywayError = null;
        return async ({ result, update }) => {
          try {
            await update({ reset: false });
          } finally {
            publishing = false;
          }
          publishAnywayError = formResultError(result);
          if (publishAnywayError === null) publishAnywayOpen = false;
          void quality.refresh();
        };
      }}
      class="space-y-3"
    >
      <input type="hidden" name="_csrf" value={csrfToken} />
      <input type="hidden" name="auditRunId" value={gate?.auditRunId ?? ""} />
      <label class="block space-y-1 text-sm">
        <span class="font-medium">Why publish without the check?</span>
        <textarea
          name="reason"
          required
          minlength="3"
          maxlength="500"
          rows="3"
          class="w-full rounded-md border bg-background p-2 text-sm"
          data-testid="publish-anyway-reason"
        ></textarea>
      </label>
      {#if publishAnywayError}
        <div role="alert" class="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-800 dark:text-red-200">
          {publishAnywayError}
        </div>
      {/if}
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onclick={() => (publishAnywayOpen = false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="destructive" disabled={staging || publishing} data-testid="publish-anyway-submit">
          {publishing ? "Publishing…" : "Publish anyway"}
        </Button>
      </DialogFooter>
    </form>
  </DialogContent>
</Dialog>

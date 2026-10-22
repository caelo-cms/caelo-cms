<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * ChatPanel — the three-pane chat surface used by:
   *   - /content/chat/[sessionId] (admin chat editor)
   *   - P6.7's /edit live-edit overlay (re-mounts this same component
   *     inside the floating overlay).
   *
   * Holds transcript / composer / publish-and-diff sidebar. SSE streaming
   * to /content/chat/[sessionId]/stream stays untouched.
   */

  import { CHAT_IMAGE_MIMES, CHAT_MAX_ATTACHMENTS, CHAT_MAX_ATTACHMENT_BYTES } from "@caelo-cms/shared";
  import { ArrowDown, ImagePlus, Lock, Square, Unlock } from "lucide-svelte";
  import { onMount, tick } from "svelte";
  import { page } from "$app/state";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import { buttonVariants } from "#lib/components/ui/button/button-variants.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import { cn } from "#lib/utils.js";
  import RunningAgentsBar from "#lib/components/agents/RunningAgentsBar.svelte";
  import {
    fetchAgentRuns,
    heldBackNote,
    mayStartTurn,
    postAgentAction,
  } from "#lib/components/agents/agent-runs-client.js";
  import DebugPanel from "./DebugPanel.svelte";
  import type { DebugToolCall, DebugUsage } from "./debug-types.js";
  import CredentialHandoffs from "../CredentialHandoffs.svelte";
  import InlineDiff from "./InlineDiff.svelte";
  import QualityFixOfferCard from "./QualityFixOfferCard.svelte";
  import {
    autoContinueOffer,
    autoDeliverableNote,
    externalAgentRefusal,
    openQualityOffer,
    workingExternalAgent,
  } from "./quality-offer.js";
  import {
    postQualityAction,
    type QualityGroupSelection,
    qualityStatusFor,
  } from "#lib/components/edit/quality-status.svelte.js";
  import {
    type DecidedHandoff,
    decisionStillCurrent,
    EXTERNAL_AGENT_LABEL,
    externalDecisionNote,
    followUpAfterDecision,
    handoffStatusText,
    isImportKind,
    ownDecisionMessage,
    type RequestedVia,
    sdkApprovalRoute,
  } from "./approval-origin.js";
  import { parseProposalContent } from "./proposal-parser.js";
  import { measureLivePreview, resolveScreenshotViewport } from "./screenshot-viewport.js";
  import {
    collapseStatusNotes,
    contextNoteLabel,
    isContextNote,
    stripNoteMarker,
  } from "./status-notes.js";
  import StreamingMarkdown from "./StreamingMarkdown.svelte";
  import ToolCardRouter from "./tool-cards/ToolCardRouter.svelte";
  import type { ChatMessage, ChatModule, ChatSession } from "./types.js";

  import { readPluginPreviewReference, type PluginPreviewSelection } from "@caelo-cms/shared";

  interface Chip {
    moduleId: string;
    selector: string;
    label: string;
    /** Text the operator selected in the preview (right-click / selection toolbar). */
    selectedText?: string;
    /** Text of the block the reference sits in. */
    context?: string;
    /** #917 — the marked placement field the reference sits in. */
    blockName?: string;
    position?: number;
    field?: string;
    index?: number;
    /** When true the chip rides every send within this session (P6.7). */
    pinned?: boolean;
  }
  interface ProposedDiff {
    moduleId: string;
    before: string;
    after: string;
    selected: boolean;
  }

  /**
   * Callback fired on every successful `tool-result` SSE event. P6.7's
   * live-edit overlay subscribes here so it can postMessage a reload
   * to the iframe whenever the AI mutates a module. The chat editor at
   * /content/chat/[sessionId] doesn't pass this prop.
   */
  type ToolResultPayload = {
    toolCallId: string;
    ok: boolean;
    content: string;
    arguments?: { moduleId?: string; html?: string };
  };

  interface Props {
    previewSelection?: PluginPreviewSelection | null;
    onClearPreviewSelection?: () => void;
    session: ChatSession;
    initialMessages: ChatMessage[];
    modules: ChatModule[];
    csrfToken: string;
    formError?: string | null;
    /**
     * Sized-by-parent variant for the live-edit overlay. The default
     * uses `h-[calc(100vh-12rem)]` which is right inside AppShell but
     * overflows when embedded in the floating overlay.
     */
    compact?: boolean;
    /**
     * Chat-panel UX — quick-reply choices rendered above the composer
     * until the operator's first message. The onboarding welcome
     * carries three entry points; clicking one SENDS the prefilled
     * answer (zero typing for the choice itself, per CLAUDE.md §1A).
     */
    firstRunSuggestions?: { label: string; message: string }[];
    /** P6.7.3 — when set, the runner gets a Current-page system block. */
    activePageId?: string | null;
    onToolResult?: (payload: ToolResultPayload) => void;
    /**
     * Fired at turn end with the site's canonical 7-day AI spend in microcents,
     * read back from `ai_calls` by the runner once the turn's row landed. The
     * caller assigns it; it does not accumulate or derive anything, because a
     * money figure should be reported, not reconstructed.
     */
    onSpendUpdate?: (spend7dMicrocents: number) => void;
    /** v0.2.46 — render the debug panel alongside the publish/diff
     *  sidebar. Caller (page server load) gates on `?debug=1` URL param
     *  + permission check before passing true. */
    debug?: boolean;
    /**
     * v0.2.55 — operator has permission to flip the debug toggle. Set
     * by the page server load from `data.canDebug`. When true,
     * ChatPanel renders a small "🐞 Debug" button in the composer that
     * fires `onToggleDebug`; the parent persists the state (typically
     * via URL search-param) and re-passes `debug` accordingly.
     */
    canDebug?: boolean;
    onToggleDebug?: () => void;
  }
  let {
    session,
    initialMessages,
    modules,
    csrfToken,
    formError = null,
    compact = false,
    firstRunSuggestions = [],
    activePageId = null,
    previewSelection = null,
    onClearPreviewSelection,
    onToolResult,
    onSpendUpdate,
    debug = false,
    canDebug = false,
    onToggleDebug,
  }: Props = $props();

  let messages = $state<ChatMessage[]>(initialMessages);
  let composer = $state("");
  /**
   * SSR renders the composer disabled; onMount flips it. Until
   * hydration the keydown/submit handlers don't exist, so a visitor
   * (or Playwright) typing into the server-rendered textarea would
   * hit Enter into the void — CI lost exactly that race on every
   * cold-started run. Disabled-until-hydrated makes readiness visible
   * to actionability checks instead of a silent no-op window.
   */
  let hydrated = $state(false);
  let composerEl = $state<HTMLTextAreaElement | null>(null);

  // The /edit canvas empty state ("Chat and build your page") is one
  // big button; clicking it lands the operator here, cursor ready.
  $effect(() => {
    const focus = () => composerEl?.focus();
    window.addEventListener("caelo:focus-chat", focus);
    return () => window.removeEventListener("caelo:focus-chat", focus);
  });
  let streaming = $state(false);
  // Aborts the in-flight chat stream when the operator hits Stop. The server
  // sees the same abort via `request.signal`, stops the runner, and marks the
  // turn interrupted. Null when no stream is running.
  let streamAbort = $state<AbortController | null>(null);
  // Issue #664 — set by Stop: no auto-sent message (approval / quality /
  // import / queued choice nudges) starts the AI again until the operator
  // acts themselves. The server enforces the same latch per chat.
  let operatorStopped = $state(false);
  // Issue #658 — counts this tab's Stops. A decision clicked before a Stop
  // whose request returns after it must not continue the AI (the Stop is the
  // newer operator action); one clicked after the Stop does.
  let stopGeneration = 0;
  let stopError = $state<string | null>(null);

  // v0.2.45 — autoscroll + jump-to-latest button.
  // followBottom: when true (default), each new message / streaming-text
  // delta scrolls the transcript to the bottom. The user can pause
  // autoscroll by scrolling up >40px from the bottom; resuming is either
  // automatic (scrolling back to the bottom) or via the floating
  // "↓ Latest" button.
  let transcriptEl = $state<HTMLUListElement | null>(null);
  let followBottom = $state(true);
  // Tracks whether new content arrived while paused; the jump button
  // is only worth showing when content is actually waiting below.
  let hasNewContent = $state(false);

  function isNearBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
  }
  function scrollToBottom(): void {
    const el = transcriptEl;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }
  function jumpToLatest(): void {
    followBottom = true;
    hasNewContent = false;
    scrollToBottom();
  }
  function handleTranscriptScroll(): void {
    const el = transcriptEl;
    if (!el) return;
    if (isNearBottom(el)) {
      followBottom = true;
      hasNewContent = false;
    } else {
      followBottom = false;
    }
  }
  // Effect: any time messages or streaming-text changes, autoscroll if
  // we're following; otherwise mark that new content exists so the jump
  // button can surface.
  $effect(() => {
    // Read tracked sources so the effect re-runs.
    const _msgCount = messages.length;
    const _streamLen = streamingText.length;
    void _msgCount;
    void _streamLen;
    void tick().then(() => {
      // Before the operator's first message the transcript is the
      // onboarding welcome — a reader starts at the TOP. Jumping to
      // the bottom cut its first lines off in the 480px overlay.
      const hasUserTurn = messages.some((m) => m.role === "user");
      if (!hasUserTurn && !streaming) return;
      if (followBottom) scrollToBottom();
      else hasNewContent = true;
    });
  });

  /**
   * P6.7.4 — auto-grow the composer from one row up to 6, then scroll.
   * Called from `oninput` and after a send clears the value. Plain
   * function (not a Svelte effect) so it doesn't race with chip /
   * message state updates the way an `$effect` tracking
   * `composer.length` did.
   */
  function autoSizeComposer(): void {
    const el = composerEl;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = 22;
    const padding = 16;
    const maxRows = 6;
    const max = lineHeight * maxRows + padding;
    el.style.height = `${Math.min(max, el.scrollHeight)}px`;
  }
  let streamingText = $state("");
  // v0.2.54 — extended-thinking text accumulator. Streamed via the
  // `thinking-delta` SSE event, rendered in a collapsed details block
  // above the assistant streaming bubble. Cleared on `done` after
  // attaching to the persisted message via the page reload's data load.
  let streamingThinkingText = $state("");
  // v0.2.60 — live activity pill. Updated on every SSE event so the
  // operator sees a moving label between bursts of streaming text +
  // tool-card landings. Without this, the gap between the AI's
  // last text-delta and the first tool-start (Anthropic streams
  // tool args via input_json_delta which our runner accumulates
  // server-side before yielding tool-call) appears as silence.
  // Cleared on done.
  let currentActivity = $state<string | null>(null);
  // v0.2.63 — Pending proposals strip (sticky at the top of the
  // transcript). Surfaces every queued propose_* originating from
  // THIS chat so the operator can Approve / Reject without scrolling
  // up to find the original tool-card. Refreshed on mount + after
  // every successful tool-result. The endpoint is read-only; Approve
  // / Reject post to the existing /settings/<domain>/pending form
  // actions (same path ProposeCard uses).
  interface PendingProposal {
    proposalId: string;
    domain: string;
    kind: string;
    summary: string;
    proposedAt: string;
    queueUrl: string;
    /** Issue #658 — "power_mcp" when an external agent queued it. */
    requestedVia?: RequestedVia;
  }
  let pendingProposals = $state<PendingProposal[]>([]);
  // Issue #658 — this session's decided external-agent proposals: one
  // status line each ("handed back to the external agent") instead of a
  // nudge to this chat's AI.
  let mcpHandoffs = $state<DecidedHandoff[]>([]);
  let pendingActioning = $state<Record<string, "approving" | "rejecting" | null>>({});

  // Plan B (SDK approval gate) — gated tool calls a turn in this chat paused
  // on, awaiting the Owner's in-chat Approve/Reject. Populated from the
  // `tool-approval-request` SSE event and (issue #658) from the per-chat
  // pending endpoint, so a reload keeps the card and a caelo_chat turn's
  // card shows up at all; cleared when the operator decides.
  interface SdkApproval {
    approvalId: string;
    name: string;
    preview: string;
    /** #589 — permissions the approver needs; the server enforces them. */
    requiredPermissions: string[];
    /** Issue #658 — "mcp_chat" when an external agent's caelo_chat turn paused on it. */
    requestedVia: RequestedVia;
  }
  let sdkApprovals = $state<SdkApproval[]>([]);
  // #971 — bumped to re-read the "One-time credentials" strip.
  let credentialRefresh = $state(0);
  // Cards whose decision is on its way from this tab: a pending-list
  // refresh racing it must not bring them back meanwhile.
  const decidedApprovalIds = new Set<string>();
  let approvalDeciding = $state<Record<string, boolean>>({});

  /**
   * #589 — the permissions this operator lacks to approve `a`. Approve is
   * disabled when any are missing: the server would refuse the click anyway,
   * and the proposal waits in the Owner queue instead.
   */
  function missingApproverPermissions(a: SdkApproval): string[] {
    const held = new Set((page.data as { permissions?: string[] }).permissions ?? []);
    return a.requiredPermissions.filter((p) => !held.has(p));
  }

  /**
   * Approve/Reject a paused gated tool. Issue #658: this chat's own AI's card
   * resumes its turn (the operator's answer — also after a Stop); an external
   * agent's card only records the decision, the agent's own call resumes ITS
   * turn and receives the result. No AI turn starts here for it.
   */
  async function resolveSdkApproval(a: SdkApproval, approved: boolean): Promise<void> {
    if (sdkApprovalRoute(a.requestedVia) === "resume-turn") {
      // Hidden only while the resume is on its way: once it ended, the
      // server's list is the truth again — a resume that failed before it
      // claimed the card (network, refused) brings the card back to retry.
      decidedApprovalIds.add(a.approvalId);
      sdkApprovals = sdkApprovals.filter((x) => x.approvalId !== a.approvalId);
      try {
        await sendMessage(undefined, { approvalId: a.approvalId, approved });
      } finally {
        decidedApprovalIds.delete(a.approvalId);
        void loadPendingProposals();
      }
      return;
    }
    approvalDeciding = { ...approvalDeciding, [a.approvalId]: true };
    try {
      const res = await fetch(`/content/chat/${session.id}/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ approvalId: a.approvalId, approved }),
      });
      if (!res.ok) {
        chatError = (await res.text()) || `Could not record the decision (${res.status})`;
        return;
      }
      decidedApprovalIds.add(a.approvalId);
      sdkApprovals = sdkApprovals.filter((x) => x.approvalId !== a.approvalId);
      noteLocally(externalDecisionNote(approved ? "approve" : "reject", a.preview || a.name));
      void loadPendingProposals();
    } catch (e) {
      chatError = e instanceof Error ? e.message : String(e);
    } finally {
      approvalDeciding = { ...approvalDeciding, [a.approvalId]: false };
    }
  }

  async function loadPendingProposals(): Promise<void> {
    // #971 — an approval may have left a one-time credential for this
    // operator; the strip re-reads whenever the pending state does. A write
    // that does not read the state, so an $effect calling this never loops.
    credentialRefresh = performance.now();
    try {
      const res = await fetch(`/content/chat/${session.id}/pending`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        items?: PendingProposal[];
        handoffs?: DecidedHandoff[];
        turnApprovals?: SdkApproval[];
      };
      pendingProposals = data.items ?? [];
      mcpHandoffs = data.handoffs ?? [];
      // Issue #658 — the server's open in-chat cards are authoritative: a
      // card a newer message superseded (or another tab decided) goes away,
      // a caelo_chat turn's card appears.
      if (data.turnApprovals) {
        sdkApprovals = data.turnApprovals.filter((a) => !decidedApprovalIds.has(a.approvalId));
      }
    } catch {
      // Pending strip is best-effort. A network blip leaves the
      // existing list intact rather than wiping it.
    }
  }

  async function actOnPending(
    proposalId: string,
    queueUrl: string,
    action: "approve" | "reject",
    kind?: string,
    requestedVia: RequestedVia = null,
  ): Promise<void> {
    pendingActioning = {
      ...pendingActioning,
      [proposalId]: action === "approve" ? "approving" : "rejecting",
    };
    const summary = pendingProposals.find((p) => p.proposalId === proposalId)?.summary;
    const stopGenerationAtClick = stopGeneration;
    try {
      const fd = new FormData();
      fd.set("_csrf", csrfToken);
      fd.set("proposalId", proposalId);
      const res = await fetch(`${queueUrl}?/${action}`, {
        method: "POST",
        body: fd,
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        // Optimistically drop the row; reload to reflect any
        // server-side state shifts (e.g., other proposals that
        // chained on this one).
        pendingProposals = pendingProposals.filter((p) => p.proposalId !== proposalId);
        void loadPendingProposals();
        // v0.2.75 — propagate the approval so:
        //   1. The /edit overlay's preview iframe reloads (the
        //      proposal applied a change to the chat-branch
        //      snapshot — the iframe needs to refetch).
        //   2. The AI sees a follow-up message so it knows the
        //      approval landed + continues without the operator
        //      having to type "ok continue".
        // Both are no-ops outside an /edit-overlay chat context.
        //
        // Issue #658 — an external agent's proposal is NOT this chat's
        // work: its decision goes back to that agent (the hand-back line
        // in the strip shows it), so this chat's AI is not nudged. The
        // preview still reloads — an approved change is on the draft.
        if (followUpAfterDecision(requestedVia, action).continueChatAi) {
          onProposalDecided(kind, proposalId, action, stopGenerationAtClick);
        } else {
          if (action === "approve") {
            onToolResult?.({
              toolCallId: `approval-${proposalId}`,
              ok: true,
              content: "proposal applied",
            });
          }
          noteLocally(externalDecisionNote(action, summary ?? `${kind ?? "proposal"}`));
        }
      } else {
        pendingActioning = { ...pendingActioning, [proposalId]: null };
      }
    } catch {
      pendingActioning = { ...pendingActioning, [proposalId]: null };
    }
  }

  /**
   * v0.2.75 / v0.6.4 — follow-up after the operator decided a proposal this
   * chat's own AI queued. Two effects:
   *   (a) on Approve, fire onToolResult so the /edit overlay's existing
   *       handler reloads the preview iframe (mirrors the iframe-reload that
   *       happens after every AI tool result);
   *   (b) send the decision to the AI so it continues without the operator
   *       typing "ok continue" (Reject too, so it can react — issue #658).
   *
   * Issue #658 — the decision is the operator's own action: it continues the
   * AI also after a Stop (the answer to the AI's own question is the
   * go-ahead for that work). A Stop pressed AFTER the click still drops the
   * queued message (stopStreaming).
   *
   * v0.6.4 — when the AI is mid-stream at click time, queue the message in
   * `pendingApprovalNudges` instead of dropping it; the `$effect` below sends
   * the queue (combined into one message) the moment streaming ends.
   */
  function onProposalDecided(
    kind: string | undefined,
    proposalId: string,
    action: "approve" | "reject",
    stopGenerationAtClick = stopGeneration,
  ): void {
    if (action === "approve") {
      onToolResult?.({
        toolCallId: `approval-${proposalId}`,
        ok: true,
        content: "proposal applied",
      });
      // issue #228 — an approved import starts a background crawl; the panel
      // tracks it from this moment (polling is not a message, so it starts
      // regardless of streaming).
      if (isImportKind(kind)) startImportPolling(proposalId);
    }
    const text = ownDecisionMessage({ kind, proposalId, action });
    if (!decisionStillCurrent(stopGenerationAtClick, stopGeneration)) {
      noteHeldBack(text);
      return;
    }
    if (streaming) {
      pendingApprovalNudges = [...pendingApprovalNudges, { kind, proposalId, action }];
      return;
    }
    void sendAutoMessage(text, "operator");
  }

  // v0.6.4 — queue of approval nudges that landed while the AI was
  // mid-stream. The $effect below flushes them as a single combined
  // message when streaming ends.
  let pendingApprovalNudges = $state<
    { kind: string | undefined; proposalId: string; action: "approve" | "reject" }[]
  >([]);

  /**
   * issue #228 — live crawl status. After an approved site_import the
   * panel polls /content/chat/<id>/crawl-status every 4s: renders the
   * progress strip above the composer, and when the run reaches
   * ready_for_review posts the continuation nudge itself — the
   * operator never types "check status" to unstick the AI. v1 state
   * is in-memory: a reload drops the poll (documented in #228).
   */
  // NOTE: none of these identifiers may START with "import" — knip's
  // svelte script scanner misreads line-leading `import…` declarations
  // as import statements and loses every symbol reference below them
  // (html2canvas-pro then reports as an unused dependency).
  interface ImportRunStatus {
    runId: string;
    status: string;
    pagesExtracted: number;
    pagesSeen: number;
    maxPages: number;
    errorMessage: string | null;
  }
  let crawlRun = $state<ImportRunStatus | null>(null);
  let crawlPollTimer: ReturnType<typeof setInterval> | null = null;
  let pendingImportNudge = $state<string | null>(null);

  function stopImportPolling(): void {
    if (crawlPollTimer !== null) {
      clearInterval(crawlPollTimer);
      crawlPollTimer = null;
    }
  }

  function startImportPolling(runId: string): void {
    stopImportPolling();
    // Re-entrancy guard (review finding): a fetch slower than the 4s
    // interval must not overlap the next tick and race on crawlRun.
    let inFlight = false;
    const poll = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(
          `/content/chat/${session.id}/crawl-status?runId=${encodeURIComponent(runId)}`,
          { headers: { accept: "application/json" } },
        );
        if (!res.ok) return; // transient — keep polling
        const data = (await res.json()) as ImportRunStatus;
        crawlRun = data;
        if (data.status === "ready_for_review") {
          stopImportPolling();
          crawlRun = null;
          pendingImportNudge = `Crawl finished: run ${runId.slice(0, 8)} reached ready_for_review (${data.pagesExtracted} pages staged). The crawled pages are ready — continue building from the homepage.`;
        } else if (data.status === "failed") {
          stopImportPolling();
          pendingImportNudge = `Crawl failed: run ${runId.slice(0, 8)} — ${data.errorMessage ?? "no error message"}. Tell me what happened and what you'll try instead.`;
        } else if (data.status === "completed") {
          stopImportPolling();
          crawlRun = null;
        }
      } catch {
        // network blip — next tick retries
      } finally {
        inFlight = false;
      }
    };
    void poll();
    crawlPollTimer = setInterval(() => void poll(), 4000);
  }

  $effect(() => {
    // Flush the import nudge once the stream is idle — same contract
    // as the approval-nudge queue below.
    if (streaming) return;
    if (pendingImportNudge === null) return;
    if (composer.trim().length > 0) return;
    const text = pendingImportNudge;
    pendingImportNudge = null;
    void sendAutoMessage(text);
  });

  $effect(() => {
    return () => stopImportPolling();
  });

  /**
   * #553 / #685 — quality-gate feedback for THIS chat's Stages. Status notes
   * (passed / skipped / failed) are claimed exactly once (the server decides
   * the text and enforces once-only across tabs) and shown as they settle.
   * Problems never start the AI on their own — whoever staged (the operator,
   * this chat's AI, another agent): they are an OFFER, shown as a card, and
   * the fix round runs only when the operator clicks it. That click is the
   * operator's own action, so it lifts the Stop latch like a typed message
   * (#672); it is refused while an external agent works in this chat
   * (#682). The poller is shared with the /edit toolbar's Publish gate.
   */
  const qualityStatus = $derived(qualityStatusFor(session.id));
  $effect(() => {
    const poller = qualityStatus;
    poller.acquire();
    return () => poller.release();
  });
  let qualityRetryError = $state<string | null>(null);
  const claimedQualityNotes = new Set<string>();
  $effect(() => {
    const auditRunId = autoDeliverableNote(qualityStatus.status);
    if (auditRunId === null || claimedQualityNotes.has(auditRunId)) return;
    claimedQualityNotes.add(auditRunId);
    void (async () => {
      try {
        const r = await postQualityAction(session.id, csrfToken, { action: "claim", auditRunId });
        if (r.note) {
          messages = [
            ...messages,
            { id: `quality-${auditRunId}`, role: "user", origin: "system", content: r.note },
          ];
        }
      } catch {
        // Not claimed — the next poll offers it again.
        claimedQualityNotes.delete(auditRunId);
      } finally {
        void qualityStatus.refresh();
      }
    })();
  });

  const qualityOffer = $derived(openQualityOffer(qualityStatus.status));
  /** The audit whose offer the operator is acting on (its card is busy meanwhile). */
  let qualityOfferActing = $state<string | null>(null);
  /**
   * Whether the acting click settles the offer (fix / "Not now"): its card
   * hides meanwhile. An acceptance only shrinks the groups, so its card
   * stays up (busy) and switches to the status the accept answers with.
   */
  let qualityOfferSettling = $state(false);
  let qualityOfferError = $state<string | null>(null);
  let shownQualityOfferId: string | null = null;
  $effect(() => {
    // A new offer starts without the previous one's error.
    const id = qualityOffer?.auditRunId ?? null;
    if (id === shownQualityOfferId) return;
    shownQualityOfferId = id;
    qualityOfferError = null;
  });

  /**
   * "Fix with AI" — the operator's click starts the fix round (#685). #727:
   * `fixSelection` narrows it to the groups / pages picked on the card.
   * #771: `trigger` "auto" is the next round of a fix-all the operator
   * started, sent without a click (the Stop latch holds it back).
   */
  async function acceptQualityOffer(
    auditRunId: string,
    fixSelection: QualityGroupSelection[] | null = null,
    trigger: "operator" | "auto" = "operator",
  ): Promise<void> {
    if (streaming || qualityOfferActing !== null) return;
    qualityOfferActing = auditRunId;
    qualityOfferSettling = true;
    qualityOfferError = null;
    try {
      // #682 — one agent per chat: say so here instead of starting a turn
      // the server would refuse. (The server checks again — this is only
      // the early, clear answer.)
      const agent = workingExternalAgent(await fetchAgentRuns(session.id));
      if (agent) {
        qualityOfferError = externalAgentRefusal(agent);
        return;
      }
      // The claim also records the requested fix round — before the turn,
      // since the AI re-stages inside it.
      const r = await postQualityAction(session.id, csrfToken, {
        action: "claim",
        auditRunId,
        ...(fixSelection ? { fixSelection } : {}),
      });
      if (!r.ok) {
        qualityOfferError = r.error ?? "Could not start the fix — try again.";
        return;
      }
      if (!r.send) {
        qualityOfferError = "This fix request is already being handled (another tab?).";
        return;
      }
      // Settled for every tab the moment the turn starts — not when it
      // ends: a long fix turn would outlive the claim's lease, and another
      // tab could then offer (or dismiss) the fix while it runs.
      const started = await sendAutoMessage(r.send, trigger, () => {
        void postQualityAction(session.id, csrfToken, { action: "ack", auditRunId })
          .catch(() => undefined)
          .finally(() => void qualityStatus.refresh());
      });
      // Not started (refused, stopped, failed): give the claim back so the
      // card can be clicked again right away.
      if (!started) {
        await postQualityAction(session.id, csrfToken, {
          action: "release",
          auditRunId,
        }).catch(() => undefined);
      }
    } catch {
      qualityOfferError = "Could not start the fix — check the connection and try again.";
    } finally {
      qualityOfferActing = null;
      qualityOfferSettling = false;
      void qualityStatus.refresh();
    }
  }

  /** #771 — audits whose next fix round this tab already started on its own. */
  const autoContinuedAudits = new Set<string>();
  $effect(() => {
    const offer = autoContinueOffer(qualityOffer, {
      streaming,
      acting: qualityOfferActing !== null,
      composer,
      started: autoContinuedAudits,
    });
    if (offer === null) return;
    autoContinuedAudits.add(offer.auditRunId);
    void acceptQualityOffer(offer.auditRunId, null, "auto");
  });

  /**
   * #727 — "Accept all…" / "Accept selected…" on a group: the operator's own
   * acceptance with their reason, applied by this click (the AI is not
   * involved). The offer stays: the groups shrink to what is still open.
   * The card shows the status the accept answers with — read after it
   * applied — so an accepted group never reappears from the pre-accept
   * status, and a read already on the wire cannot bring it back either.
   */
  async function acceptQualityGroups(
    auditRunId: string,
    groups: QualityGroupSelection[],
    reason: string,
  ): Promise<void> {
    if (qualityOfferActing !== null) return;
    qualityOfferActing = auditRunId;
    qualityOfferError = null;
    try {
      const r = await postQualityAction(session.id, csrfToken, {
        action: "accept",
        auditRunId,
        groups,
        reason,
      });
      if (r.ok && r.status) {
        // Before the card turns clickable again: never the old groups.
        void qualityStatus.apply(r.status);
        return;
      }
      if (!r.ok) qualityOfferError = r.error ?? "Could not accept — try again.";
      await qualityStatus.refresh();
    } catch {
      qualityOfferError = "Could not accept — check the connection and try again.";
      void qualityStatus.refresh();
    } finally {
      qualityOfferActing = null;
    }
  }

  /** "Not now" — settle the offer with a status note; nothing runs (#685). */
  async function dismissQualityOffer(auditRunId: string): Promise<void> {
    if (qualityOfferActing !== null) return;
    qualityOfferActing = auditRunId;
    qualityOfferSettling = true;
    qualityOfferError = null;
    try {
      const r = await postQualityAction(session.id, csrfToken, { action: "dismiss", auditRunId });
      if (!r.ok) {
        qualityOfferError = r.error ?? "Could not dismiss — try again.";
      } else if (r.note) {
        messages = [
          ...messages,
          { id: `quality-${auditRunId}`, role: "user", origin: "system", content: r.note },
        ];
      }
    } catch {
      qualityOfferError = "Could not dismiss — check the connection and try again.";
    } finally {
      qualityOfferActing = null;
      qualityOfferSettling = false;
      void qualityStatus.refresh();
    }
  }

  async function retryQualityCheck(): Promise<void> {
    qualityRetryError = null;
    const r = await postQualityAction(session.id, csrfToken, { action: "retry" });
    if (!r.ok) qualityRetryError = r.error ?? "Could not start the quality check.";
    await qualityStatus.refresh();
  }

  // offer_choices click that landed while the AI was mid-stream —
  // flushed by the effect below, same contract as approval nudges.
  let pendingChoiceAnswer = $state<string | null>(null);

  $effect(() => {
    if (streaming) return;
    if (pendingChoiceAnswer === null) return;
    if (composer.trim().length > 0) return;
    const answer = pendingChoiceAnswer;
    pendingChoiceAnswer = null;
    void sendAutoMessage(answer);
  });

  $effect(() => {
    // Track `streaming` + `pendingApprovalNudges` reactively. Fires
    // when streaming transitions to false OR a new nudge is enqueued
    // while NOT streaming (the latter is handled by onProposalDecided's
    // inline path, but the effect is idempotent).
    if (streaming) return;
    if (pendingApprovalNudges.length === 0) return;
    // Don't clobber a message the operator is typing. Keep the queue
    // intact; flush on the next streaming-end transition (sendMessage
    // sets streaming=true → false again).
    if (composer.trim().length > 0) return;
    const nudges = pendingApprovalNudges;
    pendingApprovalNudges = [];
    // Issue #658 — the operator's decisions, so "operator": they continue the
    // AI even if another tab stopped the chat meanwhile (a Stop in THIS tab
    // empties the queue instead).
    void sendAutoMessage(nudges.map((n) => ownDecisionMessage(n)).join("\n"), "operator");
  });

  /**
   * v0.2.75 — Programmatic send for system-driven follow-ups (post-approval
   * continuation, crawl-completion nudge, queued choice answer) AND user
   * clicks on suggestion / choice chips.
   *
   * The send goes to the AI via sendMessage's `overrideText` path, which does
   * NOT touch the composer: whatever the operator has typed stays put. This is
   * the reported requirement — clicking a chip sends it to the AI and leaves
   * the draft in the field (an earlier version routed through the composer and
   * cleared the draft, which was the bug).
   *
   * @returns whether a turn started (see sendMessage).
   */
  async function sendAutoMessage(
    text: string,
    // Issue #664 — "operator" for a click the operator made (choice /
    // suggestion chip); "auto" for a nudge the panel sends on its own.
    trigger: "operator" | "auto" = "auto",
    onStarted?: () => void,
  ): Promise<boolean> {
    if (streaming) return false;
    if (!mayStartTurn(trigger, operatorStopped)) {
      noteHeldBack(text);
      return false;
    }
    // issue #303 — a nudge with nothing to say must not post: an empty
    // system-origin row renders as a bare "Status:" note (and the
    // append_message boundary now rejects it server-side too). Loud
    // console signal instead of a silent junk row.
    if (text.trim().length === 0) {
      console.error("[chat] sendAutoMessage called with empty text — nudge dropped");
      return false;
    }
    // issue #29 — every auto-message is system-driven. The model still sees
    // them as user turns, but they persist + render as muted status notes so
    // the operator isn't misled into thinking they typed them ("das kommt
    // nicht vom nutzer").
    return sendMessage("system", undefined, text, trigger === "operator", onStarted);
  }
  // Live counter of pending changes during streaming — incremented per
  // AI tool result + reset between turns. Drives the "N edits during
  // this turn" hint banner.
  let pendingChangeCount = $state(0);
  /** P6.7.3 — surface SSE error events + failed tool results so users
   *  see a banner instead of a silent no-op when the AI stack errors. */
  let chatError = $state<string | null>(null);
  // v0.5.9 — non-fatal warning channel. Surfaced as a subtle banner
  // (not destructive alert) so the operator sees observability hints
  // like "AI responded with text only" without it looking like a hard
  // error. Cleared on send.
  let chatWarning = $state<string | null>(null);
  // v0.5.9 — stalled-stream watchdog. Tracks when the last SSE event
  // arrived. While streaming, if >90s since the last event, surface a
  // banner so the operator knows the stream stalled instead of
  // waiting on a frozen spinner. Independent from server-side stream
  // termination guarantees — protects against TCP drops the server
  // cannot detect (browser tab suspend, network glitch, etc.).
  let lastEventAtMs = $state<number>(0);
  let streamStalled = $state<boolean>(false);
  // v0.5.20 — bumped 90s → 180s. The 90s threshold fired false-positives
  // on long multi-tool builds where the AI is sequentially dispatching
  // 5+ tool calls (each 20-30s of DB writes + snapshot emission) with
  // no streaming text between them. Server-side now also emits a
  // {kind:"heartbeat"} event every 30s so even a 5-minute tool burst
  // never trips the timer; 180s is the absolute fallback for genuinely
  // dropped connections.
  const STREAM_STALL_THRESHOLD_MS = 180_000;

  // Issue #658 — an external agent (MCP) works on this session concurrently
  // and queues proposals outside this panel's stream; poll the strip so its
  // cards (and the hand-back status after a decision) appear without a
  // reload. Paused while this chat streams — tool results refresh it then.
  const PENDING_POLL_MS = 10_000;
  $effect(() => {
    if (streaming) return;
    const id = setInterval(() => void loadPendingProposals(), PENDING_POLL_MS);
    return () => clearInterval(id);
  });
  $effect(() => {
    if (!streaming) {
      streamStalled = false;
      return;
    }
    const id = setInterval(() => {
      if (Date.now() - lastEventAtMs > STREAM_STALL_THRESHOLD_MS) {
        streamStalled = true;
      }
    }, 5000);
    return () => clearInterval(id);
  });

  // v0.5.20 — failed-only transcript filter. Hides successful tool-cards
  // so the operator can find what went wrong without scrolling 50
  // successful rows. User + assistant messages stay visible regardless
  // (they're context for the failures). Failure detection is content-
  // based: tool result text starting with "<op_name> failed:" or
  // "Tool call failed:" or containing "invalid arguments" /
  // "validation failed". Same heuristic as chat.summarize on the
  // server.
  let showFailedOnly = $state(false);
  function isFailedToolMessage(content: string): boolean {
    if (!content) return false;
    if (/^Tool call failed:/i.test(content)) return true;
    if (/^[a-z][a-z0-9_.]*\s+failed:/i.test(content)) return true;
    if (/^invalid arguments\b/i.test(content)) return true;
    if (/^validation failed\b/i.test(content)) return true;
    // v0.6.2 — `add_module_to_template` and similar fan-out tools return
    // ok=false when every per-page placement failed, but the SSE-side
    // `ok` flag is currently dropped at chat.append_message persistence
    // (proper fix: add `ok` column to chat_messages — tracked for
    // v0.6.3). Until then, recognize these shapes by content:
    //   "module <id> added to block "X" on 0 of <N> pages …\nfailed: …"
    //   "<op> ran with 0 of <N> …\nfailed: …"
    // Any content containing a `\nfailed: ` block with no "placed:"
    // companion is a total-failure summary.
    if (/\bon 0 of \d+\b/i.test(content)) return true;
    if (/\nfailed:/i.test(content) && !/\nplaced:/i.test(content)) return true;
    return false;
  }
  // v0.2.54 — local mirror of session.extendedThinkingEnabled for
  // optimistic toggle. The form action persists to chat_sessions; this
  // local mirror keeps the toggle responsive without a page reload.
  let extendedThinkingEnabled = $state<boolean>(
    session.extendedThinkingEnabled ?? false,
  );

  /**
   * v0.3.1 — Capture the preview iframe via html2canvas and upload
   * the image (JPEG since issue #262) to the screenshot endpoint, which resolves the
   * server-side `awaitScreenshot` Promise so the AI's
   * `screenshot_page` tool returns the image bytes.
   *
   * Source: `/edit/preview/<pageId>?branch=<chatBranchId>` — the same
   * composed page the live-edit overlay shows — fetched and rendered as
   * srcdoc in a `sandbox="allow-same-origin"` frame WITHOUT scripts
   * (#946): html2canvas can read the contentDocument, the page's own
   * scripts cannot run with the operator's session. Script-built DOM is
   * therefore not in this capture; the server-side backend (headless
   * Chromium, opaque origin) runs scripts.
   *
   * Failure paths: if the iframe doesn't load, html2canvas throws,
   * or the operator closed the tab during capture, we POST the
   * `errorMessage` field so the SSE-side rejects cleanly + the AI
   * can recover (per v0.2.52 tool-error path).
   */
  async function handleScreenshotRequest(req: {
    requestId: string;
    pageId: string;
    chatBranchId?: string;
    viewport: "desktop" | "tablet" | "mobile";
    width?: number;
    selector?: string;
    toolCallId?: string;
  }): Promise<void> {
    // Desktop captures at the operator's live preview size so the AI sees
    // the same line breaks the operator sees (see screenshot-viewport.ts).
    const { width, height, source } = resolveScreenshotViewport({
      viewport: req.viewport,
      ...(req.width !== undefined ? { width: req.width } : {}),
      livePreview: measureLivePreview(document),
    });

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-99999px";
    iframe.style.top = "-99999px";
    iframe.style.width = `${width}px`;
    iframe.style.height = `${height}px`;
    iframe.style.border = "0";
    iframe.style.visibility = "hidden";
    // #946 — the capture frame shares the admin origin (html2canvas must
    // read its DOM and paint same-origin media untainted), so it must
    // never run the page's scripts: `allow-same-origin` WITHOUT
    // `allow-scripts`. Never add `allow-scripts` here — together they would
    // hand the module scripts the operator's session.
    iframe.setAttribute("sandbox", "allow-same-origin");
    // The preview path needs the slug. We don't know it from
    // the SSE event (only pageId + chatBranchId), so use the
    // pages/preview pageId-based route which the editor iframe also
    // uses. Builds the right URL server-side based on pageId.
    const params = new URLSearchParams();
    if (req.chatBranchId) params.set("branch", req.chatBranchId);
    const previewSrc = `/edit/preview/${req.pageId}${params.size > 0 ? `?${params}` : ""}`;

    const uploadFailure = async (msg: string): Promise<void> => {
      try {
        await fetch(`/content/chat/${session.id}/screenshot/${req.requestId}`, {
          method: "POST",
          headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
          body: JSON.stringify({ errorMessage: msg }),
        });
      } catch {
        // best effort — server-side will time out at 30s anyway
      } finally {
        iframe.remove();
      }
    };

    try {
      // The preview document itself is served as an opaque-origin sandbox
      // (CSP), which html2canvas could not read; its HTML is rendered
      // here as srcdoc instead, under the script-less sandbox above.
      const preview = await fetch(previewSrc);
      if (!preview.ok) {
        await uploadFailure(`preview render failed (HTTP ${preview.status})`);
        return;
      }
      iframe.srcdoc = await preview.text();
      // Wait for iframe load (or timeout). Capture happens on the
      // load event so html2canvas sees the rendered DOM.
      await new Promise<void>((resolve, reject) => {
        const onLoad = (): void => {
          iframe.removeEventListener("load", onLoad);
          resolve();
        };
        iframe.addEventListener("load", onLoad);
        document.body.appendChild(iframe);
        setTimeout(() => reject(new Error("iframe load timeout (10s)")), 10_000);
      });

      const doc = iframe.contentDocument;
      if (!doc) {
        await uploadFailure("iframe contentDocument is null (cross-origin?)");
        return;
      }
      // Dynamic import keeps html2canvas out of the main bundle —
      // only loaded when the AI actually requests a screenshot.
      // issue #250 (WS4) — selector-scoped capture: shoot one element
      // instead of the page. Loud failure when nothing matches.
      let captureTarget: HTMLElement = doc.body;
      if (req.selector) {
        const el = doc.querySelector(req.selector);
        if (el === null) {
          await uploadFailure(`selector matched nothing in the rendered page: ${req.selector}`);
          return;
        }
        captureTarget = el as HTMLElement;
        // Bring the element into view so html2canvas frames IT — an element
        // far down the page (a footer at y≈3500) otherwise renders as the top
        // viewport crop.
        captureTarget.scrollIntoView?.();
      }
      // html2canvas-pro: maintained fork with modern CSS color support
      // (color-mix(), oklch, color()) — the original html2canvas parser
      // threw "unsupported color function" on AI-authored module CSS and
      // spiralled live-edit run A2 into its max_loops cap.
      const { default: html2canvas } = await import("html2canvas-pro");
      const canvas = await html2canvas(captureTarget, {
        ...(req.selector
          ? {}
          : { width, height, windowWidth: width, windowHeight: height }),
        scale: 1,
        // useCORS lets the canvas pull in cross-origin images
        // (CDN media). foreignObjectRendering=false avoids a
        // Chromium quirk where SVGs in foreignObject fail to taint
        // the canvas — important for read-back.
        useCORS: true,
        foreignObjectRendering: false,
        logging: false,
      });
      // toBlob → base64 (raw, no data: prefix — the upload endpoint
      // expects bare base64). JPEG at quality 0.85, NOT PNG: a
      // full-viewport PNG of a real page runs 0.8-1.1 MB, which blows
      // through the adapter's default BODY_SIZE_LIMIT (512K) —
      // the server answers 413 before SvelteKit sees the request, the
      // AI's screenshot tool times out, and the operator gets a red
      // console error (run #9 CI, issue #262). JPEG is 5-10x smaller
      // with no cost to the vision-model verdict; html2canvas paints
      // on an opaque white background so the alpha loss is moot.
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85),
      );
      if (!blob) {
        await uploadFailure("canvas.toBlob returned null");
        return;
      }
      const arrayBuffer = await blob.arrayBuffer();
      // Convert ArrayBuffer → base64 in chunks to avoid hitting
      // the call-stack limit for large images.
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(
          ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
        );
      }
      const base64 = btoa(binary);

      // SHOT-1: stash the operator's OWN capture into toolImages by toolCallId
      // so the screenshot card shows THIS image immediately — no dependence on
      // the ~1 MB image being echoed back over SSE. (The upload below still
      // runs so the AI gets its copy via the tool result.)
      if (req.toolCallId) {
        toolImages = new Map(toolImages).set(req.toolCallId, {
          base64,
          mediaType: "image/jpeg",
        });
      }

      // Capture geometry rides along so the tool result can state
      // crop-vs-full-page as a FACT (run B4: the model doubted a
      // selector crop and nothing could confirm it after the fact). The
      // viewport size + its source tell the AI whether it saw the
      // operator's own view or a preset width.
      const meta = {
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        pageWidth: doc.body.scrollWidth,
        pageHeight: doc.body.scrollHeight,
        viewportWidth: width,
        viewportHeight: height,
        viewportSource: source,
      };
      const res = await fetch(`/content/chat/${session.id}/screenshot/${req.requestId}`, {
        method: "POST",
        headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ base64, mediaType: "image/jpeg", meta }),
      });
      if (!res.ok) {
        // Best-effort: log + continue. The server-side awaitScreenshot
        // will time out and the AI's tool result becomes a clean
        // failure.
        // biome-ignore lint/suspicious/noConsole: visibility for diagnosis
        console.warn("[chat screenshot] upload failed", res.status);
      }
    } catch (e) {
      await uploadFailure((e as Error).message ?? "unknown capture error");
    } finally {
      iframe.remove();
    }
  }

  /**
   * v0.2.54 — flip extended thinking on/off via the page-server action.
   * Optimistic UI: toggle the local mirror first, fire the POST, revert
   * if the server rejects. SvelteKit form actions accept JSON-style
   * application/x-www-form-urlencoded bodies on the action URL.
   */
  async function toggleExtendedThinking(): Promise<void> {
    const next = !extendedThinkingEnabled;
    extendedThinkingEnabled = next;
    try {
      const fd = new FormData();
      fd.set("_csrf", csrfToken);
      fd.set("enabled", next ? "1" : "0");
      const res = await fetch("?/set_extended_thinking", {
        method: "POST",
        body: fd,
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        extendedThinkingEnabled = !next;
        chatError = `Could not ${next ? "enable" : "disable"} extended thinking.`;
      }
    } catch (e) {
      extendedThinkingEnabled = !next;
      chatError = `Toggle failed: ${(e as Error).message ?? "unknown"}`;
    }
  }
  // Pinned chips (from session.pinnedElements) ride every send; transient
  // chips (dropdown picks, iframe element-clicks) are sent once and cleared.
  let chips = $state<Chip[]>(
    (session.pinnedElements ?? []).map((p) => ({
      moduleId: p.moduleId,
      selector: p.selector,
      label: p.label,
      pinned: true,
    })),
  );
  let proposedDiffs = $state<ProposedDiff[]>([]);
  let pickedModuleId = $state("");

  /** v0.2.46 — `tool-start` events carry the tool name + arguments;
   *  `tool-result` only carries the toolCallId + content. Bridge them
   *  via this map so synthetic tool messages appended to the transcript
   *  on tool-result can be routed by name in ToolCardRouter. */
  const toolCallMeta = new Map<string, { name: string; args: Record<string, unknown> }>();

  /** Part 2 — screenshots captured by image-returning tools ride on the
   *  `tool-result` SSE event's `image` field. Bridge them to the tool card
   *  by toolCallId so ScreenshotCard can render a live preview. LIVE for the
   *  session only — never persisted, so a reloaded transcript has no entry
   *  here and the card falls back to text-only. Reassigned (not mutated) so
   *  Svelte picks up the change in the transcript render. */
  let toolImages = $state<Map<string, { base64: string; mediaType: string }>>(new Map());

  // v0.2.46 — debug state captured from the SSE stream when `debug=true`.
  // Populated alongside the regular event handling; the panel reads it.
  let debugToolCalls = $state<DebugToolCall[]>([]);
  let debugUsage = $state<DebugUsage>({
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cost: 0,
  });
  let debugRawEvents = $state<unknown[]>([]);

  // v0.2.47 — composer affordances. Slash menu (tool hints) + @-mention
  // (module references) + drag-drop media upload.
  type MentionKind = "slash" | "at" | null;
  let mentionKind = $state<MentionKind>(null);
  // Caret position where the trigger char (`/` or `@`) sits — used to
  // replace from there through the current caret on selection.
  let mentionAnchor = $state(0);
  // Filter string typed after the trigger char (lowercase).
  let mentionQuery = $state("");
  // Selected index into the suggestion list; arrow-key navigation
  // updates this.
  let mentionIndex = $state(0);
  // Drag-over highlight on the composer surface.
  let dragOver = $state(false);
  // Inline upload error state — shown briefly under the composer.
  let uploadError = $state<string | null>(null);
  /** issue #190 — images attached to the NEXT message (chips above the
   *  composer). Uploaded immediately on drop; sent as attachment refs. */
  let pendingAttachments = $state<{ assetId: string; mime: string; alt: string }[]>([]);
  const MAX_PENDING_ATTACHMENTS = CHAT_MAX_ATTACHMENTS;
  let uploadingImages = $state(false);
  let imageInput: HTMLInputElement | undefined = $state();

  /** Hardcoded tool hints for the slash menu. Not the full 80-tool
   *  catalogue — that would overwhelm the popup. The list covers the
   *  most-frequent operator intents; the AI will pick the actual tool
   *  based on the natural-language phrasing the operator types after. */
  const SLASH_HINTS: { label: string; insert: string; description: string }[] = [
    { label: "/edit", insert: "Edit the ", description: "edit a module's HTML/CSS/JS" },
    { label: "/create-page", insert: "Create a new page called ", description: "new page from scratch" },
    { label: "/rename", insert: "Rename ", description: "rename a page or update slug" },
    { label: "/seo", insert: "Optimize the SEO for ", description: "rewrite meta description" },
    { label: "/redirect", insert: "Add a redirect from ", description: "create a 301 redirect" },
    { label: "/delete", insert: "Delete ", description: "remove a page or module" },
    { label: "/publish", insert: "Publish the staged changes", description: "merge chat branch to main" },
    { label: "/revert", insert: "Revert ", description: "undo a recent change via snapshot" },
    { label: "/invite", insert: "Invite a new user: ", description: "propose a user invitation" },
  ];

  // Filtered suggestion list driven by mentionKind + mentionQuery.
  const slashSuggestions = $derived(
    mentionKind === "slash"
      ? SLASH_HINTS.filter((h) =>
          h.label.slice(1).toLowerCase().startsWith(mentionQuery.toLowerCase()),
        ).slice(0, 8)
      : [],
  );
  const atSuggestions = $derived(
    mentionKind === "at"
      ? modules
          .filter((m) =>
            (m.slug.toLowerCase() + " " + m.displayName.toLowerCase()).includes(
              mentionQuery.toLowerCase(),
            ),
          )
          .slice(0, 8)
      : [],
  );

  function closeMention(): void {
    mentionKind = null;
    mentionQuery = "";
    mentionIndex = 0;
  }

  /** Detect a fresh trigger near the caret and open the mention popup.
   *  Triggered from oninput. The pattern: trigger char appears at
   *  position 0 OR after a whitespace; query is the run of word chars
   *  between the trigger and the caret. */
  function detectMention(): void {
    const el = composerEl;
    if (!el) return;
    const caret = el.selectionStart;
    const text = composer.slice(0, caret);
    // Walk back to find the most recent / or @ that isn't preceded by
    // a non-whitespace char.
    const m = text.match(/(?:^|\s)([/@])([\w-]*)$/);
    if (!m) {
      closeMention();
      return;
    }
    const trigger = m[1];
    const query = m[2] ?? "";
    mentionKind = trigger === "/" ? "slash" : "at";
    mentionAnchor = caret - query.length - 1; // position of the trigger char
    mentionQuery = query;
    mentionIndex = 0;
  }

  function applyMention(replacement: string): void {
    const el = composerEl;
    if (!el) return;
    const caret = el.selectionStart;
    composer = composer.slice(0, mentionAnchor) + replacement + composer.slice(caret);
    closeMention();
    queueMicrotask(() => {
      el.focus();
      const pos = mentionAnchor + replacement.length;
      el.setSelectionRange(pos, pos);
      autoSizeComposer();
    });
  }

  function selectMention(): void {
    if (mentionKind === "slash") {
      const hit = slashSuggestions[mentionIndex];
      if (hit) applyMention(hit.insert);
    } else if (mentionKind === "at") {
      const hit = atSuggestions[mentionIndex];
      if (hit) applyMention(`@module:${hit.slug} `);
    }
  }

  /**
   * Reloaded transcripts: chat_messages tool rows don't persist the
   * tool NAME (only tool_call_id); live streaming knows it, a page
   * reload doesn't — the collapsed cards then read "unknown". Resolve
   * it from the assistant message that issued the call.
   */
  function toolNameFromHistory(m: ChatMessage): string | null {
    if (!m.toolCallId) return null;
    for (const candidate of messages) {
      if (candidate.role !== "assistant" || !Array.isArray(candidate.toolCalls)) continue;
      const hit = (candidate.toolCalls as { id?: string; name?: string }[]).find(
        (c) => c?.id === m.toolCallId && typeof c?.name === "string",
      );
      if (hit?.name) return hit.name;
    }
    return null;
  }

  function onComposerKeydown(e: KeyboardEvent): void {
    // Standard chat-UI send semantics (operator request): Enter sends,
    // Shift+Enter / Option+Enter insert a newline. IME composition
    // (Japanese/Chinese input confirming a candidate with Enter) must
    // never send. When the mention popup is open, Enter selects the
    // suggestion instead (handled below).
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing && mentionKind === null) {
      e.preventDefault();
      void sendMessage();
      return;
    }
    if (mentionKind === null) return;
    const list = mentionKind === "slash" ? slashSuggestions : atSuggestions;
    if (list.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      mentionIndex = (mentionIndex + 1) % list.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      mentionIndex = (mentionIndex - 1 + list.length) % list.length;
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      selectMention();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
    }
  }

  /** Picker, clipboard and drop all use the same bounded media-library upload. */
  const ATTACHABLE_MIMES = new Set<string>(CHAT_IMAGE_MIMES);
  async function attachImages(files: File[]): Promise<void> {
    if (!files.length) return;
    if (uploadingImages) {
      uploadError = "Please wait for the current upload to finish.";
      return;
    }
    uploadingImages = true;
    uploadError = null;
    const errors: string[] = [];
    const uploadSession = session.id;
    try {
      for (const file of files) {
        if (pendingAttachments.length >= MAX_PENDING_ATTACHMENTS) {
          errors.push(`Max ${MAX_PENDING_ATTACHMENTS} images per message.`);
          break;
        }
        if (!ATTACHABLE_MIMES.has(file.type)) {
          errors.push(`"${file.name}": choose PNG, JPEG, WebP or GIF.`);
          continue;
        }
        if (!file.size || file.size > CHAT_MAX_ATTACHMENT_BYTES) {
          errors.push(`"${file.name}": choose a non-empty image up to 5 MiB.`);
          continue;
        }
        const fd = new FormData();
        fd.append("file", file);
        try {
          const res = await fetch("/api/chat/images", {
            method: "POST", headers: { "x-csrf-token": csrfToken }, body: fd,
          });
          if (!res.ok) {
            errors.push(`"${file.name}": upload failed (${res.status}). Please retry.`);
            continue;
          }
          const v = (await res.json()) as { assetId?: string; mime?: string };
          if (!v.assetId || !v.mime || !ATTACHABLE_MIMES.has(v.mime)) {
            errors.push(`"${file.name}": upload returned no usable image.`);
            continue;
          }
          // The media library deduplicates identical bytes; keep keyed chips unique too.
          if (session.id !== uploadSession) return;
          if (!pendingAttachments.some(a => a.assetId === v.assetId)) {
            pendingAttachments = [...pendingAttachments, { assetId: v.assetId, mime: v.mime, alt: file.name }];
          }
        } catch (err) {
          errors.push(`"${file.name}": upload failed. ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      uploadingImages = false;
      if (errors.length) uploadError = errors.join(" ");
    }
  }

  function onComposerDrop(e: DragEvent): void {
    e.preventDefault();
    dragOver = false;
    void attachImages([...(e.dataTransfer?.files ?? [])]);
  }

  function onComposerPaste(e: ClipboardEvent): void {
    const files = [...(e.clipboardData?.files ?? [])].filter(file => file.type.startsWith("image/"));
    if (!files.length) return; // Preserve ordinary text paste.
    e.preventDefault();
    void attachImages(files);
  }

  const moduleStateBefore: Record<string, string> = {};
  for (const m of modules) {
    if (typeof m.html === "string") moduleStateBefore[m.id] = m.html;
  }

  function addChipFromDropdown(): void {
    if (!pickedModuleId) return;
    const m = modules.find((x) => x.id === pickedModuleId);
    if (!m) return;
    chips = [
      ...chips,
      { moduleId: m.id, selector: "", label: `${m.slug} — ${m.displayName}` },
    ];
    pickedModuleId = "";
  }

  function removeChip(idx: number): void {
    const removed = chips[idx];
    chips = chips.filter((_, i) => i !== idx);
    if (removed?.pinned) void persistPinned();
    // v0.2.45 bug fix — keep focus in the composer after a chip click so
    // the operator can keep typing without re-clicking the textarea.
    queueMicrotask(() => composerEl?.focus());
  }

  /**
   * Toggle the pinned flag on a chip. Pinned chips persist on the chat
   * session row and re-emit on every send within that chat. Pinning is a
   * UI affordance — the AI never reaches into pinned_elements.
   */
  async function togglePin(idx: number): Promise<void> {
    const c = chips[idx];
    if (!c) return;
    chips = chips.map((x, i) => (i === idx ? { ...x, pinned: !x.pinned } : x));
    await persistPinned();
    queueMicrotask(() => composerEl?.focus());
  }

  async function persistPinned(): Promise<void> {
    // A pin keeps the module + element reference across messages; the
    // selected text belongs to the message it was picked for.
    const pinned = chips
      .filter((c) => c.pinned)
      .map((c) => ({ moduleId: c.moduleId, selector: c.selector, label: c.label }));
    try {
      await fetch("/edit/pinned", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ chatSessionId: session.id, pinnedElements: pinned }),
      });
    } catch {
      // best-effort
    }
  }

  /**
   * iframe → ChatPanel: a `caelo:chip` window CustomEvent (dispatched by
   * /edit/+page.svelte's postMessage handler) appends a new chip referring
   * to the clicked module. Append-only — multiple clicks accumulate so the
   * user can select N elements then send "make them all green" in one turn.
   *
   * Ask AI (`ask: true`) only adds the chip and focuses the composer; the
   * operator types the instruction here and sends it with their own
   * Enter / Send. Why not take the instruction from the preview and send
   * it: the event originates in the preview iframe, which runs the site's
   * module scripts (modules keep <script>, the preview has no CSP), so any
   * of them can post the same message. A preview message must never make
   * the AI act — at most it points at an element. The send stays one
   * action for the operator, in the editor's own trusted UI.
   */
  onMount(() => {
    // Hydration gate — see the composer's `disabled` binding.
    hydrated = true;
    // v0.2.63 — initial fetch of pending proposals scoped to this
    // chat. Subsequent refreshes are triggered by tool-result events
    // (the runner just queued or executed something).
    void loadPendingProposals();
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as (Chip & { ask?: boolean }) | undefined;
      if (!detail || typeof detail.moduleId !== "string") return;
      const { ask, ...chip } = detail;
      // De-dupe: don't add a chip already present (pinned or not).
      const present = chips.some(
        (c) =>
          c.moduleId === chip.moduleId &&
          c.selector === chip.selector &&
          c.selectedText === chip.selectedText,
      );
      if (!present) chips = [...chips, chip];
      if (ask === true) composerEl?.focus();
    };
    window.addEventListener("caelo:chip", handler);

    // P7 review-pass — Cmd+M in /edit's overlay opens the MediaPicker;
    // the picker dispatches `caelo:insert-into-composer` with an
    // <img src="..."> snippet that we paste at the textarea caret.
    const composerInsertHandler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { text?: string } | undefined;
      const text = detail?.text;
      if (typeof text !== "string" || text.length === 0) return;
      const el = composerEl;
      if (!el) {
        composer = composer + (composer.length > 0 ? "\n" : "") + text;
        return;
      }
      const start = el.selectionStart;
      const end = el.selectionEnd;
      composer = composer.slice(0, start) + text + composer.slice(end);
      queueMicrotask(() => {
        el.focus();
        const pos = start + text.length;
        el.setSelectionRange(pos, pos);
        autoSizeComposer();
      });
    };
    document.addEventListener("caelo:insert-into-composer", composerInsertHandler);

    return () => {
      window.removeEventListener("caelo:chip", handler);
      document.removeEventListener("caelo:insert-into-composer", composerInsertHandler);
    };
  });

  /**
   * Issue #664 — Stop the AI in this chat, authoritatively. The server-side
   * Stop (chat.cancel_agents) is what actually ends the work: the running
   * turn on whichever instance runs it, the turns queued behind it, its
   * subagents, external agents working here. Aborting our own fetch only
   * ends this tab's view of the stream. Every auto message this panel was
   * holding back is dropped (shown as a note) and the latch keeps new ones
   * from starting the AI until the operator sends something themselves.
   */
  async function stopStreaming(): Promise<void> {
    operatorStopped = true;
    stopGeneration += 1;
    stopError = null;
    const held: string[] = [];
    if (pendingApprovalNudges.length > 0) {
      held.push(pendingApprovalNudges.map((n) => ownDecisionMessage(n)).join(" "));
      pendingApprovalNudges = [];
    }
    if (pendingChoiceAnswer !== null) {
      held.push(pendingChoiceAnswer);
      pendingChoiceAnswer = null;
    }
    if (pendingImportNudge !== null) {
      held.push(pendingImportNudge);
      pendingImportNudge = null;
    }
    for (const text of held) noteHeldBack(text);
    streamAbort?.abort();
    stopError = await postAgentAction({ csrfToken, chatSessionId: session.id, action: "cancel" });
  }

  /** Show an auto message Stop held back, instead of sending it. */
  function noteHeldBack(text: string): void {
    noteLocally(heldBackNote(text));
  }

  /**
   * A status note in this tab's transcript only — never sent to the AI nor
   * persisted, so the chat's AI can never read it as an instruction (issue
   * #658: decisions on an external agent's requests).
   */
  function noteLocally(text: string): void {
    messages = [
      ...messages,
      {
        id: `note-${crypto.randomUUID()}`,
        role: "user",
        origin: "system",
        content: text,
      },
    ];
  }

  async function sendMessage(
    origin?: "system",
    // Plan B (SDK approval gate) — when set, this is NOT a composer send but a
    // resume of a paused gated turn with the Owner's in-chat Approve/Reject.
    // The optimistic user message + composer handling are skipped; the body
    // carries `resumeApproval` instead of content.
    resume?: { approvalId: string; approved: boolean },
    // A system nudge / suggestion-chip send whose text goes to the AI WITHOUT
    // passing through the composer: the operator's in-progress draft (text,
    // chips, attachments) stays exactly as-is. Set by sendAutoMessage. This is
    // why clicking a chip sends AND leaves your typed text untouched.
    overrideText?: string,
    // Issue #664 — a system-origin send the operator clicked (chip): it lifts
    // the Stop latch like a typed message does.
    operatorClicked = false,
    // Issue #685 — called once, as soon as the turn has demonstrably started
    // (not when it ends: a fix turn runs for minutes).
    onStarted?: () => void,
  ): Promise<boolean> {
    if (streaming || (uploadingImages && !resume && overrideText === undefined)) return false;
    if (
      !resume &&
      overrideText === undefined &&
      composer.trim().length === 0 &&
      pendingAttachments.length === 0
    )
      return false;
    const isOverride = overrideText !== undefined;
    const byOperator = origin !== "system" || operatorClicked || resume !== undefined;
    if (!mayStartTurn(byOperator ? "operator" : "auto", operatorStopped)) return false;
    if (byOperator) operatorStopped = false;
    // Attachment-only sends get a minimal text body (the op requires
    // non-empty content; the images carry the actual intent).
    const text = overrideText ?? (composer.trim().length > 0 ? composer : "(see attached image)");
    // An override rides NONE of the operator's draft — the click sends its own
    // text and consumes neither the pending chips nor the attachments.
    const sentChips = isOverride ? [] : chips;
    const sentAttachments = isOverride ? [] : pendingAttachments;
    chatError = null;
    chatWarning = null;
    streamStalled = false;
    lastEventAtMs = Date.now();
    streaming = true;
    streamingText = "";
    streamingThinkingText = "";
    currentActivity = resume ? "Applying…" : "Sending…";
    const optimisticMessageId = `local-${crypto.randomUUID()}`;
    if (!resume) {
      // An override must NOT disturb the operator's draft — only a real
      // composer send clears the field + consumes pending chips/attachments.
      if (!isOverride) {
        pendingAttachments = [];
        composer = "";
        // Pinned chips ride every send; transient chips clear after.
        chips = chips.filter((c) => c.pinned);
        // Snap the composer back to one row after clearing it.
        queueMicrotask(autoSizeComposer);
      }
      messages = [
        ...messages,
        {
          id: optimisticMessageId,
          role: "user",
          content: text,
          ...(!isOverride && previewSelection ? { previewSelection } : {}),
          // issue #29 — auto-injected nudges render as muted status notes,
          // not "You:". Optimistically mark them so the operator never sees
          // the message flash as their own before the reload confirms it.
          ...(origin ? { origin } : {}),
          ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}),
        },
      ];
    }
    const ac = new AbortController();
    streamAbort = ac;
    let res: Response;
    try {
      res = await fetch(`/content/chat/${session.id}/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        signal: ac.signal,
        body: JSON.stringify(
          resume
            ? { resumeApproval: resume }
            : {
                content: text,
                chips: sentChips,
                ...(!isOverride && previewSelection ? { previewSelection } : {}),
                // issue #29 — provenance so the persisted row + reload keep the
                // system-origin status treatment durable across refresh.
                ...(origin ? { origin } : {}),
                // Issue #664 — a clicked chip is the operator's own action:
                // the server lets it lift the chat's Stop latch.
                ...(origin && operatorClicked ? { trigger: "operator" } : {}),
                ...(sentAttachments.length > 0
                  ? {
                      attachments: sentAttachments.map((a) => ({
                        assetId: a.assetId,
                        mime: a.mime,
                        alt: a.alt,
                      })),
                    }
                  : {}),
                ...(activePageId ? { activePageId } : {}),
              },
        ),
      });
    } catch (e) {
      // A user-initiated Stop aborts the fetch before the body opens — clean up
      // quietly. Anything else is a real network failure worth surfacing.
      streaming = false;
      streamAbort = null;
      currentActivity = null;
      if (!(ac.signal.aborted || (e instanceof Error && e.name === "AbortError"))) {
        chatError = `Chat request failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      return false;
    }
    if (!res.ok) {
      streaming = false;
      streamAbort = null;
      currentActivity = null;
      chatError = `Chat request failed (${res.status}). Your draft is ready to retry.`;
      if (!resume && !isOverride) {
        composer = text === "(see attached image)" ? "" : text;
        chips = sentChips;
        pendingAttachments = sentAttachments;
        messages = messages.filter(m => m.id !== optimisticMessageId);
      }
      return false;
    }
    if (!res.body) {
      streaming = false;
      streamAbort = null;
      currentActivity = null;
      // v0.2.45 — surface a clear error instead of silently dropping the
      // optimistic user message. The fetch reached the server but no body
      // came back; usually means the route returned a non-stream error.
      chatError = `Chat request returned no body (status ${res.status}). The server may be misconfigured — try again, or look the request up under Settings (/settings → Look up a request).`;
      return false;
    }
    // Issue #685 — did the turn start? Only positive evidence counts: model
    // output, a tool call, or a usage report. A turn the server refuses
    // before it runs (an external agent works here, a Stop it waited
    // behind) answers only an error or a "turn-dropped" warning, and one
    // stopped while it waited answers nothing at all.
    let turnStarted = false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (e) {
        // Stop button aborted the stream mid-flight — exit gracefully. The
        // server sees the same abort via request.signal, stops the runner and
        // persists the in-flight turn as interrupted; the partial text we have
        // is flushed into the transcript by the guard below.
        if (ac.signal.aborted || (e instanceof Error && e.name === "AbortError")) break;
        throw e;
      }
      const { value, done } = chunk;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (line.startsWith("data: ")) {
          try {
            const ev = JSON.parse(line.slice(6)) as Record<string, unknown>;
            // v0.5.9 — reset the stall-watchdog timer on every SSE
            // event. Any event keeps the watchdog quiet; only true
            // silence trips it.
            lastEventAtMs = Date.now();
            streamStalled = false;
            // v0.2.46 — record raw events + roll up tool calls / usage
            // for the debug panel. No-op when debug=false.
            // v0.2.55 — also mirror to console so operators can copy a
            // chat trace from devtools without opening the panel.
            if (debug) {
              // biome-ignore lint/suspicious/noConsole: gated by debug flag
              console.log("[chat sse]", ev);
              debugRawEvents = [...debugRawEvents, ev];
              if (ev["kind"] === "tool-start") {
                debugToolCalls = [
                  ...debugToolCalls,
                  {
                    toolCallId: String(ev["toolCallId"] ?? ""),
                    name: String(ev["name"] ?? ""),
                    args: (ev["arguments"] as Record<string, unknown>) ?? {},
                    startedAt: Date.now(),
                  },
                ];
              } else if (ev["kind"] === "tool-result") {
                const id = String(ev["toolCallId"] ?? "");
                debugToolCalls = debugToolCalls.map((tc) =>
                  tc.toolCallId === id
                    ? {
                        ...tc,
                        result: { ok: !!ev["ok"], content: String(ev["content"] ?? "") },
                        endedAt: Date.now(),
                      }
                    : tc,
                );
              } else if (ev["kind"] === "usage") {
                debugUsage = {
                  inputTokens: debugUsage.inputTokens + Number(ev["inputTokens"] ?? 0),
                  outputTokens: debugUsage.outputTokens + Number(ev["outputTokens"] ?? 0),
                  cachedTokens: debugUsage.cachedTokens + Number(ev["cachedTokens"] ?? 0),
                  cost: debugUsage.cost + Number(ev["cost"] ?? 0),
                };
              }
            }
            // v0.2.60 — live activity pill. Updated on every SSE
            // event so the operator sees moving status between bursts
            // of streaming text + tool-card landings. The set of
            // labels intentionally maps to ONE per event kind so the
            // pill changes visibly as the runner progresses.
            if (ev["kind"] === "text-delta") {
              currentActivity = "Writing…";
            } else if (ev["kind"] === "thinking-delta") {
              currentActivity = "Thinking…";
            } else if (ev["kind"] === "tool-start") {
              currentActivity = `Calling ${String(ev["name"] ?? "tool")}…`;
            } else if (ev["kind"] === "tool-approval-request") {
              // Plan B (SDK approval gate) — the turn paused on a gated tool.
              // Surface an inline Approve/Reject card; the turn stays paused
              // (server stopped at awaiting_approval) until the operator
              // decides via resolveSdkApproval → resume.
              const approvalId = String(ev["approvalId"] ?? "");
              if (approvalId && !sdkApprovals.some((a) => a.approvalId === approvalId)) {
                sdkApprovals = [
                  ...sdkApprovals,
                  {
                    approvalId,
                    name: String(ev["name"] ?? "action"),
                    preview: String(ev["preview"] ?? ""),
                    requiredPermissions: Array.isArray(ev["requiredPermissions"])
                      ? (ev["requiredPermissions"] as unknown[]).map(String)
                      : [],
                    // This tab's own stream: the chat's own AI asked.
                    requestedVia: null,
                  },
                ];
              }
              currentActivity = "Waiting for your approval…";
            } else if (ev["kind"] === "tool-result") {
              const okFlag = ev["ok"] === true;
              const meta = toolCallMeta.get(String(ev["toolCallId"] ?? ""));
              const name = meta?.name ?? "tool";
              currentActivity = okFlag ? `${name} ok — continuing…` : `${name} failed`;
              // v0.2.63 — refresh the pending strip when a propose_*
              // tool succeeds (new row queued) OR when an
              // execute_proposal succeeds (row marked applied → drops
              // out of the strip's filter).
              // v0.5.11 — also refresh when the tool's content matches
              // the canonical "Queued proposal <uuid>:" shape. Catches
              // propose-style tools that don't carry the propose_ name
              // prefix (create_layout, tune_rate_limit, bootstrap-site).
              const resultContent = String(ev["content"] ?? "");
              // v0.5.13 — optimistic push. Before the async
              // loadPendingProposals fetch returns, parse the
              // canonical content shape locally and push the new
              // proposal into pendingProposals immediately so the
              // sticky strip updates THIS frame. De-dup by proposalId
              // so the eventual async refresh doesn't flash a
              // duplicate row. Replaces the "I had to reload /edit
              // before the Approve button appeared" gap.
              const parsedProposal = okFlag ? parseProposalContent(resultContent) : null;
              if (parsedProposal) {
                if (
                  !pendingProposals.some((p) => p.proposalId === parsedProposal.proposalId)
                ) {
                  pendingProposals = [
                    ...pendingProposals,
                    {
                      proposalId: parsedProposal.proposalId,
                      domain: parsedProposal.domain,
                      kind: name,
                      summary: parsedProposal.summary,
                      proposedAt: new Date().toISOString(),
                      queueUrl: parsedProposal.queueUrl,
                    },
                  ];
                }
              }
              if (
                okFlag &&
                (name.startsWith("propose_") ||
                  name.endsWith(".execute_proposal") ||
                  parsedProposal !== null)
              ) {
                void loadPendingProposals();
              }
            } else if (ev["kind"] === "tool-result-cached") {
              currentActivity = "Re-using cached result…";
            } else if (ev["kind"] === "request-screenshot") {
              // v0.3.1 — AI's screenshot_page tool asked the
              // operator's browser to capture the preview iframe.
              // Fire-and-forget; the capture + upload continues in
              // the background. The next provider call will see the
              // captured image attached as a multimodal user message.
              currentActivity = "Capturing screenshot…";
              void handleScreenshotRequest({
                requestId: String(ev["requestId"] ?? ""),
                pageId: String(ev["pageId"] ?? ""),
                chatBranchId: typeof ev["chatBranchId"] === "string" ? ev["chatBranchId"] : undefined,
                viewport: (ev["viewport"] as "desktop" | "tablet" | "mobile" | undefined) ?? "desktop",
                width: typeof ev["width"] === "number" ? ev["width"] : undefined,
                // Forward the CSS selector so an element-scoped capture frames
                // that element — without this it silently fell back to the full
                // body and cropped a footer to the top viewport.
                selector: typeof ev["selector"] === "string" ? ev["selector"] : undefined,
                // Tag with the tool-call id so the captured bytes land in
                // toolImages and the card shows this exact capture immediately.
                toolCallId: typeof ev["toolCallId"] === "string" ? ev["toolCallId"] : undefined,
              });
            } else if (ev["kind"] === "assistant-message-saved") {
              currentActivity = "Continuing…";
            } else if (ev["kind"] === "usage") {
              // Keep the prior activity pill visible; hand the canonical spend
              // figure up so a readout can stay current.
              const spend = ev["spend7dMicrocents"];
              if (typeof spend === "number") onSpendUpdate?.(spend);
            }
            if (
              ev["kind"] === "text-delta" ||
              ev["kind"] === "thinking-delta" ||
              ev["kind"] === "tool-start" ||
              ev["kind"] === "usage" ||
              ev["kind"] === "assistant-message-saved"
            ) {
              if (!turnStarted) {
                turnStarted = true;
                onStarted?.();
              }
            }
            if (ev["kind"] === "error") {
              chatError = typeof ev["message"] === "string" ? ev["message"] : "Chat failed.";
            } else if (ev["kind"] === "warning") {
              // v0.5.9 — non-fatal observability hint (e.g.
              // passive-response). Distinct from chatError so the
              // banner renders as informational, not destructive.
              chatWarning = typeof ev["message"] === "string" ? ev["message"] : "Notice";
            } else if (ev["kind"] === "tool-result" && ev["ok"] === false) {
              const toolCallId = String(ev["toolCallId"] ?? "");
              const meta = toolCallMeta.get(toolCallId);
              chatError = `Tool call failed: ${String(ev["content"] ?? "unknown error")}`;
              // v0.2.46 — also append a failed tool-card message so the
              // transcript shows the failure inline, not just in the banner.
              messages = [
                ...messages,
                {
                  id: `local-t-${toolCallId || Date.now()}`,
                  role: "tool",
                  content: String(ev["content"] ?? ""),
                  toolName: meta?.name ?? "unknown",
                  toolArgs: meta?.args ?? {},
                },
              ];
            } else if (ev["kind"] === "thinking-delta") {
              // v0.2.54 — extended thinking stream. Accumulates the
              // model's reasoning text into the collapsed thinking
              // block above the streaming assistant bubble.
              streamingThinkingText += String(ev["text"] ?? "");
            } else if (ev["kind"] === "thinking-stop") {
              // No-op on the client; the runner persists the block
              // server-side. Final text is already in
              // streamingThinkingText.
            } else if (ev["kind"] === "text-delta") streamingText += String(ev["text"] ?? "");
            else if (ev["kind"] === "tool-result" && ev["ok"]) {
              pendingChangeCount += 1;
              const toolCallId = String(ev["toolCallId"] ?? "");
              const meta = toolCallMeta.get(toolCallId);
              const args = (ev["arguments"] as { moduleId?: string; html?: string }) ?? {};
              // Part 2 — a screenshot tool returned an image; stash it by
              // toolCallId so the tool card can render a live preview. Kept
              // in client state only for this session (never persisted).
              const evImage = ev["image"] as
                | { base64?: unknown; mediaType?: unknown }
                | undefined;
              if (
                toolCallId &&
                evImage &&
                typeof evImage.base64 === "string" &&
                typeof evImage.mediaType === "string"
              ) {
                toolImages = new Map(toolImages).set(toolCallId, {
                  base64: evImage.base64,
                  mediaType: evImage.mediaType,
                });
              }
              if (typeof args.moduleId === "string" && typeof args.html === "string") {
                proposedDiffs = [
                  ...proposedDiffs,
                  {
                    moduleId: args.moduleId,
                    before: moduleStateBefore[args.moduleId] ?? "",
                    after: args.html,
                    selected: true,
                  },
                ];
              }
              // v0.2.46 — append a synthetic tool message routed to its
              // per-tool card. Without this, tool results only land in
              // the transcript on next page load; during streaming the
              // operator only sees the assistant's text reply.
              messages = [
                ...messages,
                {
                  id: `local-t-${toolCallId || Date.now()}`,
                  role: "tool",
                  content: String(ev["content"] ?? ""),
                  toolName: meta?.name ?? "unknown",
                  toolArgs: meta?.args ?? args,
                  // Part 2 — carry the toolCallId so the transcript render can
                  // look up the live screenshot in toolImages by key.
                  toolCallId: toolCallId || null,
                },
              ];
              // P6.7 — notify the live-edit overlay so it can reload
              // the iframe. The runtime payload has `arguments` only on
              // the `tool-start` event from the runner, but we forward
              // the args we have to keep the surface uniform.
              onToolResult?.({
                toolCallId,
                ok: true,
                content: String(ev["content"] ?? ""),
                arguments: args,
              });
            } else if (ev["kind"] === "tool-start") {
              // #30 — commit any buffered assistant text into a real message
              // BEFORE the tool card lands (the card is appended on tool-result).
              // Otherwise streamingText is only committed at `done` (appended
              // last), so a question/option card (offer_choices → ChoiceCard)
              // renders ABOVE the AI's comment instead of below it. Mirrors the
              // `done` handler's commit; server-side the text turn is already
              // persisted before the tool runs, so reload order is unaffected.
              if (streamingText.length > 0) {
                messages = [
                  ...messages,
                  {
                    id: `local-a-${Date.now()}`,
                    role: "assistant",
                    content: streamingText,
                    ...(streamingThinkingText.length > 0
                      ? { thinkingText: streamingThinkingText }
                      : {}),
                  },
                ];
                streamingText = "";
                streamingThinkingText = "";
              }
              const toolCallId = String(ev["toolCallId"] ?? "");
              const name = String(ev["name"] ?? "");
              const args = (ev["arguments"] as Record<string, unknown>) ?? {};
              if (toolCallId && name) {
                toolCallMeta.set(toolCallId, { name, args });
              }
              const moduleId =
                typeof args.moduleId === "string" ? (args.moduleId as string) : undefined;
              const html = typeof args.html === "string" ? (args.html as string) : undefined;
              if (moduleId && html) {
                proposedDiffs = [
                  ...proposedDiffs,
                  {
                    moduleId,
                    before: moduleStateBefore[moduleId] ?? "",
                    after: html,
                    selected: true,
                  },
                ];
              }
            } else if (ev["kind"] === "done") {
              if (streamingText.length > 0) {
                messages = [
                  ...messages,
                  {
                    id: `local-a-${Date.now()}`,
                    role: "assistant",
                    content: streamingText,
                    // v0.2.54 — attach the accumulated thinking text to
                    // the in-memory message so the collapsed details
                    // block stays visible after streaming ends, until
                    // the next page load swaps in the DB-persisted row.
                    ...(streamingThinkingText.length > 0
                      ? { thinkingText: streamingThinkingText }
                      : {}),
                  },
                ];
              }
              streamingText = "";
              streamingThinkingText = "";
              streaming = false;
              currentActivity = null;
            }
          } catch {
            // Tolerate non-JSON keepalive lines.
          }
        }
      }
    }
    // v0.2.45 — final-flush guard. If the SSE stream ended without
    // emitting a `done` event (network drop, server crash, abort), the
    // streaming text never landed in messages and just hangs in the
    // typing-indicator spot. Persist what we have so the operator
    // sees their answer; any reconnect logic (v0.2.47) can resume from
    // the last assistant message id.
    if (streamingText.length > 0) {
      messages = [
        ...messages,
        { id: `local-a-flush-${Date.now()}`, role: "assistant", content: streamingText },
      ];
      streamingText = "";
    }
    streaming = false;
    streamAbort = null;
    currentActivity = null;
    return turnStarted;
  }

  function lineDiff(before: string, after: string): { kind: "ctx" | "del" | "add"; text: string }[] {
    const a = before.split("\n");
    const b = after.split("\n");
    const out: { kind: "ctx" | "del" | "add"; text: string }[] = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (a[i] === b[i]) {
        if (a[i] !== undefined) out.push({ kind: "ctx", text: a[i] ?? "" });
      } else {
        if (a[i] !== undefined) out.push({ kind: "del", text: a[i] ?? "" });
        if (b[i] !== undefined) out.push({ kind: "add", text: b[i] ?? "" });
      }
    }
    return out;
  }
</script>

<div
  class={cn(
    compact ? "flex min-h-0 flex-1 flex-col gap-2 p-2" : "space-y-4",
  )}
>
  {#if !compact}
    <h1 class="text-2xl font-semibold tracking-tight">{session.title}</h1>
  {/if}

  {#if formError}
    <Alert variant="destructive"><AlertDescription>{formError}</AlertDescription></Alert>
  {/if}

  <div
    class={cn(
      compact ? "flex min-h-0 flex-1 flex-col" : "grid gap-4 lg:grid-cols-[1fr_320px]",
    )}
  >
    <!-- Transcript + composer -->
    <Card class={cn(compact && "flex min-h-0 flex-col")}>
      <CardContent
        class={cn(
          "flex flex-col gap-3 p-4",
          compact ? "min-h-0 flex-1" : "h-[calc(100vh-12rem)]",
        )}
      >
        <!-- v0.5.20 — failed-only transcript filter. Shows only tool
             messages whose content matches the failure heuristic. User
             + assistant messages stay visible regardless. The count in
             the button label gives a glance-able failure tally without
             scrolling the transcript. -->
        {@const failureCount = messages.filter(
          (m) => m.role === "tool" && isFailedToolMessage(m.content),
        ).length}
        <!-- Zero failures is the normal state — don't spend a row on
             saying so. The count element stays in the DOM (sr-only)
             because e2e assertions read its text. -->
        <div
          class={cn(
            "flex items-center justify-end gap-2 px-1 text-xs",
            failureCount > 0 || showFailedOnly ? "pb-1" : "sr-only",
          )}
        >
          <span class="text-muted-foreground" data-testid="transcript-failure-count">
            {failureCount} failure{failureCount === 1 ? "" : "s"}
          </span>
          {#if failureCount > 0 || showFailedOnly}
            <Button
              type="button"
              size="sm"
              variant={showFailedOnly ? "default" : "outline"}
              onclick={() => {
                showFailedOnly = !showFailedOnly;
              }}
              data-testid="transcript-filter-toggle"
            >
              {showFailedOnly ? "Showing failures only" : "Failed only"}
            </Button>
          {/if}
        </div>
        <div class="relative flex min-h-0 flex-1">
          <ul
            bind:this={transcriptEl}
            onscroll={handleTranscriptScroll}
            class="subtle-scrollbar flex-1 space-y-2 overflow-y-auto"
          >
            <!-- issue #303 — collapseStatusNotes runs BEFORE the failed-only
                 filter so toggling the filter never merges status runs that
                 had a tool card between them. It drops empty legacy notes
                 and keeps only the latest of consecutive near-identical
                 crawl-wait ticks. -->
            {#each collapseStatusNotes(messages).filter((m) => !showFailedOnly || m.role !== "tool" || isFailedToolMessage(m.content)) as m (m.id)}
              {#if m.role === "tool"}
                <!-- v0.2.46 — tool messages render as per-tool cards via
                     the router; falls back to plain markdown when no
                     card matches the tool's name. Edit-module tools
                     also get an inline diff card with Accept/Reject. -->
                <li class="space-y-1.5 text-sm">
                  <!-- v0.5.20 — derive ok from message content. Pre-v0.5.20
                       this was hardcoded `ok={true}`, which made every
                       persisted failure render through the success path
                       (plain markdown). Failures now render through
                       ToolCardRouter's destructive style. -->
                  <ToolCardRouter
                    name={m.toolName ?? toolNameFromHistory(m) ?? "tool result"}
                    content={m.content}
                    ok={!isFailedToolMessage(m.content)}
                    args={m.toolArgs ?? {}}
                    image={m.toolCallId ? toolImages.get(m.toolCallId) : undefined}
                    {csrfToken}
                    onDecisionStart={() => stopGeneration}
                    onDecided={(info) =>
                      onProposalDecided(info.kind, info.proposalId, info.action, info.ticket)}
                    onChoose={(answer) => {
                      // Streaming-safe: queue like approval nudges
                      // instead of silently dropping the click.
                      if (streaming) {
                        pendingChoiceAnswer = answer;
                        return;
                      }
                      // Sends the answer to the AI; the composer draft is left
                      // untouched (sendAutoMessage's overrideText path).
                      void sendAutoMessage(answer, "operator");
                    }}
                  />
                  {#if m.toolName === "edit_module" && typeof m.toolArgs?.moduleId === "string" && typeof m.toolArgs?.html === "string"}
                    {@const moduleId = m.toolArgs.moduleId as string}
                    {@const html = m.toolArgs.html as string}
                    {@const diffIdx = proposedDiffs.findIndex(
                      (d) => d.moduleId === moduleId && d.after === html,
                    )}
                    {#if diffIdx >= 0}
                      {@const d = proposedDiffs[diffIdx]}
                      <InlineDiff
                        moduleId={d!.moduleId}
                        before={d!.before}
                        after={d!.after}
                        selected={d!.selected}
                        onAccept={() => {
                          proposedDiffs = proposedDiffs.map((x, i) =>
                            i === diffIdx ? { ...x, selected: true } : x,
                          );
                        }}
                        onReject={() => {
                          proposedDiffs = proposedDiffs.map((x, i) =>
                            i === diffIdx ? { ...x, selected: false } : x,
                          );
                        }}
                      />
                    {/if}
                  {/if}
                </li>
              {:else if m.origin === "system"}
                {#if isContextNote(m.content)}
                  <!-- Injected AI-context plumbing: the current-page block
                       ("# Current page …" with a whole page's raw module HTML)
                       or the cold-start status line. Written FOR THE MODEL, not
                       the operator — collapse it behind a one-line summary so
                       the transcript isn't buried in raw (page-builder) HTML. -->
                  <li class="text-center" data-testid="chat-context-note">
                    <details
                      class="inline-block max-w-full rounded-md bg-muted px-3 py-1 text-left align-top"
                    >
                      <summary
                        class="cursor-pointer select-none text-xs italic text-muted-foreground"
                      >
                        {contextNoteLabel(m.content)}
                      </summary>
                      <pre
                        class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground"
                        >{stripNoteMarker(m.content)}</pre>
                    </details>
                  </li>
                {:else}
                  <!-- issue #29 — short auto-injected status nudge (crawl-
                       completion, post-approval continuation). The model saw it
                       as a user turn, but it did NOT come from the operator, and
                       it IS operator-relevant (explains what's happening), so it
                       stays visible as a muted, centered status note. -->
                  <li
                    class="rounded-md bg-muted px-3 py-2 text-center text-xs italic text-muted-foreground"
                    data-testid="chat-status-note"
                  >
                    <strong class="not-italic">Status:</strong>
                    {stripNoteMarker(m.content)}
                  </li>
                {/if}
              {:else if m.role === "user" || m.content.trim().length > 0 || m.thinkingText}
                <li
                  class={cn(
                    "rounded-md p-3 text-sm",
                    m.role === "user" ? "bg-primary/5" : "bg-muted",
                  )}
                >
                  <strong>{m.role === "user" ? "You" : "AI"}:</strong>
                  {#if m.role === "user"}
                    {@const reference = readPluginPreviewReference(m.content)}
                    <pre class="m-0 whitespace-pre-wrap font-sans">{reference.text}</pre>
                    {#if reference.selection ?? m.previewSelection}<span class="mt-1 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs">{(reference.selection ?? m.previewSelection)?.label}</span>{/if}
                    {#if m.attachments && m.attachments.length > 0}
                      <!-- issue #190 — persisted attachment thumbnails. -->
                      <div class="mt-2 flex flex-wrap gap-2" data-testid="chat-message-attachments">
                        {#each m.attachments as att (att.assetId)}
                          <img
                            src={`/_caelo/media/${att.assetId}/orig`}
                            alt={att.alt ?? "attached image"}
                            class="h-20 w-20 rounded-md border border-border object-cover"
                            loading="lazy"
                          />
                        {/each}
                      </div>
                    {/if}
                  {:else}
                    {#if m.thinkingText}
                      <details class="mt-1 rounded border border-muted-foreground/20 bg-background/50 px-2 py-1 text-xs">
                        <summary
                          class="cursor-pointer select-none text-muted-foreground"
                          data-testid="chat-thinking-summary"
                        >
                          Reasoning ({m.thinkingText.length} chars)
                        </summary>
                        <pre
                          class="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground"
                          >{m.thinkingText}</pre>
                      </details>
                    {/if}
                    <StreamingMarkdown text={m.content} class="mt-0.5" />
                  {/if}
                </li>
              {:else if m.status === "interrupted"}
                <!-- A turn that died mid-reply (Stop, tab close, abort). Show a
                     compact marker where it stopped instead of a blank "AI:"
                     bubble. A tool-only completed turn (empty prose, tool cards
                     render separately below) matches NO branch here — so it
                     renders nothing instead of an empty bubble. -->
                <li
                  class="rounded-md bg-muted/50 px-3 py-1.5 text-xs italic text-muted-foreground"
                  data-testid="chat-interrupted-marker"
                >
                  <strong>AI:</strong> Antwort unterbrochen.
                </li>
              {/if}
            {/each}
            {#if streaming && streamingText.length > 0}
              <li class="rounded-md border-l-4 border-muted-foreground/40 bg-muted p-3 text-sm">
                <strong>AI:</strong>
                {#if streamingThinkingText.length > 0}
                  <details
                    open
                    class="mt-1 rounded border border-muted-foreground/20 bg-background/50 px-2 py-1 text-xs"
                  >
                    <summary class="cursor-pointer select-none text-muted-foreground">
                      Reasoning… ({streamingThinkingText.length} chars)
                    </summary>
                    <pre
                      class="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground"
                      >{streamingThinkingText}</pre>
                  </details>
                {/if}
                <StreamingMarkdown text={streamingText} class="mt-0.5" />
              </li>
            {:else if streaming && streamingThinkingText.length > 0}
              <!-- v0.2.54 — thinking has started but no text yet; show
                   the live reasoning while the model finishes thinking
                   so the operator sees something is happening. -->
              <li
                class="rounded-md border-l-4 border-muted-foreground/40 bg-muted p-3 text-sm"
                data-testid="chat-thinking-live"
              >
                <strong>AI:</strong>
                <details
                  open
                  class="mt-1 rounded border border-muted-foreground/20 bg-background/50 px-2 py-1 text-xs"
                >
                  <summary class="cursor-pointer select-none text-muted-foreground">
                    Reasoning… ({streamingThinkingText.length} chars)
                  </summary>
                  <pre
                    class="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground"
                    >{streamingThinkingText}</pre>
                </details>
              </li>
            {:else if streaming}
              <!-- v0.2.45 — typing indicator while we wait for the first
                   text-delta. Bridges the gap between the user's optimistic
                   message landing and the provider's first chunk. -->
              <li
                class="rounded-md border-l-4 border-muted-foreground/40 bg-muted p-3 text-sm"
                data-testid="chat-typing"
              >
                <strong>AI:</strong>
                <span class="ml-1 inline-flex items-center gap-1 text-muted-foreground">
                  <span class="size-1.5 animate-pulse rounded-full bg-muted-foreground/60"></span>
                  <span
                    class="size-1.5 animate-pulse rounded-full bg-muted-foreground/60"
                    style="animation-delay: 150ms"
                  ></span>
                  <span
                    class="size-1.5 animate-pulse rounded-full bg-muted-foreground/60"
                    style="animation-delay: 300ms"
                  ></span>
                </span>
              </li>
            {/if}
            <!-- v0.2.60 — live activity pill. Visible whenever the
                 streaming session is active and we have a label.
                 Sits below the bubble so the operator always sees
                 what step the runner is on, even during the gaps
                 between bursts (text → tool args → tool dispatch). -->
            {#if streaming && currentActivity}
              <li
                class="-mt-1 flex items-center gap-2 px-3 text-xs text-muted-foreground"
                data-testid="chat-activity"
              >
                <span
                  class="inline-block size-1.5 animate-pulse rounded-full bg-primary/70"
                ></span>
                <span class="font-mono">{currentActivity}</span>
              </li>
            {/if}
            {#if chatError}
              <li data-testid="chat-error">
                <Alert variant="destructive">
                  <AlertDescription>{chatError}</AlertDescription>
                </Alert>
              </li>
            {/if}
            {#if chatWarning}
              <li data-testid="chat-warning">
                <Alert>
                  <AlertDescription>{chatWarning}</AlertDescription>
                </Alert>
              </li>
            {/if}
            {#if streamStalled}
              <li data-testid="chat-stalled">
                <Alert>
                  <AlertDescription>
                    Connection seems stalled — no events for over 90s. Refresh the page to retry.
                  </AlertDescription>
                </Alert>
              </li>
            {/if}
          </ul>
          {#if !followBottom && hasNewContent}
            <button
              type="button"
              onclick={jumpToLatest}
              class="absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background px-3 py-1 text-xs shadow-md hover:bg-accent"
              data-testid="chat-jump-latest"
            >
              <ArrowDown class="size-3" />
              <span>Jump to latest</span>
            </button>
          {/if}
        </div>

        {#if previewSelection}
          <div class="flex items-center gap-2 px-2 text-xs" data-testid="plugin-selection-chip">
            <span class="rounded-full bg-primary/10 px-2 py-1">{previewSelection.label}</span>
            {#if onClearPreviewSelection}<button type="button" onclick={onClearPreviewSelection} aria-label="Remove preview reference">×</button>{/if}
          </div>
        {/if}
        {#if chips.length > 0}
          <div class="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
            <span class="self-center"><em>Module references attached:</em></span>
            {#each chips as c, i (`${c.moduleId}-${c.selector}-${i}`)}
              <span
                data-testid="chip"
                class={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-foreground",
                  c.pinned ? "bg-amber-500/15 ring-1 ring-amber-500/40" : "bg-primary/10",
                )}
              >
                <span title={c.selectedText ?? c.context ?? c.selector}>
                  {c.label}{#if c.selectedText}<span class="text-muted-foreground">
                      · “{c.selectedText.length > 40 ? `${c.selectedText.slice(0, 39)}…` : c.selectedText}”</span
                    >{/if}
                </span>
                <button
                  type="button"
                  onclick={() => void togglePin(i)}
                  class="text-muted-foreground hover:text-foreground"
                  aria-label={c.pinned ? "Unpin chip" : "Pin chip across messages"}
                  title={c.pinned ? "Pinned across messages" : "Pin across messages"}
                >
                  {#if c.pinned}<Lock class="size-3" />{:else}<Unlock class="size-3" />{/if}
                </button>
                <button
                  type="button"
                  onclick={() => removeChip(i)}
                  class="text-muted-foreground hover:text-foreground"
                  aria-label="Remove chip">×</button
                >
              </span>
            {/each}
          </div>
        {/if}

        <!-- issue #228 — live crawl progress. Renders while an
             approved crawl run is in flight; the panel polls the
             status and posts the continuation nudge itself when the
             run is ready. (No line in this file may start with the
             token "import" — see the NOTE at the crawl-status
             declarations.) -->
        {#if crawlRun && (crawlRun.status === "crawling" || crawlRun.status === "proposed")}
          <div
            class="flex items-center gap-2 rounded-md border border-link/30 bg-link/5 p-2 text-xs"
            data-testid="chat-import-progress"
          >
            <span
              class="inline-block size-3 animate-spin rounded-full border-2 border-link border-t-transparent motion-reduce:animate-none"
              aria-hidden="true"
            ></span>
            <span class="font-medium text-link">
              {crawlRun.status === "proposed" ? "Crawler starting…" : "Crawling…"}
            </span>
            <span class="text-muted-foreground">
              {crawlRun.pagesExtracted}/{crawlRun.maxPages} pages
              {#if crawlRun.maxPages > 0}
                ({Math.min(100, Math.round((crawlRun.pagesExtracted / crawlRun.maxPages) * 100))}%)
              {/if}
            </span>
            <span class="ml-auto text-muted-foreground">I'll continue automatically when it's done.</span>
          </div>
        {:else if crawlRun && crawlRun.status === "failed"}
          <div
            class="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
            data-testid="chat-import-progress"
          >
            Crawl failed: {crawlRun.errorMessage ?? "no error message"}
          </div>
        {/if}
        <!-- Issues #664 / #665 — every agent working in this chat (incl. other
             tabs, subagents, external MCP agents), each with its own Stop. -->
        <RunningAgentsBar
          chatSessionId={session.id}
          {csrfToken}
          refreshKey={(streaming ? 1 : 0) + (operatorStopped ? 2 : 0)}
        />
        {#if stopError}
          <p role="alert" class="text-xs text-destructive" data-testid="chat-stop-error">
            Stop did not reach the server: {stopError}
          </p>
        {/if}
                <!-- v0.2.63 — Pending proposals strip. Pinned directly ABOVE
             THE COMPOSER (operator feedback 2026-07-12: at the top of
             the transcript it sat exactly where the eye is NOT while
             reading the newest message — "missed it nearly"). Click
             Approve here instead of hunting the original tool-card.
             Drops out as soon as the row flips to applied/rejected. -->
        <!-- #685 — the quality check found problems: ask before the AI
             fixes anything. Only the operator's click starts the turn. -->
        {#if qualityOffer && !(qualityOfferSettling && qualityOffer.auditRunId === qualityOfferActing)}
          <QualityFixOfferCard
            text={qualityOffer.text}
            actionLabel={qualityOffer.actionLabel}
            groups={qualityOffer.groups}
            busy={qualityOfferActing !== null}
            aiBusy={streaming}
            error={qualityOfferError}
            onFix={(selection) => {
              if (qualityOffer) void acceptQualityOffer(qualityOffer.auditRunId, selection);
            }}
            onAccept={(selection, reason) => {
              if (qualityOffer) void acceptQualityGroups(qualityOffer.auditRunId, selection, reason);
            }}
            onDismiss={() => {
              if (qualityOffer) void dismissQualityOffer(qualityOffer.auditRunId);
            }}
          />
        {/if}
        <!-- #553 — a FAILED quality check keeps Publish live closed; say so
             in the chat, with the retry right here (publishing anyway is a
             toolbar decision or the AI's approval card). -->
        {#if qualityStatus.status?.gate?.state === "errored"}
          <div
            class="flex flex-wrap items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs"
            data-testid="chat-quality-failed"
          >
            <span class="font-medium text-destructive">Audit failed:</span>
            <span class="min-w-0 flex-1 truncate" title={qualityStatus.status.gate.message}>
              {qualityStatus.status.gate.message}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="chat-quality-retry"
              onclick={() => void retryQualityCheck()}
            >
              Retry check
            </Button>
            {#if qualityRetryError}
              <span role="alert" class="text-destructive">{qualityRetryError}</span>
            {/if}
          </div>
        {/if}
        <!-- #971 — a credential an approval in this chat produced (a new
             user's password, an MCP token): shown to the approver only,
             never to the AI. -->
        <CredentialHandoffs {csrfToken} refreshKey={credentialRefresh} />
        <!-- Plan B (SDK approval gate) — inline Approve/Reject for a gated tool
             a turn in this chat paused on. This chat's own AI resumes (or
             reacts to a denial) as soon as the operator decides; an external
             agent's card (issue #658) records the decision and hands it back
             to that agent — no AI turn starts here. -->
        {#if sdkApprovals.length > 0}
          <div
            class="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs"
            data-testid="chat-approval-strip"
          >
            <div class="mb-1.5 flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <span class="font-semibold">⏳ Approve this change?</span>
            </div>
            <ul class="space-y-1.5">
              {#each sdkApprovals as a (a.approvalId)}
                {@const missing = missingApproverPermissions(a)}
                {@const external = sdkApprovalRoute(a.requestedVia) === "record"}
                <li
                  class="rounded border bg-card p-2"
                  data-testid="chat-approval-card"
                  data-requested-via={a.requestedVia ?? "chat"}
                >
                  {#if external}
                    <span
                      class="mb-1 inline-block rounded bg-link/10 px-1.5 py-0.5 text-[10px] text-link"
                      data-testid="chat-approval-external-agent"
                      title="The decision goes back to the external agent, which continues its own work. This chat's AI does not act on it."
                      >{EXTERNAL_AGENT_LABEL}</span
                    >
                  {/if}
                  <pre
                    class="mb-2 max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[11px]"
                    data-testid="chat-approval-preview">{a.preview ||
                      a.name}</pre>
                  {#if missing.length > 0}
                    <p
                      class="mb-2 text-[11px] text-muted-foreground"
                      data-testid="chat-approval-missing-permission"
                    >
                      Approving this needs {missing.join(" + ")}, which your role does not have. Ask
                      an Owner to approve it, or reject it.
                    </p>
                  {/if}
                  <!-- #779 — Approve is the human decision: coral. -->
                  <div class="flex items-center gap-1.5">
                    <button
                      type="button"
                      class={buttonVariants({ variant: "decide", size: "sm" })}
                      disabled={(external ? approvalDeciding[a.approvalId] === true : streaming) ||
                        missing.length > 0}
                      data-testid="chat-approval-approve"
                      onclick={() => resolveSdkApproval(a, true)}>Approve</button
                    >
                    <button
                      type="button"
                      class={buttonVariants({ variant: "outline", size: "sm" })}
                      disabled={external ? approvalDeciding[a.approvalId] === true : streaming}
                      data-testid="chat-approval-reject"
                      onclick={() => resolveSdkApproval(a, false)}>Reject</button
                    >
                  </div>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        {#if mcpHandoffs.length > 0}
          <!-- Issue #658 — decided external-agent proposals: the result went
               back to the agent, not to this chat's AI. -->
          <ul class="space-y-1 text-xs" data-testid="chat-mcp-handoffs">
            {#each mcpHandoffs as h (h.proposalId)}
              <li
                class="flex items-center gap-2 rounded-md border border-link/30 bg-link/5 p-1.5"
                data-testid="chat-mcp-handoff"
                data-outcome={h.outcome}
                data-delivered={h.deliveredAt !== null ? "true" : "false"}
              >
                <span class="truncate text-muted-foreground">{h.summary}</span>
                <span class="ml-auto shrink-0">{handoffStatusText(h)}</span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if pendingProposals.length > 0}
          <div
            class="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs"
            data-testid="chat-pending-strip"
          >
            <div class="mb-1.5 flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <span class="font-semibold">⏳ Pending your approval</span>
              <span class="text-muted-foreground"
                >({pendingProposals.length}
                {pendingProposals.length === 1 ? "proposal" : "proposals"})</span
              >
            </div>
            <ul class="space-y-1.5">
              {#each pendingProposals as p (p.proposalId)}
                <li class="flex items-center gap-2 rounded border bg-card p-1.5">
                  <span class="font-mono text-[10px] text-muted-foreground"
                    >{p.proposalId.slice(0, 8)}…</span
                  >
                  <span class="font-mono text-[10px] text-muted-foreground"
                    >{p.domain}.{p.kind}</span
                  >
                  <span class="truncate">{p.summary}</span>
                  {#if p.requestedVia === "power_mcp"}
                    <span
                      class="shrink-0 rounded bg-link/10 px-1.5 py-0.5 text-[10px] text-link"
                      data-testid="pending-external-agent"
                      title="The decision is handed back to the external agent, which continues the work. This chat's AI does not act on it."
                      >{EXTERNAL_AGENT_LABEL}</span
                    >
                  {/if}
                  <span class="ml-auto flex items-center gap-1.5">
                    <!-- #779 — Approve is the human decision: coral, also
                         for a destructive kind (the domain.kind label above
                         names it). -->
                    <Button
                      type="button"
                      size="sm"
                      variant="decide"
                      disabled={pendingActioning[p.proposalId] !== undefined &&
                        pendingActioning[p.proposalId] !== null}
                      onclick={() =>
                        actOnPending(p.proposalId, p.queueUrl, "approve", p.kind, p.requestedVia ?? null)}
                      data-testid="pending-approve"
                    >
                      {pendingActioning[p.proposalId] === "approving" ? "Approving…" : "Approve"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pendingActioning[p.proposalId] !== undefined &&
                        pendingActioning[p.proposalId] !== null}
                      onclick={() =>
                        actOnPending(p.proposalId, p.queueUrl, "reject", p.kind, p.requestedVia ?? null)}
                    >
                      {pendingActioning[p.proposalId] === "rejecting" ? "Rejecting…" : "Reject"}
                    </Button>
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        <form
          onsubmit={(e) => {
            e.preventDefault();
            void sendMessage();
          }}
          class="relative space-y-2"
          ondragover={(e) => {
            e.preventDefault();
            dragOver = true;
          }}
          ondragleave={() => {
            dragOver = false;
          }}
          ondrop={(e) => void onComposerDrop(e)}
        >
          <!-- e2e-livedit hook (issue #47). Always-present element whose
               data-turn-state attribute flips between "streaming" and
               "idle" so real-AI Playwright specs can wait on the AI
               turn deterministically without scraping copy. Two states
               are sufficient; the test only waits for "idle". -->
          <span
            hidden
            aria-hidden="true"
            data-testid="chat-turn-status"
            data-turn-state={streaming ? "streaming" : "idle"}
          ></span>
          {#if firstRunSuggestions.length > 0 && !streaming && !messages.some((m) => m.role === "user")}
            <!-- Onboarding quick replies: the choice is a click, not a
                 typing exercise. Hidden forever after the first user
                 turn. -->
            <div class="mb-1.5 flex flex-wrap gap-1.5" data-testid="chat-first-run-suggestions">
              {#each firstRunSuggestions as sug (sug.label)}
                <button
                  type="button"
                  class="rounded-full border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-primary/10"
                  onclick={() => void sendAutoMessage(sug.message, "operator")}
                >
                  {sug.label}
                </button>
              {/each}
            </div>
          {/if}
          {#if pendingAttachments.length > 0}
            <!-- issue #190 — attachment chips riding the next message. -->
            <div class="mb-1.5 flex flex-wrap gap-2" data-testid="chat-pending-attachments">
              {#each pendingAttachments as att (att.assetId)}
                <div class="relative">
                  <img
                    src={`/_caelo/media/${att.assetId}/orig`}
                    alt={att.alt}
                    class="h-14 w-14 rounded-md border border-border object-cover"
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${att.alt}`}
                    class="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-foreground text-[10px] leading-none text-background"
                    onclick={() => {
                      pendingAttachments = pendingAttachments.filter(
                        (x) => x.assetId !== att.assetId,
                      );
                    }}
                  >
                    ×
                  </button>
                </div>
              {/each}
            </div>
          {/if}
          <div class="flex items-center gap-2">
            <input
              bind:this={imageInput}
              type="file"
              accept={CHAT_IMAGE_MIMES.join(",")}
              multiple
              class="sr-only"
              tabindex="-1"
              aria-label="Choose chat images"
              data-testid="chat-image-input"
              onchange={(e) => {
                const files = [...(e.currentTarget.files ?? [])];
                e.currentTarget.value = "";
                void attachImages(files);
              }}
            />
            <Button type="button" variant="outline" size="sm"
              disabled={!hydrated || uploadingImages || pendingAttachments.length >= MAX_PENDING_ATTACHMENTS}
              onclick={() => imageInput?.click()} data-testid="chat-attach-images">
              <ImagePlus class="mr-1.5 size-4" />
              {uploadingImages ? "Uploading…" : "Add images"}
            </Button>
            <span class="text-xs text-muted-foreground" role="status">
              {uploadingImages ? "Wait for uploads before sending." : "Up to 4 images · 5 MiB each · saved in Media library"}
            </span>
          </div>
          <Textarea
            onpaste={onComposerPaste}
            bind:value={composer}
            bind:ref={composerEl}
            rows={1}
            placeholder="Tell the AI what to change…"
            title="Shortcuts: / for commands, @ for module references, drop images to attach"
            class={cn(
              "subtle-scrollbar resize-none placeholder:text-muted-foreground/50",
              dragOver && "border-primary ring-2 ring-primary/30",
            )}
            data-testid="chat-composer"
            disabled={!hydrated}
            oninput={() => {
              autoSizeComposer();
              detectMention();
            }}
            onkeydown={onComposerKeydown}
          />
          {#if mentionKind && (slashSuggestions.length > 0 || atSuggestions.length > 0)}
            <!-- v0.2.47 — slash / @-mention popup. Positioned below the
                 textarea via a relative ancestor (the form). Suggestion
                 list scrolls if the filtered set exceeds the cap. -->
            <div
              class="absolute left-0 top-full z-10 mt-1 w-full max-w-md rounded-md border bg-popover shadow-md"
              data-testid="chat-mention-popup"
            >
              <ul class="max-h-56 overflow-y-auto py-1 text-sm">
                {#if mentionKind === "slash"}
                  {#each slashSuggestions as h, i (h.label)}
                    <li>
                      <button
                        type="button"
                        class={cn(
                          "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                          i === mentionIndex ? "bg-accent" : "hover:bg-accent/60",
                        )}
                        onclick={() => {
                          mentionIndex = i;
                          selectMention();
                        }}
                      >
                        <span class="font-mono text-xs text-primary">{h.label}</span>
                        <span class="text-xs text-muted-foreground">{h.description}</span>
                      </button>
                    </li>
                  {/each}
                {:else}
                  {#each atSuggestions as m, i (m.id)}
                    <li>
                      <button
                        type="button"
                        class={cn(
                          "flex w-full flex-col items-start px-3 py-1.5 text-left",
                          i === mentionIndex ? "bg-accent" : "hover:bg-accent/60",
                        )}
                        onclick={() => {
                          mentionIndex = i;
                          selectMention();
                        }}
                      >
                        <span class="font-mono text-xs">@module:{m.slug}</span>
                        <span class="text-[10px] text-muted-foreground">{m.displayName}</span>
                      </button>
                    </li>
                  {/each}
                {/if}
              </ul>
              <div class="border-t px-3 py-1 text-[10px] text-muted-foreground">
                ↑↓ navigate · Enter / Tab to insert · Esc to dismiss
              </div>
            </div>
          {/if}
          {#if uploadError}
            <p class="text-xs text-destructive" data-testid="chat-upload-error">{uploadError}</p>
          {/if}
          <div class="flex items-center gap-2">
            <Label for="picker" class="text-xs text-muted-foreground">+ Reference module</Label>
            <select
              id="picker"
              bind:value={pickedModuleId}
              onchange={addChipFromDropdown}
              class="flex h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">…</option>
              {#each modules as m (m.id)}
                <option value={m.id}>{m.slug} — {m.displayName}</option>
              {/each}
            </select>
            <!-- v0.2.54 — extended thinking toggle. Per-chat-session
                 preference; the chat-runner reads it on each turn and
                 passes the thinking budget to Anthropic. Posts to the
                 page server's `set_extended_thinking` action via
                 fetch (HTML doesn't allow nesting <form> elements,
                 so we can't use a separate <form> inside the chat
                 composer's form). The local mirror gets flipped
                 optimistically; on failure we revert. -->
            <Button
              type="button"
              size="sm"
              class="ml-auto"
              variant={extendedThinkingEnabled ? "default" : "outline"}
              title={extendedThinkingEnabled
                ? "Extended thinking is ON — click to disable"
                : "Click to enable extended thinking (the model reasons before replying)"}
              data-testid="chat-extended-thinking-toggle"
              onclick={toggleExtendedThinking}
            >
              {extendedThinkingEnabled ? "✦ Thinking" : "Thinking"}
            </Button>
            {#if canDebug}
              <!-- v0.2.55 — Debug toggle. Shows the panel + console-
                   logs every SSE event when on. Visible only to
                   operators with settings.read permission. -->
              <Button
                type="button"
                size="sm"
                variant={debug ? "default" : "outline"}
                title={debug
                  ? "Debug is ON — click to hide the panel + stop logging events"
                  : "Click to enable debug (panel + console event log)"}
                data-testid="chat-debug-toggle"
                onclick={() => onToggleDebug?.()}
              >
                {debug ? "🐞 Debug ON" : "🐞 Debug"}
              </Button>
            {/if}
            {#if streaming}
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onclick={() => void stopStreaming()}
                data-testid="chat-stop"
                title="Stop the AI's current action"
              >
                <Square class="mr-1.5 size-3.5 fill-current" /> Stop
              </Button>
            {:else}
              <Button
                type="submit"
                size="sm"
                disabled={!hydrated || uploadingImages || (composer.trim().length === 0 && pendingAttachments.length === 0)}
                data-testid="chat-send"
              >
                Send
              </Button>
            {/if}
          </div>
        </form>
      </CardContent>
    </Card>

    <!-- Sidebar: diff + rename. Hidden in compact (overlay) mode — the
         overlay carries its own Stage/Publish split-button. v0.7.1
         dropped the legacy per-entity Stage picker from this surface;
         operators do all Stage + Publish work through /edit now. -->
    {#if !compact}
    <aside class="space-y-4">
      {#if debug}
        <DebugPanel
          toolCalls={debugToolCalls}
          usage={debugUsage}
          rawEvents={debugRawEvents}
        />
      {/if}
      {#if pendingChangeCount > 0 && !session.publishedAt}
        <p class="text-xs text-muted-foreground">
          {pendingChangeCount} edit{pendingChangeCount === 1 ? "" : "s"} during this turn — open
          /edit to stage + publish.
        </p>
      {/if}

      {#if proposedDiffs.length > 0}
        <Card>
          <CardHeader>
            <CardTitle class="text-base">Visual diff</CardTitle>
          </CardHeader>
          <CardContent class="space-y-2 font-mono text-xs">
            {#each proposedDiffs as d (`${d.moduleId}-${d.after.slice(0, 16)}`)}
              <div>
                <strong>module {d.moduleId.slice(0, 8)}</strong>
                <pre class="m-0 whitespace-pre-wrap">{#each lineDiff(d.before, d.after) as ln, i (i)}<span
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
            {/each}
          </CardContent>
        </Card>
      {/if}

      <Card>
        <CardHeader>
          <CardTitle class="text-base">Rename</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="post" action="?/rename" class="flex items-center gap-2">
            <input type="hidden" name="_csrf" value={csrfToken} />
            <Input name="title" type="text" value={session.title} />
            <Button type="submit" size="sm" variant="outline">Rename</Button>
          </form>
        </CardContent>
      </Card>

      <!-- v0.5.20 — quick link to the per-chat completion view. -->
      <a
        href={`/content/chat/${session.id}/summary`}
        class={`${buttonVariants({ variant: "outline", size: "sm" })} w-full justify-center`}
        data-testid="open-chat-summary"
      >
        Open chat summary
      </a>
    </aside>
    {/if}
  </div>
</div>

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

  import { ArrowDown, Lock, Unlock } from "lucide-svelte";
  import { onMount, tick } from "svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import { cn } from "$lib/utils.js";
  import DebugPanel from "./DebugPanel.svelte";
  import StageSplitButton from "./StageSplitButton.svelte";
  import type { DebugToolCall, DebugUsage } from "./debug-types.js";
  import InlineDiff from "./InlineDiff.svelte";
  import StreamingMarkdown from "./StreamingMarkdown.svelte";
  import ToolCardRouter from "./tool-cards/ToolCardRouter.svelte";
  import type { ChatMessage, ChatModule, ChatSession } from "./types.js";

  interface Chip {
    moduleId: string;
    selector: string;
    label: string;
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

  interface PendingEntity {
    kind: string;
    entityId: string;
    label: string;
    detail?: string;
  }
  interface PendingChangesView {
    pending: { pages: PendingEntity[]; globals: PendingEntity[]; lists: PendingEntity[] };
    staged: { pages: PendingEntity[]; globals: PendingEntity[]; lists: PendingEntity[] };
  }

  interface Props {
    session: ChatSession;
    initialMessages: ChatMessage[];
    modules: ChatModule[];
    csrfToken: string;
    formError?: string | null;
    /** v0.5.5 — pending/staged view from chat.list_pending_changes for
     *  the Stage picker. Optional — older callers pass nothing and the
     *  picker collapses to "No pending changes". */
    pendingChanges?: PendingChangesView;
    /**
     * Sized-by-parent variant for the live-edit overlay. The default
     * uses `h-[calc(100vh-12rem)]` which is right inside AppShell but
     * overflows when embedded in the floating overlay.
     */
    compact?: boolean;
    /** P6.7.3 — when set, the runner gets a Current-page system block. */
    activePageId?: string | null;
    onToolResult?: (payload: ToolResultPayload) => void;
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
    pendingChanges = {
      pending: { pages: [], globals: [], lists: [] },
      staged: { pages: [], globals: [], lists: [] },
    },
    compact = false,
    activePageId = null,
    onToolResult,
    debug = false,
    canDebug = false,
    onToggleDebug,
  }: Props = $props();

  let messages = $state<ChatMessage[]>(initialMessages);
  let composer = $state("");
  let composerEl = $state<HTMLTextAreaElement | null>(null);
  let streaming = $state(false);

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
  // / Reject post to the existing /security/<domain>/pending form
  // actions (same path ProposeCard uses).
  interface PendingProposal {
    proposalId: string;
    domain: string;
    kind: string;
    summary: string;
    proposedAt: string;
    queueUrl: string;
  }
  let pendingProposals = $state<PendingProposal[]>([]);
  let pendingActioning = $state<Record<string, "approving" | "rejecting" | null>>({});

  async function loadPendingProposals(): Promise<void> {
    try {
      const res = await fetch(`/content/chat/${session.id}/pending`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { items?: PendingProposal[] };
      pendingProposals = data.items ?? [];
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
  ): Promise<void> {
    pendingActioning = {
      ...pendingActioning,
      [proposalId]: action === "approve" ? "approving" : "rejecting",
    };
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
        if (action === "approve") {
          onProposalApproved(kind, proposalId);
        }
      } else {
        pendingActioning = { ...pendingActioning, [proposalId]: null };
      }
    } catch {
      pendingActioning = { ...pendingActioning, [proposalId]: null };
    }
  }

  /**
   * v0.2.75 — Post-approval signaling. Two effects:
   *   (a) Fire onToolResult so the /edit overlay's existing
   *       handler reloads the preview iframe (mirrors the
   *       iframe-reload that happens after every AI tool result).
   *   (b) Auto-send a follow-up message to the AI naming the
   *       approved proposal so it can continue immediately,
   *       without the operator typing "ok continue".
   * Both are best-effort and safe outside an /edit context.
   */
  function onProposalApproved(kind: string | undefined, proposalId: string): void {
    // (a) iframe reload — same shape /edit's onAiToolResult expects.
    onToolResult?.({
      toolCallId: `approval-${proposalId}`,
      ok: true,
      content: "proposal applied",
    });
    // (b) auto-send a system-ish nudge to the AI. Only fire when
    // we're not already mid-stream (don't interrupt an in-flight
    // turn — the AI saw the approval queue at last turn-start).
    if (streaming) return;
    const label = kind ? `${kind} proposal` : "proposal";
    void sendAutoMessage(
      `Approved: ${label} ${proposalId.slice(0, 8)} applied to the chat branch. Please continue with what you were doing.`,
    );
  }

  /**
   * v0.2.75 — Programmatic send for system-driven follow-ups
   * (post-approval). Reuses sendMessage by routing through composer
   * — the operator briefly sees the auto-text in the composer before
   * it clears, which makes the action visible. No-op if a turn is
   * already in flight.
   */
  async function sendAutoMessage(text: string): Promise<void> {
    if (streaming) return;
    composer = text;
    await sendMessage();
  }
  // v0.5.5 — renamed from `pendingChanges` to avoid name-clash with the
  // new prop carrying the categorized {pending,staged} view from
  // chat.list_pending_changes. This local counter tracks live tool-result
  // signals during streaming; the prop is the authoritative server-load
  // view re-fetched between turns.
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
  const STREAM_STALL_THRESHOLD_MS = 90_000;
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
  // v0.2.54 — local mirror of session.extendedThinkingEnabled for
  // optimistic toggle. The form action persists to chat_sessions; this
  // local mirror keeps the toggle responsive without a page reload.
  let extendedThinkingEnabled = $state<boolean>(
    session.extendedThinkingEnabled ?? false,
  );

  /**
   * v0.3.1 — Capture the preview iframe via html2canvas and upload
   * the PNG to the screenshot endpoint, which resolves the
   * server-side `awaitScreenshot` Promise so the AI's
   * `screenshot_page` tool returns the image bytes.
   *
   * Iframe source: `/edit/preview-by-path/<locale>/<slug>?branch=<chatBranchId>`
   * — same URL the live-edit overlay uses. Capture is same-origin
   * (admin-served), so html2canvas can read the contentDocument.
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
  }): Promise<void> {
    const VIEWPORT_DIMS = {
      desktop: { width: 1280, height: 800 },
      tablet: { width: 768, height: 1024 },
      mobile: { width: 375, height: 812 },
    };
    const { width, height } = VIEWPORT_DIMS[req.viewport];

    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.left = "-99999px";
    iframe.style.top = "-99999px";
    iframe.style.width = `${width}px`;
    iframe.style.height = `${height}px`;
    iframe.style.border = "0";
    iframe.style.visibility = "hidden";
    // The preview path needs locale + slug. We don't know them from
    // the SSE event (only pageId + chatBranchId), so use the
    // pages/preview pageId-based route which the editor iframe also
    // uses. Builds the right URL server-side based on pageId.
    const params = new URLSearchParams();
    if (req.chatBranchId) params.set("branch", req.chatBranchId);
    iframe.src = `/edit/preview/${req.pageId}${params.size > 0 ? `?${params}` : ""}`;
    document.body.appendChild(iframe);

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
      // Wait for iframe load (or timeout). Capture happens on the
      // load event so html2canvas sees the rendered DOM.
      await new Promise<void>((resolve, reject) => {
        const onLoad = (): void => {
          iframe.removeEventListener("load", onLoad);
          resolve();
        };
        iframe.addEventListener("load", onLoad);
        setTimeout(() => reject(new Error("iframe load timeout (10s)")), 10_000);
      });

      const doc = iframe.contentDocument;
      if (!doc) {
        await uploadFailure("iframe contentDocument is null (cross-origin?)");
        return;
      }
      // Dynamic import keeps html2canvas out of the main bundle —
      // only loaded when the AI actually requests a screenshot.
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(doc.body, {
        width,
        height,
        windowWidth: width,
        windowHeight: height,
        scale: 1,
        // useCORS lets the canvas pull in cross-origin images
        // (CDN media). foreignObjectRendering=false avoids a
        // Chromium quirk where SVGs in foreignObject fail to taint
        // the canvas — important for read-back.
        useCORS: true,
        foreignObjectRendering: false,
        logging: false,
      });
      // toBlob → base64. We strip the data:image/png;base64, prefix
      // because the upload endpoint expects raw base64.
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
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

      const res = await fetch(`/content/chat/${session.id}/screenshot/${req.requestId}`, {
        method: "POST",
        headers: { "x-csrf-token": csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ base64 }),
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
    { label: "/translate", insert: "Translate ", description: "translate a page to another locale" },
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

  function onComposerKeydown(e: KeyboardEvent): void {
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

  /** Drag-drop media upload. The drop handler sends the first file to
   *  /api/media/upload and pastes the resulting URL into the composer
   *  at the current caret. Reuses the existing media upload route +
   *  the `caelo:insert-into-composer` event the media picker fires. */
  async function onComposerDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    dragOver = false;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    uploadError = null;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/media/upload", {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
        body: fd,
      });
      if (!res.ok) {
        uploadError = `Upload failed (${res.status}). Drop a smaller file or use the media picker.`;
        return;
      }
      const v = (await res.json()) as { url?: string; mediaId?: string; alt?: string };
      const url = v.url ?? "";
      const alt = v.alt ?? file.name;
      if (!url) {
        uploadError = "Upload returned no URL.";
        return;
      }
      const snippet = file.type.startsWith("image/")
        ? `<img src="${url}" alt="${alt}">`
        : url;
      // Reuse the existing inserter so caret position is respected.
      document.dispatchEvent(
        new CustomEvent("caelo:insert-into-composer", { detail: { text: snippet } }),
      );
    } catch (err) {
      uploadError = `Upload failed: ${(err as Error).message ?? "unknown"}`;
    }
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
   */
  onMount(() => {
    // v0.2.63 — initial fetch of pending proposals scoped to this
    // chat. Subsequent refreshes are triggered by tool-result events
    // (the runner just queued or executed something).
    void loadPendingProposals();
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as Chip | undefined;
      if (!detail || typeof detail.moduleId !== "string") return;
      // De-dupe: don't add a chip already present (pinned or not).
      if (chips.some((c) => c.moduleId === detail.moduleId && c.selector === detail.selector)) return;
      chips = [...chips, { ...detail }];
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

  async function sendMessage(): Promise<void> {
    if (composer.trim().length === 0 || streaming) return;
    const text = composer;
    const sentChips = chips;
    composer = "";
    chatError = null;
    chatWarning = null;
    streamStalled = false;
    lastEventAtMs = Date.now();
    // Pinned chips ride every send; transient chips clear after.
    chips = chips.filter((c) => c.pinned);
    streaming = true;
    streamingText = "";
    streamingThinkingText = "";
    currentActivity = "Sending…";
    // Snap the composer back to one row after clearing it.
    queueMicrotask(autoSizeComposer);
    messages = [...messages, { id: `local-${Date.now()}`, role: "user", content: text }];
    const res = await fetch(`/content/chat/${session.id}/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({
        content: text,
        chips: sentChips,
        ...(activePageId ? { activePageId } : {}),
      }),
    });
    if (!res.body) {
      streaming = false;
      // v0.2.45 — surface a clear error instead of silently dropping the
      // optimistic user message. The fetch reached the server but no body
      // came back; usually means the route returned a non-stream error.
      chatError = `Chat request returned no body (status ${res.status}). The server may be misconfigured — try again or check /security/audit.`;
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
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
              const isProposeShaped = /^Queued proposal [0-9a-f-]{36}:/.test(resultContent);
              if (
                okFlag &&
                (name.startsWith("propose_") ||
                  name.endsWith(".execute_proposal") ||
                  isProposeShaped)
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
              });
            } else if (ev["kind"] === "assistant-message-saved") {
              currentActivity = "Continuing…";
            } else if (ev["kind"] === "usage") {
              // No update; keep the prior activity pill visible.
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
        <!-- v0.2.63 — Pending proposals strip. Appears above the
             transcript whenever AI-queued proposals from THIS chat
             are awaiting Owner action. Click Approve here instead of
             scrolling up to the original tool-card OR navigating to
             /security/<domain>/pending. Drops out as soon as the row
             flips to applied / rejected. -->
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
                  <span class="ml-auto flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant={/^(delete|remove|revert|clear|deactivate|cancel)/i.test(p.kind)
                        ? "destructive"
                        : "default"}
                      disabled={pendingActioning[p.proposalId] !== undefined &&
                        pendingActioning[p.proposalId] !== null}
                      onclick={() => actOnPending(p.proposalId, p.queueUrl, "approve", `${p.domain}.${p.kind}`)}
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
                      onclick={() => actOnPending(p.proposalId, p.queueUrl, "reject")}
                    >
                      {pendingActioning[p.proposalId] === "rejecting" ? "Rejecting…" : "Reject"}
                    </Button>
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        <div class="relative flex min-h-0 flex-1">
          <ul
            bind:this={transcriptEl}
            onscroll={handleTranscriptScroll}
            class="flex-1 space-y-2 overflow-y-auto"
          >
            {#each messages as m (m.id)}
              {#if m.role === "tool"}
                <!-- v0.2.46 — tool messages render as per-tool cards via
                     the router; falls back to plain markdown when no
                     card matches the tool's name. Edit-module tools
                     also get an inline diff card with Accept/Reject. -->
                <li class="space-y-1.5 text-sm">
                  <ToolCardRouter
                    name={m.toolName ?? "unknown"}
                    content={m.content}
                    ok={true}
                    args={m.toolArgs ?? {}}
                    {csrfToken}
                    onApproved={(info) => onProposalApproved(info.kind, info.proposalId)}
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
              {:else}
                <li
                  class={cn(
                    "rounded-md p-3 text-sm",
                    m.role === "user" ? "bg-primary/5" : "bg-muted",
                  )}
                >
                  <strong>{m.role === "user" ? "You" : "AI"}:</strong>
                  {#if m.role === "user"}
                    <pre class="m-0 whitespace-pre-wrap font-sans">{m.content}</pre>
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
                {c.label}
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
          <Textarea
            bind:value={composer}
            bind:ref={composerEl}
            rows={1}
            placeholder="Tell the AI what to change… (try / for shortcuts, @ for module references)"
            class={cn("resize-none", dragOver && "border-primary ring-2 ring-primary/30")}
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
            <Button
              type="submit"
              size="sm"
              disabled={streaming || composer.trim().length === 0}
            >
              {streaming ? "…" : "Send"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>

    <!-- Sidebar: Publish + diff + rename. Hidden in compact (overlay)
         mode — the overlay carries its own Stage/Confirm strip and the
         diff view lives in the main /content/chat surface. -->
    {#if !compact}
    <aside class="space-y-4">
      {#if debug}
        <DebugPanel
          toolCalls={debugToolCalls}
          usage={debugUsage}
          rawEvents={debugRawEvents}
        />
      {/if}
      <!-- v0.5.5 — Stage & publish picker replaces the v0.4.0 publish
           card. Uses chat.list_pending_changes data passed in by the
           parent page server load. -->
      <StageSplitButton
        {pendingChanges}
        {csrfToken}
        sessionPublished={!!session.publishedAt}
      />
      {#if pendingChangeCount > 0 && !session.publishedAt}
        <p class="text-xs text-muted-foreground">
          {pendingChangeCount} edit{pendingChangeCount === 1 ? "" : "s"} during this turn — reload
          to refresh the picker.
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
    </aside>
    {/if}
  </div>
</div>

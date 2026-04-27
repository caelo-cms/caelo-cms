<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P6.7 — the floating chat overlay that sits on top of the live-edit
   * iframe. Wraps `<ChatPanel>` plus a top-strip Stage / Confirm publish
   * form. Drag/resize/pin/collapse state persists per-user via the
   * `user_preferences` ops.
   */

  import { GripHorizontal, Maximize2, Minimize2, PinOff } from "lucide-svelte";
  import type { ChatMessage, ChatModule, ChatSession } from "$lib/components/chat/types.js";
  import ChatPanel from "$lib/components/chat/ChatPanel.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Card } from "$lib/components/ui/card/index.js";
  import { cn } from "$lib/utils.js";
  import {
    DEFAULT_LAYOUT,
    debounced,
    type OverlayLayout,
    type PinMode,
    saveOverlayLayout,
  } from "./use-overlay-layout.svelte.js";

  type ToolResultPayload = {
    toolCallId: string;
    ok: boolean;
    content: string;
    arguments?: { moduleId?: string; html?: string };
  };

  interface Props {
    session: ChatSession;
    initialMessages: ChatMessage[];
    modules: ChatModule[];
    csrfToken: string;
    initialLayout?: OverlayLayout;
    /** Active pageId — drives Stage/Confirm publish forms in the strip. */
    activePageId?: string | null;
    /**
     * Staging preview URL after a successful Stage. Surfaced as a prop so
     * the parent /edit/+page.svelte (which owns the form-action result)
     * can flow it down without the Overlay needing its own form-action
     * subscription.
     */
    stagedPreviewUrl?: string | null;
    onToolResult?: (payload: ToolResultPayload) => void;
  }
  let {
    session,
    initialMessages,
    modules,
    csrfToken,
    initialLayout = DEFAULT_LAYOUT,
    activePageId = null,
    stagedPreviewUrl = null,
    onToolResult,
  }: Props = $props();

  let layout = $state<OverlayLayout>({ ...initialLayout });
  const persist = debounced((next: OverlayLayout) => {
    void saveOverlayLayout(csrfToken, next);
  }, 500);
  $effect(() => {
    persist(layout);
  });

  function setPin(pin: PinMode): void {
    layout = { ...layout, pin };
  }
  function toggleCollapsed(): void {
    layout = { ...layout, collapsed: !layout.collapsed };
  }

  // Drag handler for the title bar (floating mode only). Skip when the
  // pointer lands on a child Button — capturing the pointer there
  // swallows the click and the user can't actually use the toolbar.
  let dragState: { startX: number; startY: number; origX: number; origY: number } | null = null;
  function onPointerDownTitle(e: PointerEvent): void {
    if (layout.pin !== "floating") return;
    const target = e.target as HTMLElement | null;
    if (target && target.closest("button") !== null) return;
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      origX: layout.x,
      origY: layout.y,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMoveTitle(e: PointerEvent): void {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    layout = {
      ...layout,
      x: Math.max(0, dragState.origX + dx),
      y: Math.max(0, dragState.origY + dy),
    };
  }
  function onPointerUpTitle(e: PointerEvent): void {
    dragState = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  // Resize handler for the SE corner (floating mode only).
  let resizeState: {
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null = null;
  const MIN_W = 280;
  const MIN_H = 320;
  function onPointerDownResize(e: PointerEvent): void {
    if (layout.pin !== "floating") return;
    e.stopPropagation();
    resizeState = {
      startX: e.clientX,
      startY: e.clientY,
      origW: layout.width,
      origH: layout.height,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMoveResize(e: PointerEvent): void {
    if (!resizeState) return;
    const dw = e.clientX - resizeState.startX;
    const dh = e.clientY - resizeState.startY;
    layout = {
      ...layout,
      width: Math.max(MIN_W, resizeState.origW + dw),
      height: Math.max(MIN_H, resizeState.origH + dh),
    };
  }
  function onPointerUpResize(e: PointerEvent): void {
    resizeState = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  // Position styles per pin mode.
  const positionStyle = $derived(
    layout.collapsed
      ? "right: 24px; bottom: 24px; width: 56px; height: 56px;"
      : layout.pin === "pinned-bottom"
        ? "left: 0; right: 0; bottom: 0; height: 320px;"
        : layout.pin === "pinned-right"
          ? "right: 0; top: 56px; bottom: 0; width: 380px;"
          : `left: ${layout.x}px; top: ${layout.y}px; width: ${layout.width}px; height: ${layout.height}px;`,
  );

  // Stage/Confirm strip state — bumps when the AI lands a tool result so
  // the Stage button enables.
  let pendingChanges = $state(0);

  function handleToolResult(payload: ToolResultPayload): void {
    if (payload.ok) pendingChanges += 1;
    onToolResult?.(payload);
  }
</script>

{#if layout.collapsed}
  <button
    type="button"
    class="fixed z-40 rounded-full bg-primary p-3 text-primary-foreground shadow-lg hover:scale-105"
    style={positionStyle}
    aria-label="Open live-edit overlay"
    onclick={toggleCollapsed}
  >
    💬
  </button>
{:else}
  <Card
    class={cn(
      "fixed z-40 flex flex-col overflow-hidden",
      layout.pin !== "floating" && "rounded-none",
    )}
    style={positionStyle}
  >
    <!-- Title bar -->
    <div
      role="toolbar"
      aria-label="Live-edit overlay controls"
      class={cn(
        "flex items-center gap-1 border-b bg-muted/40 px-3 py-1.5",
        layout.pin === "floating" && "cursor-move",
      )}
      onpointerdown={onPointerDownTitle}
      onpointermove={onPointerMoveTitle}
      onpointerup={onPointerUpTitle}
    >
      <GripHorizontal class="size-4 text-muted-foreground" />
      <span class="text-xs font-medium text-muted-foreground">Live edit</span>
      <div class="ml-auto flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onclick={() => setPin("floating")}
          aria-label="Float"
          class={cn(layout.pin === "floating" && "bg-accent")}
        >
          <PinOff class="size-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onclick={() => setPin("pinned-bottom")}
          aria-label="Pin to bottom"
          class={cn(layout.pin === "pinned-bottom" && "bg-accent")}
        >
          <Maximize2 class="size-3 rotate-90" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onclick={() => setPin("pinned-right")}
          aria-label="Pin to right"
          class={cn(layout.pin === "pinned-right" && "bg-accent")}
        >
          <Maximize2 class="size-3" />
        </Button>
        <Button type="button" variant="ghost" size="sm" onclick={toggleCollapsed} aria-label="Collapse">
          <Minimize2 class="size-3" />
        </Button>
      </div>
    </div>

    <!-- Stage / Confirm publish strip — present when a page is selected -->
    {#if activePageId}
      <div
        class="flex flex-wrap items-center gap-2 border-b bg-background/80 px-3 py-1.5 text-xs"
        data-testid="publish-strip"
      >
        {#if stagedPreviewUrl}
          <span class="text-muted-foreground">
            Staged —
            <a
              href={stagedPreviewUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="underline"
            >preview</a>
          </span>
          <form method="post" action="?/confirmPublish" class="ml-auto">
            <input type="hidden" name="_csrf" value={csrfToken} />
            <input type="hidden" name="pageId" value={activePageId} />
            <Button type="submit" size="sm" data-testid="confirm-publish-btn">Confirm publish</Button>
          </form>
        {:else}
          <span class="text-muted-foreground">
            {pendingChanges === 0
              ? "No pending changes."
              : `${pendingChanges} pending change${pendingChanges === 1 ? "" : "s"}.`}
          </span>
          <form method="post" action="?/stage" class="ml-auto">
            <input type="hidden" name="_csrf" value={csrfToken} />
            <input type="hidden" name="pageId" value={activePageId} />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={pendingChanges === 0}
              data-testid="stage-btn"
            >Stage</Button>
          </form>
        {/if}
      </div>
    {/if}

    <!-- Embedded chat panel — renders directly as the Card's flex child
         so its `compact` mode (flex-1 min-h-0) takes the remaining
         vertical space without an extra wrapper that would break the
         h-full chain. -->
    <ChatPanel
      {session}
      {initialMessages}
      {modules}
      {csrfToken}
      {activePageId}
      compact
      onToolResult={handleToolResult}
    />

    <!-- Resize handle (floating mode only) -->
    {#if layout.pin === "floating"}
      <button
        type="button"
        aria-label="Resize overlay"
        class="absolute bottom-0 right-0 size-3 cursor-se-resize bg-transparent"
        style="touch-action: none;"
        onpointerdown={onPointerDownResize}
        onpointermove={onPointerMoveResize}
        onpointerup={onPointerUpResize}
      ></button>
    {/if}
  </Card>
{/if}

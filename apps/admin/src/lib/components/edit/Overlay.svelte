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

  interface Props {
    session: ChatSession;
    initialMessages: ChatMessage[];
    modules: ChatModule[];
    csrfToken: string;
    initialLayout?: OverlayLayout;
    onToolResult?: () => void;
  }
  let {
    session,
    initialMessages,
    modules,
    csrfToken,
    initialLayout = DEFAULT_LAYOUT,
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

  // Drag handler for the title bar (floating mode only).
  let dragState: { startX: number; startY: number; origX: number; origY: number } | null = null;
  function onPointerDownTitle(e: PointerEvent): void {
    if (layout.pin !== "floating") return;
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

  /**
   * Forwarded onToolResult from the embedded ChatPanel — bubbles up to
   * the parent /edit route so it can postMessage a reload to the iframe.
   */
  function handleToolResult(): void {
    onToolResult?.();
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

    <!-- Embedded chat panel -->
    <div class="flex-1 overflow-hidden">
      <ChatPanel
        {session}
        {initialMessages}
        {modules}
        {csrfToken}
        onToolResult={handleToolResult}
      />
    </div>
  </Card>
{/if}

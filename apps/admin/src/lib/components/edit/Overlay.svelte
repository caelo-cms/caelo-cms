<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P6.7 — the floating chat overlay that sits on top of the live-edit
   * iframe. P6.7.4 changes:
   *   - Clearer pin icons (Move / PanelBottom / PanelRight) + tooltips.
   *   - Resize affordance for pinned-bottom (top edge → height) and
   *     pinned-right (left edge → width). New pinnedHeight + pinnedWidth
   *     fields on OverlayLayout.
   *   - Publish strip moved out — lives in /edit's toolbar header now.
   *   - Chat history dropdown + "+ New chat" form for page-bound chats.
   */

  import {
    History,
    Move,
    PanelBottom,
    PanelRight,
    Plus,
    GripHorizontal,
    Minimize2,
  } from "lucide-svelte";
  import { onDestroy, onMount } from "svelte";
  import type { ChatMessage, ChatModule, ChatSession } from "$lib/components/chat/types.js";
  import ChatPanel from "$lib/components/chat/ChatPanel.svelte";
  import MediaPicker from "$lib/components/MediaPicker.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Card } from "$lib/components/ui/card/index.js";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
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

  interface PageChat {
    id: string;
    title: string;
    lastActiveAt?: string;
    publishedAt: string | null;
  }

  interface Props {
    session: ChatSession;
    initialMessages: ChatMessage[];
    modules: ChatModule[];
    csrfToken: string;
    initialLayout?: OverlayLayout;
    activePageId?: string | null;
    /** P6.7.4 — chats bound to the active page for the history dropdown. */
    pageChats?: PageChat[];
    onToolResult?: (payload: ToolResultPayload) => void;
  }
  let {
    session,
    initialMessages,
    modules,
    csrfToken,
    initialLayout = DEFAULT_LAYOUT,
    activePageId = null,
    pageChats = [],
    onToolResult,
  }: Props = $props();

  // Old persisted layouts may lack pinnedHeight/pinnedWidth — merge with
  // defaults so missing fields don't crash the resize math.
  let layout = $state<OverlayLayout>({ ...DEFAULT_LAYOUT, ...initialLayout });
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

  // Resize handlers. SE corner in floating mode; top edge in
  // pinned-bottom; left edge in pinned-right.
  type ResizeKind = "se" | "top" | "left";
  let resizeState: {
    kind: ResizeKind;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null = null;
  const MIN_W = 280;
  const MIN_H = 220;

  function startResize(kind: ResizeKind, e: PointerEvent): void {
    e.stopPropagation();
    e.preventDefault();
    resizeState = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      origW: kind === "left" ? layout.pinnedWidth : layout.width,
      origH: kind === "top" ? layout.pinnedHeight : layout.height,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMoveResize(e: PointerEvent): void {
    if (!resizeState) return;
    const dx = e.clientX - resizeState.startX;
    const dy = e.clientY - resizeState.startY;
    if (resizeState.kind === "se") {
      layout = {
        ...layout,
        width: Math.max(MIN_W, resizeState.origW + dx),
        height: Math.max(MIN_H, resizeState.origH + dy),
      };
    } else if (resizeState.kind === "top") {
      // Dragging up grows the pinned-bottom strip; clamp to viewport-100.
      const max = (typeof window !== "undefined" ? window.innerHeight : 800) - 100;
      layout = {
        ...layout,
        pinnedHeight: Math.max(MIN_H, Math.min(max, resizeState.origH - dy)),
      };
    } else {
      // Dragging left grows the pinned-right strip.
      const max = (typeof window !== "undefined" ? window.innerWidth : 1200) - 200;
      layout = {
        ...layout,
        pinnedWidth: Math.max(MIN_W, Math.min(max, resizeState.origW - dx)),
      };
    }
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
        ? `left: 0; right: 0; bottom: 0; height: ${layout.pinnedHeight}px;`
        : layout.pin === "pinned-right"
          ? `right: 0; top: 56px; bottom: 0; width: ${layout.pinnedWidth}px;`
          : `left: ${layout.x}px; top: ${layout.y}px; width: ${layout.width}px; height: ${layout.height}px;`,
  );

  function handleToolResult(payload: ToolResultPayload): void {
    onToolResult?.(payload);
  }

  // P7 review-pass: Cmd+M opens the MediaPicker. The picker's onPick
  // dispatches a `caelo:insert-into-composer` CustomEvent that the
  // ChatPanel listens for; we don't reach into the panel's $state
  // directly so the panel stays callable from /content/chat without
  // /edit-specific coupling.
  let mediaPickerOpen = $state(false);

  function onMediaPicked(m: { url: string; alt: string }): void {
    const altAttr = m.alt ? ` alt="${m.alt.replace(/"/g, "&quot;")}"` : ' alt=""';
    const snippet = `<img src="${m.url}"${altAttr} />`;
    document.dispatchEvent(
      new CustomEvent("caelo:insert-into-composer", { detail: { text: snippet } }),
    );
  }

  function onGlobalKeyDown(e: KeyboardEvent): void {
    if (layout.collapsed) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key.toLowerCase() !== "m") return;
    const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
    // Don't pre-empt the user typing m in some other input — only fire
    // when focus is in the composer textarea OR not in any field at
    // all (lets the user trigger from anywhere on /edit).
    if (tag === "input" || tag === "select") return;
    e.preventDefault();
    mediaPickerOpen = true;
  }

  onMount(() => {
    document.addEventListener("keydown", onGlobalKeyDown);
  });
  onDestroy(() => {
    if (typeof document !== "undefined") {
      document.removeEventListener("keydown", onGlobalKeyDown);
    }
  });

  function fmtRelative(iso: string | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  }
</script>

{#if layout.collapsed}
  <button
    type="button"
    class="fixed z-40 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:scale-105"
    style={positionStyle}
    aria-label="Open live-edit chat overlay"
    title="Open live-edit chat"
    onclick={toggleCollapsed}
    data-testid="overlay-collapsed-button"
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
    <!-- Pinned-bottom: top-edge resize handle -->
    {#if layout.pin === "pinned-bottom"}
      <button
        type="button"
        aria-label="Resize chat strip height"
        title="Drag to resize"
        class="absolute left-0 right-0 top-0 z-10 h-1.5 cursor-ns-resize bg-transparent hover:bg-primary/20"
        style="touch-action: none;"
        onpointerdown={(e) => startResize("top", e)}
        onpointermove={onPointerMoveResize}
        onpointerup={onPointerUpResize}
      ></button>
    {/if}

    <!-- Pinned-right: left-edge resize handle -->
    {#if layout.pin === "pinned-right"}
      <button
        type="button"
        aria-label="Resize chat strip width"
        title="Drag to resize"
        class="absolute bottom-0 left-0 top-0 z-10 w-1.5 cursor-ew-resize bg-transparent hover:bg-primary/20"
        style="touch-action: none;"
        onpointerdown={(e) => startResize("left", e)}
        onpointermove={onPointerMoveResize}
        onpointerup={onPointerUpResize}
      ></button>
    {/if}

    <!-- Title bar -->
    <div
      role="toolbar"
      tabindex="0"
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

      {#if activePageId}
        <!-- Chat history dropdown + new-chat button -->
        <DropdownMenu>
          <DropdownMenuTrigger>
            {#snippet child({ props })}
              <Button
                {...props}
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Chat history"
                title="Switch chat"
                data-testid="chat-history-trigger"
                class="ml-1 h-7 px-2"
              >
                <History class="size-3" />
              </Button>
            {/snippet}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <div class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              Chats for this page
            </div>
            <DropdownMenuSeparator />
            {#if pageChats.length === 0}
              <DropdownMenuItem disabled>No chats yet</DropdownMenuItem>
            {:else}
              {#each pageChats as c (c.id)}
                <DropdownMenuItem>
                  {#snippet child({ props })}
                    <a
                      {...props}
                      href={`/edit?page=${activePageId}&chat=${c.id}`}
                      class={cn(
                        "flex flex-col gap-0.5 px-2 py-1.5 text-xs",
                        c.id === session.id && "bg-accent",
                      )}
                    >
                      <span class="truncate">{c.title}</span>
                      <span class="text-muted-foreground">{fmtRelative(c.lastActiveAt)}</span>
                    </a>
                  {/snippet}
                </DropdownMenuItem>
              {/each}
            {/if}
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              {#snippet child({ props })}
                <form
                  {...props}
                  method="post"
                  action="?/newChat"
                  class="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs hover:bg-accent"
                >
                  <input type="hidden" name="_csrf" value={csrfToken} />
                  <input type="hidden" name="pageId" value={activePageId} />
                  <Plus class="size-3" />
                  <button type="submit" class="flex-1 text-left" data-testid="new-chat-btn">
                    New chat
                  </button>
                </form>
              {/snippet}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      {/if}

      <div class="ml-auto flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onclick={() => setPin("floating")}
          aria-label="Float"
          title="Float (drag to move)"
          class={cn("h-7 px-2", layout.pin === "floating" && "bg-accent")}
        >
          <Move class="size-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onclick={() => setPin("pinned-bottom")}
          aria-label="Pin to bottom"
          title="Pin to bottom"
          class={cn("h-7 px-2", layout.pin === "pinned-bottom" && "bg-accent")}
        >
          <PanelBottom class="size-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onclick={() => setPin("pinned-right")}
          aria-label="Pin to right"
          title="Pin to right"
          class={cn("h-7 px-2", layout.pin === "pinned-right" && "bg-accent")}
        >
          <PanelRight class="size-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onclick={toggleCollapsed}
          aria-label="Collapse"
          title="Collapse"
          class="h-7 px-2"
        >
          <Minimize2 class="size-3" />
        </Button>
      </div>
    </div>

    <!-- Embedded chat panel -->
    <ChatPanel
      {session}
      {initialMessages}
      {modules}
      {csrfToken}
      {activePageId}
      compact
      onToolResult={handleToolResult}
    />

    <!-- P7 review-pass: Cmd+M opens the media picker; on pick, the URL +
         alt drop into the chat composer as an <img> hint. The user
         then describes what to do with it ("place this on the hero")
         and the AI uses the URL via edit_module. -->
    <MediaPicker
      bind:open={mediaPickerOpen}
      onPick={onMediaPicked}
    />

    <!-- SE-corner resize (floating mode only) -->
    {#if layout.pin === "floating"}
      <button
        type="button"
        aria-label="Resize overlay"
        title="Drag to resize"
        class="absolute bottom-0 right-0 size-3 cursor-se-resize bg-transparent"
        style="touch-action: none;"
        onpointerdown={(e) => startResize("se", e)}
        onpointermove={onPointerMoveResize}
        onpointerup={onPointerUpResize}
      ></button>
    {/if}
  </Card>
{/if}

// SPDX-License-Identifier: MPL-2.0

/**
 * Shared types for the ChatPanel surface. Imported by both
 * `lib/components/chat/ChatPanel.svelte` and the route loaders that
 * feed it (`/content/chat/[sessionId]/+page.server.ts` plus P6.7's
 * /edit overlay loader). Keeps the prop contract typed end-to-end so
 * wrappers don't reach for `as never`.
 */

export interface PinnedElement {
  moduleId: string;
  selector: string;
  label: string;
}

export interface ChatSession {
  id: string;
  title: string;
  chatBranchId: string;
  publishedAt: string | null;
  /** ISO timestamp of the last interaction; drives the history dropdown's relative time. */
  lastActiveAt?: string;
  /**
   * P6.7 — chips the human owner has locked across messages so the AI
   * sees them on every send within this session. Optional on the wire
   * because pre-P6.7 sessions have no column value yet.
   */
  pinnedElements?: PinnedElement[];
  /** P6.7.4 — page the chat is bound to (or null for cross-site chats). */
  pageId?: string | null;
  /** P6.7.4 — template the chat is bound to (or null). */
  templateId?: string | null;
}

export interface ChatModule {
  id: string;
  slug: string;
  displayName: string;
  html?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
}

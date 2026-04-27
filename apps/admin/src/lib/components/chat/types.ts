// SPDX-License-Identifier: MPL-2.0

/**
 * Shared types for the ChatPanel surface. Imported by both
 * `lib/components/chat/ChatPanel.svelte` and the route loaders that
 * feed it (`/content/chat/[sessionId]/+page.server.ts` plus P6.7's
 * /edit overlay loader). Keeps the prop contract typed end-to-end so
 * wrappers don't reach for `as never`.
 */

export interface ChatSession {
  id: string;
  title: string;
  chatBranchId: string;
  publishedAt: string | null;
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

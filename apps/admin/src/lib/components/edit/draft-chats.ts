// SPDX-License-Identifier: MPL-2.0

/**
 * The Draft changes list (Live Edit's Staging menu, Content → Changes):
 * the operator's own conversations with changes that are not on staging
 * yet, one card each with its counts, "Stage now", "Open chat" and the
 * details. Pure helpers here, so the wording and the selection rules are
 * pinned by unit tests.
 *
 * A "change" here is what the operator recognises: a page (new, changed
 * or removed) or one part that shows on many pages. One page with eight
 * edited sections is one change, not ten (`summary.rows`, admin-core's
 * draft-summary.ts).
 */

import type { DraftSummary } from "@caelo-cms/admin-core";

/** One of the operator's own conversations with draft changes. */
export interface DraftChat {
  readonly chatSessionId: string;
  readonly title: string;
  readonly branchKind: "draft" | "experiment" | "migration" | "legacy";
  readonly anchorPageId: string | null;
  readonly anchorPagePath: string | null;
  readonly pendingCount: number;
  readonly summary: DraftSummary;
}

/** How many changes a conversation shows. */
export function changeCount(chat: DraftChat): number {
  return chat.summary.rows.length;
}

/** All changes of the given conversations: the Staging button's "14 draft changes". */
export function totalChanges(chats: readonly DraftChat[]): number {
  return chats.reduce((n, c) => n + changeCount(c), 0);
}

/** `n` with the singular or plural noun. */
export function countOf(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The counts on a conversation's card, the zero ones left out. */
export function statChips(summary: DraftSummary): string[] {
  const chips: string[] = [];
  if (summary.newPages > 0) chips.push(countOf(summary.newPages, "new page", "new pages"));
  if (summary.changedPages > 0) {
    chips.push(countOf(summary.changedPages, "changed page", "changed pages"));
  }
  if (summary.removedPages > 0) {
    chips.push(countOf(summary.removedPages, "removed page", "removed pages"));
  }
  if (summary.siteWide > 0) {
    chips.push(countOf(summary.siteWide, "site-wide change", "site-wide changes"));
  }
  // Only changes no page shows (an unused section design): Stage merges
  // them, but nothing changes for a visitor.
  return chips.length > 0 ? chips : ["Nothing visitors see"];
}

/** Where the conversation works, under its title. */
export function chatContext(chat: DraftChat): string {
  const where = chat.anchorPagePath ?? "Not tied to a page";
  switch (chat.branchKind) {
    case "experiment":
      return `Experiment · ${where}`;
    case "migration":
      return `Site migration · ${where}`;
    case "legacy":
      return `Older chat · ${where}`;
    default:
      return where;
  }
}

/**
 * The editor link that opens a conversation: its page with it, or the
 * conversation alone when it is not tied to one. Without `page` a
 * page-bound chat would not be found (/edit looks for it among the shown
 * page's chats) and the editor would open another one.
 */
export function chatHref(chat: DraftChat): string {
  const params = new URLSearchParams({ chat: chat.chatSessionId });
  if (chat.anchorPageId) params.set("page", chat.anchorPageId);
  return `/edit?${params.toString()}`;
}

/**
 * The conversations ticked when the list opens: in Live Edit only the
 * conversation on screen (decision 2026-11-17: the Staging click is about
 * this chat; the others stay visible and can be ticked), elsewhere none.
 */
export function initialSelection(
  chats: readonly DraftChat[],
  activeChatId: string | null,
): Set<string> {
  return new Set(
    activeChatId !== null && chats.some((c) => c.chatSessionId === activeChatId)
      ? [activeChatId]
      : [],
  );
}

/** The list's footer button for the ticked conversations, or null when there is one card. */
export function stageSelectedLabel(
  chats: readonly DraftChat[],
  selected: ReadonlySet<string>,
): { label: string; disabled: boolean } | null {
  if (chats.length < 2) return null;
  const picked = chats.filter((c) => selected.has(c.chatSessionId));
  if (picked.length === 0) return { label: "Stage selected", disabled: true };
  return { label: `Stage selected (${totalChanges(picked)})`, disabled: false };
}

/**
 * The active conversation first, then as listed (most recently active
 * first): the card the Staging click is about sits at the top.
 */
export function orderForDisplay(
  chats: readonly DraftChat[],
  activeChatId: string | null,
): DraftChat[] {
  const active = chats.find((c) => c.chatSessionId === activeChatId);
  return active ? [active, ...chats.filter((c) => c !== active)] : [...chats];
}

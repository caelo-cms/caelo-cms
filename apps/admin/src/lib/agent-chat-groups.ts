// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1253 — every external agent works in a chat of its own, so a
 * client running 20 agents opens 20 chats. The chat list shows them per
 * client ("Claude Code", a token's label) instead of mixed into the
 * operator's own chats.
 */

/** The fields the grouping reads. */
export interface GroupableChat {
  readonly id: string;
  readonly lastActiveAt?: string;
  readonly agentClient?: string | null;
}

/** One client's agent chats, most recently active first. */
export interface AgentChatGroup<T extends GroupableChat> {
  readonly client: string;
  readonly chats: readonly T[];
}

/**
 * Split chats into the operator's own and the agents', grouped per client.
 * Groups are ordered by their most recently active chat; each chat appears
 * once even when the input lists it twice (a page-bound and a global list).
 */
export function groupAgentChats<T extends GroupableChat>(
  chats: readonly T[],
): { readonly own: readonly T[]; readonly agents: readonly AgentChatGroup<T>[] } {
  const seen = new Set<string>();
  const own: T[] = [];
  const byClient = new Map<string, T[]>();
  for (const chat of chats) {
    if (seen.has(chat.id)) continue;
    seen.add(chat.id);
    const client = chat.agentClient ?? null;
    if (client === null) {
      own.push(chat);
      continue;
    }
    const list = byClient.get(client) ?? [];
    list.push(chat);
    byClient.set(client, list);
  }
  const recent = (a: T, b: T) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "");
  const agents = [...byClient]
    .map(([client, list]) => ({ client, chats: [...list].sort(recent) }))
    .sort((a, b) => recent(a.chats[0] as T, b.chats[0] as T));
  return { own, agents };
}

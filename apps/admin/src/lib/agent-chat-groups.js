// SPDX-License-Identifier: MPL-2.0
/**
 * Split chats into the operator's own and the agents', grouped per client.
 * Groups are ordered by their most recently active chat; each chat appears
 * once even when the input lists it twice (a page-bound and a global list).
 */
export function groupAgentChats(chats) {
    const seen = new Set();
    const own = [];
    const byClient = new Map();
    for (const chat of chats) {
        if (seen.has(chat.id))
            continue;
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
    const recent = (a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "");
    const agents = [...byClient]
        .map(([client, list]) => ({ client, chats: [...list].sort(recent) }))
        .sort((a, b) => recent(a.chats[0], b.chats[0]));
    return { own, agents };
}

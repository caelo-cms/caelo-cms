// SPDX-License-Identifier: MPL-2.0

/**
 * issue #262 — unit tests for the `# Locks held by other chats` block
 * formatter. Shape assertions only; the op itself is covered by
 * `__tests__/chat-list-foreign-locks.integration.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import type { ForeignLock } from "../../../ops/chat/foreign-locks.js";
import { formatForeignLocksBlock } from "./foreign-locks.js";

function lock(overrides: Partial<ForeignLock> = {}): ForeignLock {
  return {
    entityKind: "theme",
    entityId: "11111111-1111-4111-8111-111111111111",
    label: "Searchviu",
    lockedAt: "2026-07-12T21:55:07.087Z",
    holder: {
      chatSessionId: "22222222-2222-4222-8222-222222222222",
      title: "Live edit",
      pageSlug: "home",
      pendingChangeCount: 34,
    },
    ...overrides,
  };
}

describe("formatForeignLocksBlock", () => {
  it("returns undefined for an empty list (block omitted per CLAUDE.md §11)", () => {
    expect(formatForeignLocksBlock([])).toBeUndefined();
  });

  it("names the entity, the holding chat, its page, and the pending count", () => {
    const block = formatForeignLocksBlock([lock()]);
    expect(block).toBeDefined();
    if (!block) return;
    expect(block).toStartWith("# Locks held by other chats");
    expect(block).toContain('theme "Searchviu"');
    expect(block).toContain('held by chat "Live edit" on /home');
    expect(block).toContain("34 unshipped edits");
    // The planning directive the AI acts on — warn up front, don't collide.
    expect(block).toContain("warn them UP FRONT");
  });

  it("flags a zero-pending holder as a stale lock", () => {
    const block = formatForeignLocksBlock([
      lock({ holder: { ...lock().holder, pendingChangeCount: 0, pageSlug: null } }),
    ]);
    expect(block).toBeDefined();
    if (!block) return;
    expect(block).toContain("no unshipped edits — stale lock");
    // No page anchor → no " on /" fragment.
    expect(block).not.toContain(" on /");
  });

  it("caps at 15 rows and notes the overflow; stays under the 2 KB budget", () => {
    const locks = Array.from({ length: 40 }, (_, i) =>
      lock({
        entityId: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`,
        label: `module-${i}`,
        entityKind: "module",
      }),
    );
    const block = formatForeignLocksBlock(locks);
    expect(block).toBeDefined();
    if (!block) return;
    expect(block.split("\n").filter((l) => l.startsWith("- ")).length).toBe(15);
    expect(block).toContain("25 more foreign locks not shown");
    expect(new TextEncoder().encode(block).length).toBeLessThan(2048);
  });
});

// SPDX-License-Identifier: MPL-2.0

/**
 * Chat-first approval contract (operator requirement, 2026-07-12:
 * "alles soll im Chat-Kontext stattfinden").
 *
 * The §11.A click happens on the proposal CARD in the chat. Two
 * mechanical invariants keep the whole class of flow-breaks out:
 *
 *  C1 — every /security/<domain>/pending approve/reject form action
 *       must accept the field name the chat's ProposeCard posts
 *       (`proposalId`). Queues with a native field (imports' `runId`)
 *       alias it. The import domain shipped WITHOUT this and the
 *       inline Approve failed 400 while the AI narrated an admin-page
 *       detour — exactly the break this test pins shut.
 *
 *  C2 — no AI-facing tool source (description, prompt, OR result
 *       content) may instruct "click Approve at /security/…/pending".
 *       The queue path stays mentioned as an aside ("(queue: …)")
 *       because proposal-parser.ts needs the URL in result content —
 *       but the instruction the model relays to the operator points
 *       at the card.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SECURITY_ROUTES = join(REPO_ROOT, "apps/admin/src/routes/(authed)/security");
const AI_TOOLS = join(REPO_ROOT, "packages/admin-core/src/ai/tools");

function pendingActionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith("pending/+page.server.ts")) out.push(full);
    }
  };
  walk(SECURITY_ROUTES);
  return out;
}

describe("C1 — pending queues accept the chat card's field name", () => {
  const files = pendingActionFiles();

  it("finds the pending queues (guard against a silent glob miss)", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  for (const file of files) {
    const rel = file.slice(REPO_ROOT.length + 1);
    it(`${rel} reads proposalId`, () => {
      const src = readFileSync(file, "utf8");
      // Pages without form actions (pure inbox views) are exempt.
      if (!src.includes("export const actions")) return;
      expect(
        src.includes('form.get("proposalId")'),
        `${rel} has form actions but never reads proposalId — the chat card's inline Approve posts exactly that field and will fail 400 (imports regression class)`,
      ).toBe(true);
    });
  }
});

describe("C2 — tool descriptions point at the card, not an admin page", () => {
  // "Approve at /security/x/pending" as an INSTRUCTION is the smell;
  // "(queue: /security/x/pending)" as an aside is fine, and result
  // CONTENT strings must keep the canonical URL for the parser.
  const forbidden = /(click|clicks)\s+Approve\s+at\s+\/security\/[a-z-]+\/pending/i;

  for (const entry of readdirSync(AI_TOOLS)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    it(`${entry} has no admin-page approve instruction`, () => {
      const src = readFileSync(join(AI_TOOLS, entry), "utf8");
      const hit = forbidden.exec(src);
      expect(
        hit === null,
        `${entry}: "${hit?.[0] ?? ""}" — instruct the operator to use the proposal card's Approve button in the chat; mention the queue path only as an aside`,
      ).toBe(true);
    });
  }
});

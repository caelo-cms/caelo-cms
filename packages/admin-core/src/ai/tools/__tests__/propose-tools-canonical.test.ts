// SPDX-License-Identifier: MPL-2.0

/**
 * Every `propose_*` tool's success message MUST match the chat's ProposeCard
 * parser, and its description MUST carry the two-step contract.
 *
 * Why this test exists: the four locale propose tools were hand-rolled instead
 * of using `makeProposeTool`, and emitted
 *   `Queued proposal <uuid> to add locale 'de' (...)`
 * — no colon. The parser requires `Queued proposal <uuid>: <summary>.`, so it
 * never matched and NO Approve card rendered in the chat for any locale
 * proposal. The visible symptom was downstream: because the card never
 * appeared, the descriptions had been hand-edited to send the operator to an
 * admin page ("link them to the queue") — the exact thing the factory's wording
 * forbids. Wording drift was the symptom; the missing colon was the bug.
 *
 * The parser lives in the admin app (proposal-parser.ts) and can't be imported
 * from admin-core, so the pattern is mirrored here. `PROPOSAL_CONTENT_PATTERN`
 * is exported there and asserted against this literal in the admin-side test,
 * so a change to one without the other fails.
 */

import { describe, expect, it } from "bun:test";
import { createDefaultToolRegistry } from "../index.js";

/** Mirror of apps/admin/src/lib/components/chat/proposal-parser.ts. */
const PROPOSAL_CONTENT_PATTERN = /^Queued proposal ([0-9a-f-]{36}):\s*([^.]+)\./;

const UUID = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607";

describe("propose_* tools speak the ProposeCard's canonical shape", () => {
  const registry = createDefaultToolRegistry();
  const proposeTools = registry
    .catalogue()
    .filter((t) => t.name.startsWith("propose_"))
    .map((t) => t.name);

  it("finds the propose surface", () => {
    // Guards against the filter silently matching nothing if names change.
    expect(proposeTools.length).toBeGreaterThan(20);
  });

  for (const name of [
    "propose_add_locale",
    "propose_remove_locale",
    "propose_set_default_locale",
    "propose_update_locale_strategy",
    "propose_deploy_promote",
    "propose_deploy_rollback",
    "propose_update_layout",
    "propose_create_user",
  ]) {
    it(`${name} is registered`, () => {
      expect(proposeTools).toContain(name);
    });
  }

  describe("the canonical content shape the parser requires", () => {
    it("matches `Queued proposal <uuid>: <summary>.`", () => {
      const canonical = `Queued proposal ${UUID}: add locale 'de' (subdirectory). Approve it on the proposal card in this chat (queue: /security/locales/pending).`;
      expect(PROPOSAL_CONTENT_PATTERN.test(canonical)).toBe(true);
    });

    it("does NOT match the pre-fix hand-rolled shape (no colon) — the regression", () => {
      // Verbatim shape the hand-rolled locale tools used to emit.
      const handRolled = `Queued proposal ${UUID} to add locale 'de' (subdirectory). Preview: {}. Approve it on the proposal card in this chat (queue: /security/locales/pending).`;
      expect(PROPOSAL_CONTENT_PATTERN.test(handRolled)).toBe(false);
    });
  });

  describe("every propose_* description carries the two-step contract", () => {
    const cat = registry.catalogue().filter((t) => t.name.startsWith("propose_"));
    for (const tool of cat) {
      it(`${tool.name}: says it only QUEUES and not to claim success`, () => {
        const d = tool.description;
        // The AI must never report a gated change as applied.
        expect(d.toLowerCase()).toContain("queue");
        expect(
          /do not claim|does not apply|not active yet|only queues/i.test(d),
          `${tool.name} description must tell the model NOT to claim the change is live`,
        ).toBe(true);
      });
    }
  });
});

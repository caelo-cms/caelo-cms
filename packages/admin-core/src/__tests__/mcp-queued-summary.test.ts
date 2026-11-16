// SPDX-License-Identifier: MPL-2.0

/**
 * #1591 — the summary a Power-MCP hand-off records keeps what the proposal
 * does and drops how it waits for the click ("Not applied yet — the Owner
 * approves it at …"): the hand-off shows it next to the decided outcome,
 * where that wording is false. One case per way a queued result is worded.
 */

import { describe, expect, it } from "bun:test";
import { queuedProposalSummary } from "../ops/security/mcp_tool_call.js";

const ID = "11111111-2222-4333-8444-555555555555";

describe("queuedProposalSummary", () => {
  it("keeps the summary of a gated tool's result (makeProposeTool) without its approval wording", () => {
    expect(
      queuedProposalSummary(
        `Queued proposal ${ID}: promote staging → production (build=b-1, pages=3, files=12). Not applied yet — the Owner approves it at /settings/deployments/pending.`,
      ),
    ).toBe("promote staging → production (build=b-1, pages=3, files=12)");
  });

  it("does not end the summary at a dot inside an address", () => {
    expect(
      queuedProposalSummary(
        `Queued proposal ${ID}: external redirects: /qr → https://calendar.example.com/book. Not applied yet — the Owner approves it at /settings/redirects.`,
      ),
    ).toBe("external redirects: /qr → https://calendar.example.com/book");
  });

  it("drops the card instructions of Go live now and of a queued plugin tool", () => {
    expect(
      queuedProposalSummary(
        `Queued proposal ${ID}: go live now without Publish live: /a → /b (301). Approve it on the proposal card in this chat (queue: /settings/redirects/pending); approving needs the Publish live permission. Until then the changes stay Staged — do not say they are live.`,
      ),
    ).toBe("go live now without Publish live: /a → /b (301)");
    expect(
      queuedProposalSummary(
        `Queued proposal ${ID}: set_locales (plugin international-site). Waiting for the operator's Approve in the Caelo admin; not applied yet, do not claim it is.`,
      ),
    ).toBe("set_locales (plugin international-site)");
  });

  it("takes the first sentence of a bespoke flow's own wording", () => {
    expect(
      queuedProposalSummary(
        `Queued skill proposal ${ID} (slug=brand-voice). An Owner must accept it at /settings/skills/proposals; after acceptance, the Owner activates the skill separately. The skill is NOT active yet.`,
      ),
    ).toBe(`Queued skill proposal ${ID} (slug=brand-voice)`);
  });
});

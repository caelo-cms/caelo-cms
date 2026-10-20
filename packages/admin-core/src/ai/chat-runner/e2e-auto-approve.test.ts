// SPDX-License-Identifier: MPL-2.0

/** PR #863 (M-11) — the e2e auto-approve switch is dead under production. */

import { describe, expect, it } from "bun:test";
import { isE2eAutoApproveEnabled } from "./e2e-auto-approve.js";

describe("isE2eAutoApproveEnabled", () => {
  it("is on only for the exact flag outside production", () => {
    expect(isE2eAutoApproveEnabled({ CAELO_E2E_AUTO_APPROVE_PROPOSALS: "1" })).toBe(true);
    expect(
      isE2eAutoApproveEnabled({ CAELO_E2E_AUTO_APPROVE_PROPOSALS: "1", NODE_ENV: "test" }),
    ).toBe(true);
    expect(
      isE2eAutoApproveEnabled({ CAELO_E2E_AUTO_APPROVE_PROPOSALS: "1", NODE_ENV: "development" }),
    ).toBe(true);
  });

  it("stays off under NODE_ENV=production whatever the flag says", () => {
    expect(
      isE2eAutoApproveEnabled({ CAELO_E2E_AUTO_APPROVE_PROPOSALS: "1", NODE_ENV: "production" }),
    ).toBe(false);
  });

  it("stays off without the flag or with any other value", () => {
    expect(isE2eAutoApproveEnabled({})).toBe(false);
    expect(isE2eAutoApproveEnabled({ CAELO_E2E_AUTO_APPROVE_PROPOSALS: "true" })).toBe(false);
    expect(isE2eAutoApproveEnabled({ CAELO_E2E_AUTO_APPROVE_PROPOSALS: "0" })).toBe(false);
  });
});

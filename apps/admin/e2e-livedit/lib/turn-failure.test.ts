// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  PROVIDER_ACCOUNT_NOTICE_PREFIX as CORE_PREFIX,
  providerAccountNotice,
} from "../../../../packages/admin-core/src/ai/provider-account-error.js";
import { PROVIDER_ACCOUNT_NOTICE_PREFIX, turnFailureError } from "./turn-failure.js";

const LIMIT =
  "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.";

describe("turnFailureError", () => {
  it("is null when no turn failed", () => {
    expect(turnFailureError([], "build me a homepage")).toBeNull();
  });

  it("quotes the provider message, not a downstream symptom", () => {
    const err = turnFailureError(
      [{ createdAt: "2026-10-13T20:02:10Z", whatHappened: LIMIT }],
      "Build a homepage for a bakery",
    );
    expect(err?.message).toContain(LIMIT);
    expect(err?.message).toContain('"Build a homepage for a bakery"');
    expect(err?.message).toContain("1 AI turn failed: provider error report(s)");
  });

  it("collapses repeated messages and truncates a long prompt", () => {
    const err = turnFailureError(
      [
        { createdAt: "a", whatHappened: LIMIT },
        { createdAt: "b", whatHappened: ` ${LIMIT} ` },
        { createdAt: "c", whatHappened: "Overloaded" },
      ],
      "x".repeat(200),
    );
    const msg = err?.message ?? "";
    expect(msg.split(LIMIT).length - 1).toBe(1);
    expect(msg).toContain("  - Overloaded");
    expect(msg).toContain(`"${"x".repeat(80)}…"`);
  });
});

describe("PROVIDER_ACCOUNT_NOTICE_PREFIX", () => {
  it("is the prefix of the chat-runner's account notices", () => {
    // The scenario query finds account refusals by this prefix; a reworded
    // notice in admin-core must not silently disable the fail-fast check.
    expect(PROVIDER_ACCOUNT_NOTICE_PREFIX).toBe(CORE_PREFIX);
    expect(
      providerAccountNotice({ kind: "quota" }).startsWith(PROVIDER_ACCOUNT_NOTICE_PREFIX),
    ).toBe(true);
    expect(providerAccountNotice({ kind: "auth" }).startsWith(PROVIDER_ACCOUNT_NOTICE_PREFIX)).toBe(
      true,
    );
  });
});

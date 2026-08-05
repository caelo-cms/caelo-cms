// SPDX-License-Identifier: MPL-2.0

/**
 * issue #412 — mint/verify for the server-side screenshot preview token,
 * including the adversarial cases CLAUDE.md §6 requires: expired tokens,
 * cross-page/cross-branch tampering, and forged signatures must all be
 * rejected.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import {
  mintPreviewScreenshotToken,
  PREVIEW_SCREENSHOT_TOKEN_TTL_MS,
  setPreviewScreenshotSecretForTests,
  verifyPreviewScreenshotToken,
} from "../preview-screenshot-token.js";

const PAGE_A = "11111111-1111-4111-8111-111111111111";
const PAGE_B = "22222222-2222-4222-8222-222222222222";
const BRANCH_A = "33333333-3333-4333-8333-333333333333";
const BRANCH_B = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  setPreviewScreenshotSecretForTests(null);
});

describe("mintPreviewScreenshotToken / verifyPreviewScreenshotToken", () => {
  it("round-trips pageId + chatBranchId", () => {
    const token = mintPreviewScreenshotToken({ pageId: PAGE_A, chatBranchId: BRANCH_A });
    const v = verifyPreviewScreenshotToken(token, { expectedPageId: PAGE_A });
    expect(v).toEqual({ ok: true, pageId: PAGE_A, chatBranchId: BRANCH_A });
  });

  it("round-trips a branchless (published-state) token as chatBranchId null", () => {
    const v = verifyPreviewScreenshotToken(mintPreviewScreenshotToken({ pageId: PAGE_A }));
    expect(v).toEqual({ ok: true, pageId: PAGE_A, chatBranchId: null });
  });

  it("rejects an expired token", () => {
    const minted = Date.now() - PREVIEW_SCREENSHOT_TOKEN_TTL_MS - 1;
    const token = mintPreviewScreenshotToken({ pageId: PAGE_A, now: minted });
    const v = verifyPreviewScreenshotToken(token);
    expect(v).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects exactly-at-expiry (>= boundary)", () => {
    const now = Date.now();
    const token = mintPreviewScreenshotToken({ pageId: PAGE_A, now });
    const v = verifyPreviewScreenshotToken(token, {
      now: now + PREVIEW_SCREENSHOT_TOKEN_TTL_MS,
    });
    expect(v).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token minted for another page (page binding)", () => {
    const token = mintPreviewScreenshotToken({ pageId: PAGE_A, chatBranchId: BRANCH_A });
    const v = verifyPreviewScreenshotToken(token, { expectedPageId: PAGE_B });
    expect(v).toEqual({ ok: false, reason: "page-mismatch" });
  });

  it("rejects a payload re-targeted to another branch without re-signing", () => {
    const token = mintPreviewScreenshotToken({ pageId: PAGE_A, chatBranchId: BRANCH_A });
    const [version, payloadB64, sig] = token.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as {
      b: string;
    };
    payload.b = BRANCH_B;
    const forged = `${version}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    expect(verifyPreviewScreenshotToken(forged)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a tampered signature", () => {
    const token = mintPreviewScreenshotToken({ pageId: PAGE_A });
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyPreviewScreenshotToken(flipped)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a token signed with a different key", () => {
    setPreviewScreenshotSecretForTests(randomBytes(32));
    const foreign = mintPreviewScreenshotToken({ pageId: PAGE_A, chatBranchId: BRANCH_A });
    setPreviewScreenshotSecretForTests(randomBytes(32));
    expect(verifyPreviewScreenshotToken(foreign)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects malformed tokens without throwing", () => {
    for (const bad of ["", "garbage", "v1.only-two", "v2.a.b", "v1..sig", "v1.payload."]) {
      const v = verifyPreviewScreenshotToken(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("malformed");
    }
  });

  it("rejects a signed-but-non-JSON payload as malformed, not a crash", () => {
    // A correctly-signed garbage payload exercises the parse guard AFTER
    // the signature check: install a known secret and sign the bytes the
    // same way the minting path would.
    const key = randomBytes(32);
    setPreviewScreenshotSecretForTests(key);
    const payloadB64 = Buffer.from("not json at all", "utf8").toString("base64url");
    const sig = createHmac("sha256", key).update(payloadB64).digest("base64url");
    expect(verifyPreviewScreenshotToken(`v1.${payloadB64}.${sig}`)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { googleSigner } from "../../__tests__/fixtures/google-id-token.js";
import { GOOGLE_JWKS_URL, hasGoogleSignature, loadGoogleKeys } from "./google-keys.js";

describe("Google ID-token signatures", () => {
  it("accepts a token signed by a loaded Google key, and nothing else", async () => {
    const google = await googleSigner();
    await google.install();
    const token = await google.sign({ email: "owner@example.com" });
    expect(await hasGoogleSignature(token)).toBe(true);

    // Payload swapped under the same signature.
    const [h, , sig] = token.split(".");
    const forged = `${h}.${btoa(JSON.stringify({ email: "evil@example.com" })).replace(/=+$/, "")}.${sig}`;
    expect(await hasGoogleSignature(forged)).toBe(false);

    // Another key pair (never published by "Google").
    const impostor = await googleSigner();
    expect(await hasGoogleSignature(await impostor.sign({ email: "owner@example.com" }))).toBe(
      false,
    );
    expect(await hasGoogleSignature("not.a.token")).toBe(false);
  });

  it("fetches only Google's fixed JWKS URL and reports failures", async () => {
    const urls: string[] = [];
    const problem = await loadGoogleKeys(async (url) => {
      urls.push(url);
      return new Response("down", { status: 503 });
    }, "unknown-kid");
    expect(urls).toEqual([GOOGLE_JWKS_URL]);
    expect(problem).toContain("HTTP 503");
    const empty = await loadGoogleKeys(
      async () => new Response(JSON.stringify({ keys: [] }), { status: 200 }),
      "unknown-kid-2",
    );
    expect(empty).toContain("no usable signing keys");
  });
});

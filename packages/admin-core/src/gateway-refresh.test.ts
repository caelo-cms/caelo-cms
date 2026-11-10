// SPDX-License-Identifier: MPL-2.0

/**
 * The ID token of the admin's refresh ping: minted by the metadata server
 * for the gateway's audience, with the account's email, and reused until
 * shortly before it expires.
 */

import { describe, expect, it } from "bun:test";
import { metadataIdTokens } from "./gateway-refresh.js";

function jwtWithExp(exp: number): string {
  const b64u = (s: string) => Buffer.from(s).toString("base64url");
  return `${b64u('{"alg":"RS256"}')}.${b64u(JSON.stringify({ exp }))}.c2ln`;
}

describe("metadataIdTokens", () => {
  it("asks the metadata server for a full token for the audience, and reuses it until it is about to expire", async () => {
    let clock = 1_000_000_000_000;
    const asked: { url: string; flavor: string | null }[] = [];
    const tokens = metadataIdTokens(
      (async (input: string | URL | Request, init?: RequestInit) => {
        asked.push({
          url: String(input),
          flavor: new Headers(init?.headers).get("Metadata-Flavor"),
        });
        return new Response(jwtWithExp(Math.floor(clock / 1000) + 3600));
      }) as typeof fetch,
      () => clock,
    );
    const aud = "https://gateway-refresh.caelo.invalid/production/live";
    const first = await tokens(aud);
    expect(asked).toEqual([
      {
        url: `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(aud)}&format=full`,
        flavor: "Google",
      },
    ]);
    clock += 50 * 60_000;
    expect(await tokens(aud)).toBe(first);
    expect(asked).toHaveLength(1);
    // Within five minutes of its expiry it is minted again.
    clock += 6 * 60_000;
    await tokens(aud);
    expect(asked).toHaveLength(2);
    // Another audience has a token of its own.
    await tokens("https://gateway-refresh.caelo.invalid/production/staging");
    expect(asked).toHaveLength(3);
  });

  it("fails loudly when the metadata server refuses, and does not cache a token it cannot date", async () => {
    const refusing = metadataIdTokens(
      (async () => new Response("no", { status: 404 })) as unknown as typeof fetch,
    );
    await expect(refusing("aud")).rejects.toThrow("the metadata server answered HTTP 404");
    let calls = 0;
    const undated = metadataIdTokens((async () => {
      calls += 1;
      return new Response("opaque-token");
    }) as unknown as typeof fetch);
    expect(await undated("aud")).toBe("opaque-token");
    await undated("aud");
    expect(calls).toBe(2);
  });
});

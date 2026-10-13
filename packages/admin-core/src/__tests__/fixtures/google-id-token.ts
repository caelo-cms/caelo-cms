// SPDX-License-Identifier: MPL-2.0

/**
 * Test stand-in for Google's ID-token signer (#696 step-up): a fresh RSA key
 * pair, a JWKS "endpoint" serving its public half, and RS256-signed tokens —
 * so tests exercise the real signature check in step_up.record.
 */

import { GOOGLE_JWKS_URL, loadGoogleKeys } from "../../security/step-up/google-keys.js";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const json = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

/** A signer with its own key id; `install()` loads its key as Google's. */
export async function googleSigner(kid = `test-${crypto.randomUUID()}`) {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwks = { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };
  return {
    /** A fetch answering Google's JWKS URL with this key. */
    fetch: async (url: string) =>
      url === GOOGLE_JWKS_URL
        ? new Response(JSON.stringify(jwks), { status: 200 })
        : new Response("not found", { status: 404 }),
    /** Load this key into the step-up op's key cache. */
    async install(): Promise<void> {
      const problem = await loadGoogleKeys(this.fetch, kid);
      if (problem) throw new Error(problem);
    },
    /** An RS256 ID token over `claims`. */
    async sign(claims: Record<string, unknown>): Promise<string> {
      const signingInput = `${json({ alg: "RS256", kid, typ: "JWT" })}.${json(claims)}`;
      const sig = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(signingInput),
      );
      return `${signingInput}.${b64url(new Uint8Array(sig))}`;
    },
  };
}

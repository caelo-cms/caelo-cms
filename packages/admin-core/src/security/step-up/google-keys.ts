// SPDX-License-Identifier: MPL-2.0

/**
 * Google's ID-token signing keys, so the step-up op itself can check that
 * an ID token was signed by Google (epic #696).
 *
 * Why the op checks the signature even though the callback receives the
 * token over TLS from Google's token endpoint: the op is the trust boundary
 * (security/step-up/gate.ts). With the signature checked there, no caller —
 * however it reaches the op — can assert a sign-in without a token Google
 * signed for this install's client, this challenge's nonce and the user's
 * address.
 *
 * Keys come only from Google's fixed JWKS URL. They are fetched outside any
 * transaction ({@link loadGoogleKeys}, called by the callback before it runs
 * the op) and cached per process; the op only reads the cache.
 */

/** Google's published ID-token signing keys (fixed; never configurable). */
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/** How long fetched keys are trusted before the next fetch (Google rotates daily-ish). */
const KEYS_MAX_AGE_MS = 60 * 60 * 1000;

interface Jwk {
  readonly kid?: string;
  readonly kty?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
}

let cache: { keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

const ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/**
 * Fetch Google's signing keys into the process cache, unless fresh ones are
 * there and `kid` (when given) is among them. Never throws.
 *
 * @returns null on success, else why the keys could not be loaded
 */
export async function loadGoogleKeys(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  kid?: string,
  now: number = Date.now(),
): Promise<string | null> {
  if (cache && now - cache.fetchedAt < KEYS_MAX_AGE_MS && (!kid || cache.keys.has(kid))) {
    return null;
  }
  try {
    const res = await fetchFn(GOOGLE_JWKS_URL, { method: "GET" });
    if (!res.ok) return `Google's signing keys could not be fetched (HTTP ${res.status})`;
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = new Map<string, CryptoKey>();
    for (const k of body.keys ?? []) {
      if (!k.kid || k.kty !== "RSA" || (k.alg && k.alg !== "RS256") || !k.n || !k.e) continue;
      keys.set(
        k.kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true },
          ALGORITHM,
          false,
          ["verify"],
        ),
      );
    }
    if (keys.size === 0) return "Google published no usable signing keys";
    cache = { keys, fetchedAt: now };
    return null;
  } catch (e) {
    return `Google's signing keys could not be fetched (${e instanceof Error ? e.message : String(e)})`;
  }
}

function b64urlBytes(part: string): Uint8Array {
  const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The `kid` an ID token names in its header, or null. */
export function idTokenKeyId(idToken: string): string | null {
  try {
    const header = JSON.parse(
      new TextDecoder().decode(b64urlBytes(idToken.split(".")[0] ?? "")),
    ) as {
      kid?: unknown;
      alg?: unknown;
    };
    return header.alg === "RS256" && typeof header.kid === "string" ? header.kid : null;
  } catch {
    return null;
  }
}

/**
 * Whether `idToken` carries a valid RS256 signature by one of the cached
 * Google keys. Reads the cache only (no network).
 */
export async function hasGoogleSignature(idToken: string): Promise<boolean> {
  const parts = idToken.split(".");
  const kid = idTokenKeyId(idToken);
  const key = kid ? cache?.keys.get(kid) : undefined;
  if (parts.length !== 3 || !key) return false;
  try {
    return await crypto.subtle.verify(
      ALGORITHM,
      key,
      b64urlBytes(parts[2] as string) as BufferSource,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`) as BufferSource,
    );
  } catch {
    return false;
  }
}

// SPDX-License-Identifier: MPL-2.0

/**
 * P15.1 — auth for /api/internal/* endpoints.
 *
 * Internal endpoints are reachable from infrastructure tooling that
 * doesn't have a logged-in user session: Pulumi post-deploy hooks
 * pushing provisioning outputs, the `cms-provision pulumi-output-sync`
 * subcommand syncing from a CI pipeline, future cluster-internal
 * orchestration. The Query API ops backing each endpoint are already
 * `actorScope: ["system"]` — RLS at the DB layer is the last line of
 * defence — but the HTTP boundary needs an auth contract that's:
 *  - one shared scheme across every /api/internal/* endpoint,
 *  - token-bearer (no cookies → no CSRF),
 *  - short-lived (Pulumi mints fresh on every deploy; replay window ~5m),
 *  - HMAC-signed against a shared secret that lives in the same
 *    secret store as `caelo.cookie-secret` etc. (`process.env.CAELO_INTERNAL_SECRET`).
 *
 * Format: HMAC-SHA256 over `"<iat>:<exp>:<scope>"`, base64url'd. Three
 * fields, three colons. Pulumi sets `iat` = now, `exp` = now+5min,
 * `scope` = the endpoint name (e.g. `"provisioning-outputs.sync"`).
 *
 * Why not standard JWT (jose lib)? JWT spec carries algorithm-confusion
 * footguns (`alg: none` historic CVE) + unnecessary surface (kid,
 * algs, headers). This is a single-issuer, single-verifier,
 * single-algorithm contract; a 30-line HMAC envelope is correct +
 * easier to audit.
 */

const SECRET_ENV = "CAELO_INTERNAL_SECRET";
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const ENCODING: BufferEncoding = "base64url";

export interface InternalTokenPayload {
  /** Issued-at, milliseconds since epoch. */
  readonly iat: number;
  /** Expiry, milliseconds since epoch. Verifier rejects if past. */
  readonly exp: number;
  /** Endpoint name the token authorises. Verifier rejects on mismatch. */
  readonly scope: string;
}

function getSecret(): string {
  const s = process.env[SECRET_ENV];
  if (!s || s.length < 32) {
    throw new Error(
      `${SECRET_ENV} not set or too short (need ≥32 chars). Required for /api/internal/*. ` +
        `cms-provision init writes one to .caelo/internal-secret.json on first install; ` +
        `cloud installs read from the secret store via the Pulumi outputs.`,
    );
  }
  return s;
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Buffer.from(sig).toString(ENCODING);
}

/**
 * Mint a token. Used by the Pulumi post-deploy `cms-provision
 * pulumi-output-sync` subcommand and by tests. Not normally called
 * from the admin process.
 */
export async function signInternalToken(payload: InternalTokenPayload): Promise<string> {
  const message = `${payload.iat}:${payload.exp}:${payload.scope}`;
  const sig = await hmac(getSecret(), message);
  return `${Buffer.from(message).toString(ENCODING)}.${sig}`;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly reason?:
    | "missing-secret"
    | "malformed"
    | "bad-signature"
    | "expired"
    | "future-iat"
    | "scope-mismatch";
  readonly payload?: InternalTokenPayload;
}

/**
 * Verify a token. Used by every /api/internal/* +server.ts endpoint
 * via `requireInternalAuth(event, "<scope>")`.
 */
export async function verifyInternalToken(
  token: string,
  expectedScope: string,
): Promise<VerifyResult> {
  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return { ok: false, reason: "missing-secret" };
  }
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const messageB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const message = Buffer.from(messageB64, ENCODING).toString("utf8");
  // Constant-time comparison via re-signing.
  const recomputed = await hmac(secret, message);
  if (!constantTimeEquals(sig, recomputed)) {
    return { ok: false, reason: "bad-signature" };
  }
  const parts = message.split(":");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const iat = Number.parseInt(parts[0] ?? "", 10);
  const exp = Number.parseInt(parts[1] ?? "", 10);
  const scope = parts[2] ?? "";
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) {
    return { ok: false, reason: "malformed" };
  }
  const now = Date.now();
  if (now > exp) return { ok: false, reason: "expired" };
  // Allow ~30s clock skew on the future side; reject anything further
  // (an iat far in the future is more likely a replay-with-skewed-clock
  // than a legitimate token).
  if (iat > now + 30_000) return { ok: false, reason: "future-iat" };
  // Hard-cap the issued-at to the replay window so a leaked token
  // can't sit unused for hours then be replayed within its `exp`.
  if (now - iat > REPLAY_WINDOW_MS) return { ok: false, reason: "expired" };
  if (scope !== expectedScope) return { ok: false, reason: "scope-mismatch" };
  return { ok: true, payload: { iat, exp, scope } };
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Extract + verify the bearer token from a SvelteKit request. Throws a
 * 401 Response if missing/invalid. Caller is expected to `throw` the
 * result inside a +server.ts handler.
 */
export async function requireInternalAuth(
  request: Request,
  expectedScope: string,
): Promise<InternalTokenPayload> {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) {
    throw new Response(JSON.stringify({ ok: false, error: "missing-bearer" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const r = await verifyInternalToken(m[1] ?? "", expectedScope);
  if (!r.ok) {
    throw new Response(JSON.stringify({ ok: false, error: r.reason }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return r.payload as InternalTokenPayload;
}

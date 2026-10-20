// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — verification of Google IAP's signed request header
 * (`x-goog-iap-jwt-assertion`), the identity of a remote MCP request.
 *
 * Remote MCP clients reach the admin through IAP with the user's own Google
 * token; IAP authenticates them and stamps every request it lets through
 * with an ES256 JWT naming the user. That JWT — not any header a client
 * could set — is the identity the remote MCP endpoints trust. Verification
 * follows Google's documented recipe: signature against IAP's published
 * keys, `iss` = `https://cloud.google.com/iap`, `aud` = this backend's
 * audience (`CAELO_IAP_AUDIENCE`), `exp`/`iat` within a 30 s skew.
 *
 * The signature check is google-auth-library's
 * `verifySignedJwtWithCertsAsync` (no hand-rolled crypto). The library's own
 * clock check allows 300 s of skew; the tighter 30 s window is applied on
 * top of it as plain arithmetic on the already-verified claims.
 *
 * Fail loudly, never fall back (CLAUDE.md §2): an unset audience is a
 * configuration error reported as `not_configured`, never "skip the check".
 * Error results never carry the assertion itself — it is a credential.
 */

import { OAuth2Client } from "google-auth-library";

/** The request header IAP signs every forwarded request with. */
export const IAP_ASSERTION_HEADER = "x-goog-iap-jwt-assertion";

/** The only issuer IAP signs with. */
export const IAP_ISSUER = "https://cloud.google.com/iap";

/** Max clock difference tolerated on `iat` / `exp`, in seconds. */
export const IAP_CLOCK_SKEW_SECONDS = 30;

/** How long fetched IAP keys are reused before a refetch. */
const KEY_CACHE_MS = 60 * 60_000;

/** `kid` → PEM-encoded public key, the shape IAP publishes. */
export type IapPublicKeys = Readonly<Record<string, string>>;

/**
 * Supplies IAP's public keys. `forceRefresh` is set when an assertion names
 * a `kid` the cached set lacks (Google rotated its keys).
 */
export type IapKeyProvider = (opts: { readonly forceRefresh: boolean }) => Promise<IapPublicKeys>;

/** A verified IAP identity. */
export interface IapIdentity {
  /** The Google account's email, as IAP asserts it. */
  readonly email: string;
  /** IAP's stable subject (`accounts.google.com:<id>`). */
  readonly subject: string;
}

/**
 * Why a request has no verified identity:
 * - `not_configured` — `CAELO_IAP_AUDIENCE` is unset: remote MCP is not set up.
 * - `missing` — no assertion header (the request did not come through IAP).
 * - `invalid` — malformed, wrongly signed, expired, wrong `iss` / `aud`, or
 *   without an email. `detail` says which, for logs; never the token.
 */
export type IapVerificationFailure =
  | { readonly kind: "not_configured"; readonly message: string }
  | { readonly kind: "missing"; readonly message: string }
  | { readonly kind: "invalid"; readonly message: string; readonly detail: string };

export type IapVerificationResult =
  | { readonly ok: true; readonly identity: IapIdentity }
  | { readonly ok: false; readonly error: IapVerificationFailure };

export interface IapVerifierDeps {
  /** The expected `aud`; read per call so a changed env needs no restart in tests. */
  readonly audience?: () => string | undefined;
  readonly keys?: IapKeyProvider;
  /** Seconds since the epoch. */
  readonly now?: () => number;
}

/** A verifier bound to its key source and audience. */
export type IapVerifier = (assertion: string | null | undefined) => Promise<IapVerificationResult>;

/**
 * IAP's published keys, fetched through google-auth-library and cached for
 * an hour; a forced refresh (unknown `kid`) refetches at once.
 */
export function googleIapKeyProvider(client: OAuth2Client = new OAuth2Client()): IapKeyProvider {
  let cached: { keys: IapPublicKeys; fetchedAt: number } | null = null;
  return async ({ forceRefresh }) => {
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < KEY_CACHE_MS) {
      return cached.keys;
    }
    const { pubkeys } = await client.getIapPublicKeysAsync();
    cached = { keys: pubkeys as unknown as IapPublicKeys, fetchedAt: Date.now() };
    return cached.keys;
  };
}

/** The `kid` of a compact JWS header, or null when it cannot be read. */
function headerKid(assertion: string): string | null {
  const [header] = assertion.split(".");
  if (!header) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as {
      kid?: unknown;
    };
    return typeof parsed.kid === "string" ? parsed.kid : null;
  } catch {
    return null;
  }
}

const NOT_CONFIGURED_MESSAGE =
  "Remote MCP is not set up on this site: CAELO_IAP_AUDIENCE is not configured on the admin. An Owner enables remote MCP under Settings → MCP.";

/** Build a verifier. Production uses the defaults; tests inject keys + clock. */
export function createIapVerifier(deps: IapVerifierDeps = {}): IapVerifier {
  const audienceOf = deps.audience ?? (() => process.env.CAELO_IAP_AUDIENCE);
  const keys = deps.keys ?? googleIapKeyProvider();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const client = new OAuth2Client();

  const invalid = (detail: string): IapVerificationResult => ({
    ok: false,
    error: {
      kind: "invalid",
      message:
        "The request's IAP identity could not be verified. Reconnect the MCP client so it signs in with Google again.",
      detail,
    },
  });

  return async (assertion) => {
    const audience = audienceOf()?.trim();
    if (!audience) {
      return { ok: false, error: { kind: "not_configured", message: NOT_CONFIGURED_MESSAGE } };
    }
    if (!assertion) {
      return {
        ok: false,
        error: {
          kind: "missing",
          message: `No ${IAP_ASSERTION_HEADER} header: remote MCP requests must reach the admin through Google IAP.`,
        },
      };
    }
    const kid = headerKid(assertion);
    if (!kid) return invalid("unreadable JWT header or missing kid");

    let certs: IapPublicKeys;
    try {
      certs = await keys({ forceRefresh: false });
      if (!Object.hasOwn(certs, kid)) certs = await keys({ forceRefresh: true });
    } catch (e) {
      return invalid(`IAP public keys unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!Object.hasOwn(certs, kid)) return invalid("signed with a key IAP does not publish");

    let payload: Record<string, unknown> | undefined;
    try {
      const ticket = await client.verifySignedJwtWithCertsAsync(
        assertion,
        // The library types certs as its Certificates map; IAP's PEM map is that shape.
        certs as unknown as Parameters<OAuth2Client["verifySignedJwtWithCertsAsync"]>[1],
        audience,
        [IAP_ISSUER],
      );
      payload = ticket.getPayload() as Record<string, unknown> | undefined;
    } catch (e) {
      // The library's messages embed the token; keep only the reason.
      const message = e instanceof Error ? e.message : String(e);
      return invalid(message.split(":")[0]?.slice(0, 120) ?? "verification failed");
    }
    if (!payload) return invalid("no payload");

    const t = now();
    const iat = Number(payload.iat);
    const exp = Number(payload.exp);
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return invalid("iat/exp not numeric");
    if (exp + IAP_CLOCK_SKEW_SECONDS < t) return invalid("expired");
    if (iat - IAP_CLOCK_SKEW_SECONDS > t) return invalid("issued in the future");

    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    if (!email) return invalid("no email claim");
    return { ok: true, identity: { email, subject } };
  };
}

let processVerifier: IapVerifier | null = null;

/** The process-wide verifier (env audience, Google's keys). */
export function iapVerifier(): IapVerifier {
  processVerifier ??= createIapVerifier();
  return processVerifier;
}

/**
 * Test seam: replace the process-wide verifier (route and op tests inject
 * generated keys); `null` restores the default on next use.
 */
export function setIapVerifierForTests(verifier: IapVerifier | null): void {
  processVerifier = verifier;
}

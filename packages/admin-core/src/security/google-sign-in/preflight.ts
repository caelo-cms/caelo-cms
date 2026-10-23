// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #967 — check a Google sign-in client against Google BEFORE anything
 * is stored or handed to IAP.
 *
 * IAP sessions are bound to the OAuth client, so switching IAP to a new
 * client signs everybody out, and a client that is missing IAP's redirect
 * URI keeps everybody out (IAP error code 9, "Failed OAuth redirect"). The
 * client itself is console-only (Google offers no API to create or read it),
 * but Google's public OAuth endpoints answer three questions without any
 * credential of ours and without changing anything:
 *
 *   - Is redirect URI X registered on client C? A GET of the authorize
 *     endpoint, redirects NOT followed. Registered: 302 to the sign-in page
 *     (`/v3/signin/identifier`). Not registered: 302 to
 *     `/signin/oauth/error` whose `authError` parameter (base64url protobuf,
 *     field 1 = the OAuth error code) says `redirect_uri_mismatch`. An
 *     unknown client says `invalid_client` there.
 *   - Do client ID and secret belong together? A POST to the token endpoint
 *     with a dummy authorization code. Client authentication runs first:
 *     a wrong secret or client answers 401 `invalid_client`; a valid pair
 *     gets as far as the code and answers 400 `invalid_grant`.
 *   - Is the consent screen External + In production? NOT detectable:
 *     the signed-out authorize answer is the same sign-in page either way
 *     (Google enforces the audience only after an account is chosen), and
 *     the IAP OAuth Admin API that exposed `orgInternalOnly` was shut down
 *     on 2026-03-19. The Owner confirms it explicitly instead.
 *
 * The answers above were observed live on 2026-10-21 and are recorded in
 * `recorded-google-oauth.json`; the unit tests classify exactly
 * those responses. Anything Caelo does not recognise is a failure, never a
 * pass (CLAUDE.md §2): a check that cannot say "registered" blocks the switch.
 */

import { iapRedirectUri, oauthClientConsoleUrl } from "@caelo-cms/shared";

export { oauthClientConsoleUrl };

/** Google's OAuth 2.0 authorize endpoint (the browser leg of sign-in). */
export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** Google's OAuth 2.0 token endpoint. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** What the authorize endpoint said about one (client, redirect URI) pair. */
export type RedirectUriVerdict =
  | { readonly kind: "registered" }
  | { readonly kind: "not-registered" }
  | { readonly kind: "unknown-client" }
  /** Google refused the request for another OAuth reason (`code`). */
  | { readonly kind: "refused"; readonly code: string; readonly message: string }
  /** An answer Caelo does not recognise, or no answer at all. */
  | { readonly kind: "unexpected"; readonly detail: string };

/** What the token endpoint said about a (client ID, secret) pair. */
export type ClientSecretVerdict =
  | { readonly kind: "valid" }
  | { readonly kind: "wrong-secret" }
  | { readonly kind: "unknown-client" }
  | { readonly kind: "unauthorized-client"; readonly message: string }
  | { readonly kind: "unexpected"; readonly detail: string };

/** Paths of Google's sign-in page a registered redirect URI leads to. */
const SIGN_IN_PATHS = [
  /^\/v3\/signin\/identifier$/,
  /^\/signin\/v2\/identifier$/,
  /^\/ServiceLogin$/,
];
const ERROR_PATH = /^\/signin\/oauth\/error$/;

/** Read one protobuf varint at `at`; `[value, next offset]`, or null past the end. */
function varint(bytes: Uint8Array, at: number): [number, number] | null {
  let value = 0;
  let shift = 0;
  let i = at;
  while (i < bytes.length && shift < 35) {
    const b = bytes[i] as number;
    value += (b & 0x7f) * 2 ** shift;
    i += 1;
    if ((b & 0x80) === 0) return [value, i];
    shift += 7;
  }
  return null;
}

/**
 * Decode the `authError` parameter of Google's OAuth error page: a base64url
 * protobuf whose field 1 is the OAuth error code (`redirect_uri_mismatch`,
 * `invalid_client`, …) and field 2 a localised message. Null when it is not
 * that shape.
 */
export function decodeAuthError(raw: string): { code: string; message: string } | null {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(raw, "base64url"));
  } catch {
    return null;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let code = "";
  let message = "";
  let at = 0;
  while (at < bytes.length) {
    const tag = varint(bytes, at);
    if (!tag) return null;
    const [key, next] = tag;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    at = next;
    if (wire === 0) {
      const v = varint(bytes, at);
      if (!v) return null;
      at = v[1];
    } else if (wire === 2) {
      const len = varint(bytes, at);
      if (!len) return null;
      const end = len[1] + len[0];
      if (end > bytes.length) return null;
      const text = decoder.decode(bytes.subarray(len[1], end));
      if (field === 1 && !code) code = text;
      if (field === 2 && !message) message = text;
      at = end;
    } else {
      // Only varint and length-delimited fields occur; anything else is not this shape.
      break;
    }
  }
  return /^[a-z_]+$/.test(code) ? { code, message: message.trim() } : null;
}

/**
 * Classify the authorize endpoint's answer to a GET without following
 * redirects. Only a redirect to Google's sign-in page counts as registered.
 */
export function classifyAuthorizeResponse(
  status: number,
  location: string | null,
): RedirectUriVerdict {
  if (status < 300 || status >= 400 || !location) {
    return { kind: "unexpected", detail: `HTTP ${status} without a redirect` };
  }
  let target: URL;
  try {
    target = new URL(location, GOOGLE_AUTHORIZE_URL);
  } catch {
    return { kind: "unexpected", detail: `HTTP ${status} to an unreadable location` };
  }
  if (target.hostname !== "accounts.google.com") {
    return { kind: "unexpected", detail: `HTTP ${status} to ${target.origin}` };
  }
  if (ERROR_PATH.test(target.pathname)) {
    const raw = target.searchParams.get("authError");
    const error = raw ? decodeAuthError(raw) : null;
    if (!error)
      return { kind: "unexpected", detail: "Google's error page without a readable error" };
    if (error.code === "redirect_uri_mismatch") return { kind: "not-registered" };
    if (error.code === "invalid_client") return { kind: "unknown-client" };
    return { kind: "refused", code: error.code, message: error.message };
  }
  if (SIGN_IN_PATHS.some((p) => p.test(target.pathname)) && !target.searchParams.has("authError")) {
    return { kind: "registered" };
  }
  return { kind: "unexpected", detail: `HTTP ${status} to ${target.origin}${target.pathname}` };
}

/** Classify the token endpoint's answer to the dummy-code exchange. */
export function classifyTokenResponse(status: number, body: string): ClientSecretVerdict {
  let parsed: { error?: unknown; error_description?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { kind: "unexpected", detail: `HTTP ${status} with a body that is not JSON` };
  }
  const error = typeof parsed.error === "string" ? parsed.error : "";
  const description = typeof parsed.error_description === "string" ? parsed.error_description : "";
  if (status === 400 && error === "invalid_grant") return { kind: "valid" };
  if (error === "invalid_client") {
    // Recorded: "The OAuth client was not found." / "The provided client secret is invalid."
    return /not found/i.test(description) ? { kind: "unknown-client" } : { kind: "wrong-secret" };
  }
  if (error === "unauthorized_client") {
    return { kind: "unauthorized-client", message: description };
  }
  return {
    kind: "unexpected",
    detail: `HTTP ${status}${error ? ` ${error}` : ""}${description ? `: ${description}` : ""}`,
  };
}

export interface PreflightDeps {
  readonly fetch: typeof fetch;
}

const TIMEOUT_MS = 10_000;

/** Ask Google whether `redirectUri` is registered on `clientId` (GET, redirects not followed). */
export async function probeRedirectUri(
  deps: PreflightDeps,
  clientId: string,
  redirectUri: string,
): Promise<RedirectUriVerdict> {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  // English error messages, whatever the egress IP's country.
  url.searchParams.set("hl", "en");
  try {
    const res = await deps.fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return classifyAuthorizeResponse(res.status, res.headers.get("location"));
  } catch (e) {
    return { kind: "unexpected", detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Ask Google whether `clientSecret` is `clientId`'s, by exchanging a code
 * that cannot exist. Nothing is issued either way. `redirectUri` is IAP's
 * (already verified as registered when this runs).
 */
export async function probeClientSecret(
  deps: PreflightDeps,
  clientId: string,
  clientSecret: string,
): Promise<ClientSecretVerdict> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: "caelo-preflight-not-a-code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: iapRedirectUri(clientId),
  });
  try {
    const res = await deps.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return classifyTokenResponse(res.status, await res.text());
  } catch (e) {
    return { kind: "unexpected", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** One line of the preflight, in the same shape the self-check shows. */
export interface PreflightLine {
  readonly id: "redirect-uri-broker" | "redirect-uri-iap" | "client-secret" | "consent-screen";
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly nextStep?: string;
}

const NOTHING_CHANGED = "Nothing was stored and Google IAP was not touched.";

/** A redirect-URI verdict as a preflight line with the exact fix. */
export function redirectUriLine(
  id: "redirect-uri-broker" | "redirect-uri-iap",
  uri: string,
  verdict: RedirectUriVerdict,
  clientConsoleUrl: string,
): PreflightLine {
  const label =
    id === "redirect-uri-iap"
      ? "Redirect URI 2 (Google IAP) is on the client"
      : "Redirect URI 1 (remote MCP) is on the client";
  const which =
    id === "redirect-uri-iap" ? "Redirect URI 2 (Google IAP)" : "Redirect URI 1 (remote MCP)";
  switch (verdict.kind) {
    case "registered":
      return { id, label, ok: true, detail: uri };
    case "not-registered":
      return {
        id,
        label,
        ok: false,
        detail: `Google does not know ${uri} as a redirect URI of this client (redirect_uri_mismatch).${id === "redirect-uri-iap" ? " With this client, every sign-in to the admin would fail with IAP error code 9." : ""}`,
        nextStep: `Open the client in the Google console (${clientConsoleUrl}), under "Authorized redirect URIs" click Add URI, paste ${which} exactly — ${uri} — and click Save. Google can take a few minutes to apply it; then check again.`,
      };
    case "unknown-client":
      return {
        id,
        label,
        ok: false,
        detail: "Google knows no OAuth client with this client ID (invalid_client).",
        nextStep:
          "Copy the client ID again from the Google console's client list (the whole value, ending in .apps.googleusercontent.com) and check again. A client deleted in the console cannot be used.",
      };
    case "refused":
      return {
        id,
        label,
        ok: false,
        detail: `Google refused ${uri} for this client: ${verdict.code}${verdict.message ? ` — ${verdict.message}` : ""}`,
        nextStep: `Check that the client is a "Web application" client and that ${which} is pasted exactly, then check again.`,
      };
    case "unexpected":
      return {
        id,
        label,
        ok: false,
        detail: `Caelo could not tell whether ${uri} is registered: ${verdict.detail}`,
        nextStep:
          "Check again in a moment. If it keeps failing, report it with `bug_report` — Caelo never switches to a client it could not verify.",
      };
  }
}

/** A client-secret verdict as a preflight line with the exact fix. */
export function clientSecretLine(
  verdict: ClientSecretVerdict,
  clientConsoleUrl: string,
): PreflightLine {
  const id = "client-secret" as const;
  const label = "Client ID and secret belong together";
  switch (verdict.kind) {
    case "valid":
      return { id, label, ok: true, detail: "Google accepted the pair" };
    case "wrong-secret":
      return {
        id,
        label,
        ok: false,
        detail: "Google refused the client secret for this client ID (invalid_client).",
        nextStep: `Paste the secret of THIS client: open it in the Google console (${clientConsoleUrl}), under "Client secrets" copy the secret (or click Add secret if it is no longer shown), paste it here and check again.`,
      };
    case "unknown-client":
      return {
        id,
        label,
        ok: false,
        detail: "Google knows no OAuth client with this client ID (invalid_client).",
        nextStep: "Copy the client ID again from the Google console's client list and check again.",
      };
    case "unauthorized-client":
      return {
        id,
        label,
        ok: false,
        detail: `Google does not let this client sign people in (unauthorized_client)${verdict.message ? `: ${verdict.message}` : ""}.`,
        nextStep:
          'Create the client with Application type "Web application" (other types cannot be used by Google IAP), then paste its ID and secret here.',
      };
    case "unexpected":
      return {
        id,
        label,
        ok: false,
        detail: `Caelo could not verify the secret: ${verdict.detail}`,
        nextStep:
          "Check again in a moment. If it keeps failing, report it with `bug_report` — Caelo never switches to a client it could not verify.",
      };
  }
}

export interface PreflightInput {
  readonly projectId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly brokerRedirectUri: string;
  /** The Owner ticked "the consent screen is External and In production" (not checkable, see above). */
  readonly consentConfirmed: boolean;
}

/** The preflight's outcome: every line, and whether the client may be stored. */
export interface PreflightResult {
  readonly ok: boolean;
  readonly lines: PreflightLine[];
}

/**
 * Run every check, in the order the Owner fixes things: both redirect URIs
 * (in parallel), then the secret — whose probe names IAP's redirect URI, so
 * it only runs once that one is registered — then the consent-screen
 * confirmation.
 */
export async function runClientPreflight(
  deps: PreflightDeps,
  input: PreflightInput,
): Promise<PreflightResult> {
  const consoleUrl = oauthClientConsoleUrl(input.projectId, input.clientId);
  const iapUri = iapRedirectUri(input.clientId);
  const [broker, iap] = await Promise.all([
    probeRedirectUri(deps, input.clientId, input.brokerRedirectUri),
    probeRedirectUri(deps, input.clientId, iapUri),
  ]);
  const lines: PreflightLine[] = [
    redirectUriLine("redirect-uri-broker", input.brokerRedirectUri, broker, consoleUrl),
    redirectUriLine("redirect-uri-iap", iapUri, iap, consoleUrl),
  ];
  if (iap.kind === "registered") {
    lines.push(
      clientSecretLine(
        await probeClientSecret(deps, input.clientId, input.clientSecret),
        consoleUrl,
      ),
    );
  } else {
    lines.push({
      id: "client-secret",
      label: "Client ID and secret belong together",
      ok: false,
      detail: "not checked yet: Google checks the secret against IAP's redirect URI",
      nextStep: "Add Redirect URI 2 first (see above), then check again.",
    });
  }
  lines.push(
    input.consentConfirmed
      ? {
          id: "consent-screen",
          label: "Consent screen: External, In production",
          ok: true,
          detail: "confirmed by you — Google offers no way to check this from outside the console",
        }
      : {
          id: "consent-screen",
          label: "Consent screen: External, In production",
          ok: false,
          detail: "not confirmed. Google offers no way to check this from outside the console.",
          nextStep:
            'Open the consent screen settings (step 1), set User type to External and Publishing status to In production ("Publish app"), then tick the confirmation and check again.',
        },
  );
  return { ok: lines.every((l) => l.ok), lines };
}

/** The preflight's failures as one error + next step (for the AI-free form result and logs). */
export function preflightFailureSummary(result: PreflightResult): {
  error: string;
  nextStep: string;
} {
  const failed = result.lines.filter((l) => !l.ok);
  return {
    error: `The client did not pass the checks: ${failed.map((l) => l.detail).join(" ")} ${NOTHING_CHANGED}`,
    nextStep: failed
      .map((l) => l.nextStep)
      .filter((s): s is string => Boolean(s))
      .join(" "),
  };
}

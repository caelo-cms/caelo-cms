// SPDX-License-Identifier: MPL-2.0

/**
 * IAP ingress for GCP installs (issue #37).
 *
 * On `gcp` / `gcp-firebase` installs the admin app sits behind Google
 * Identity-Aware Proxy. IAP rejects every request that doesn't carry a
 * Google-signed credential BEFORE Caelo's own `x-caelo-mcp-token` check
 * runs, so the shim has to satisfy both gates: IAP first, Caelo second
 * (CLAUDE.md §11.B — IAP stays the first line of defense).
 *
 * Cloud Run native IAP uses a Google-managed OAuth client, which does not
 * allow programmatic access with user tokens. What it does accept is a
 * JWT signed by an allowlisted service account (Google's documented
 * "service account JWT" path): `iss`/`sub` = the SA, `aud` = the admin
 * origin with a path wildcard, signed via the IAM Credentials `signJwt`
 * API. The provisioner creates that SA (`caelo-mcp@<project>`), allowlists
 * it on IAP and lets every IAP-allowlisted operator impersonate it, so the
 * operator's own `gcloud auth application-default login` is all the shim
 * needs — no service-account keys on laptops (CLAUDE.md §11.C).
 *
 * Active only when `CAELO_IAP_SERVICE_ACCOUNT` is set (the admin's
 * /security/mcp page puts it into the `claude mcp add` command on IAP
 * installs); otherwise requests go out exactly as before.
 */

import { GoogleAuth } from "google-auth-library";

/** Signed JWTs live at most 1 hour; refresh a minute before expiry. */
const TOKEN_LIFETIME_S = 3600;
const REFRESH_MARGIN_S = 60;

export interface IngressAuth {
  /** Extra request headers that get the request through IAP. */
  headers(): Promise<Record<string, string>>;
  readonly serviceAccount: string;
}

export interface IngressAuthDeps {
  /** OAuth access token of the operator's Application Default Credentials. */
  getAccessToken?: () => Promise<string>;
  fetch?: typeof fetch;
  /** Seconds since epoch. */
  now?: () => number;
}

/** `https://admin.example.com/anything` → `https://admin.example.com/*` (the JWT `aud`). */
export function iapAudience(adminUrl: string): string {
  return `${new URL(adminUrl).origin}/*`;
}

async function adcAccessToken(): Promise<string> {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const token = await auth.getAccessToken();
  if (!token) throw new Error("Application Default Credentials returned no access token");
  return token;
}

export function createIngressAuth(
  env: { readonly CAELO_IAP_SERVICE_ACCOUNT?: string; readonly CAELO_ADMIN_URL?: string },
  deps: IngressAuthDeps = {},
): IngressAuth | null {
  const configured = env.CAELO_IAP_SERVICE_ACCOUNT?.trim();
  if (!configured) return null;
  const serviceAccount: string = configured;
  if (!env.CAELO_ADMIN_URL)
    throw new Error("CAELO_IAP_SERVICE_ACCOUNT is set but CAELO_ADMIN_URL is not");
  const audience = iapAudience(env.CAELO_ADMIN_URL);
  const getAccessToken = deps.getAccessToken ?? adcAccessToken;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  let cached: { jwt: string; exp: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    const iat = now();
    const exp = iat + TOKEN_LIFETIME_S;
    let accessToken: string;
    try {
      accessToken = await getAccessToken();
    } catch (e) {
      throw new Error(
        `IAP: no Google credentials for signing the access token (${e instanceof Error ? e.message : String(e)}). ` +
          "Run `gcloud auth application-default login` with an account that is allowed on this Caelo install.",
      );
    }
    const res = await doFetch(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:signJwt`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          payload: JSON.stringify({
            iss: serviceAccount,
            sub: serviceAccount,
            aud: audience,
            iat,
            exp,
          }),
        }),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `IAP: could not sign an access token as ${serviceAccount} (HTTP ${res.status}). ` +
          "Your Google account needs roles/iam.serviceAccountTokenCreator on that service account — " +
          "`cms-provision upgrade` grants it to every IAP-allowlisted user. " +
          detail.slice(0, 300),
      );
    }
    const { signedJwt } = (await res.json()) as { signedJwt?: string };
    if (!signedJwt) throw new Error("IAP: signJwt response carried no signedJwt");
    cached = { jwt: signedJwt, exp };
    return signedJwt;
  }

  return {
    serviceAccount,
    async headers() {
      if (!cached || cached.exp - REFRESH_MARGIN_S <= now()) {
        inflight ??= mint().finally(() => {
          inflight = null;
        });
        await inflight;
      }
      return { authorization: `Bearer ${(cached as { jwt: string }).jwt}` };
    },
  };
}

let processIngress: IngressAuth | null | undefined;

/** Ingress headers for this process, configured from `process.env` on first use. */
export async function ingressHeaders(): Promise<Record<string, string>> {
  if (processIngress === undefined)
    processIngress = createIngressAuth({
      CAELO_IAP_SERVICE_ACCOUNT: process.env.CAELO_IAP_SERVICE_ACCOUNT,
      CAELO_ADMIN_URL: process.env.CAELO_ADMIN_URL,
    });
  return processIngress ? processIngress.headers() : {};
}

/**
 * Turns IAP's own rejection (`x-goog-iap-generated-response: true`) into an
 * actionable message — otherwise the operator only sees "Invalid IAP
 * credentials: empty token" and has no idea which knob to turn.
 */
export function describeIapRejection(res: Response, body: string): string | null {
  if (res.headers.get("x-goog-iap-generated-response") !== "true") return null;
  const configured = Boolean(process.env.CAELO_IAP_SERVICE_ACCOUNT?.trim());
  return configured
    ? `HTTP ${res.status} from Google IAP: ${body.trim()} — the service account in CAELO_IAP_SERVICE_ACCOUNT is not allowed on this install's IAP. Run \`cms-provision upgrade\` (it allowlists the MCP service account) or check the value against /security/mcp.`
    : `HTTP ${res.status} from Google IAP: ${body.trim()} — this admin is protected by Google IAP. Copy the \`claude mcp add\` command from /security/mcp again (it includes CAELO_IAP_SERVICE_ACCOUNT on IAP installs) and run \`gcloud auth application-default login\`.`;
}

// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's refresh ping to a public API gateway: what both sides agree on.
 *
 * The gateways run on request-billed CPU (Cloud Run): between requests an
 * instance has no CPU, so the NOTIFY the admin's projection publisher sends
 * waits in the gateway's socket. A gateway whose feature is off (epic #763
 * E14 a: no visitor plugin active, no staging host set) answers every visitor
 * the fixed 404 from memory and never asks the database because of visitor
 * traffic, so nothing in that traffic tells it that the feature was switched
 * on meanwhile. After a publish that wrote a gateway's public database, the
 * admin therefore sends that gateway one request: `POST`
 * {@link GATEWAY_REFRESH_PATH} with a Google-signed ID token of the admin's
 * own service account in {@link GATEWAY_REFRESH_TOKEN_HEADER}, for the
 * audience {@link gatewayRefreshAudience}. The gateway checks the token
 * against Google's public keys, without the database, and on a valid one
 * reads its published state again. Anything else on that path is the fixed
 * 404 of an unknown path (docs/dev/gateway-hardening.md).
 */

/** The path of the ping, the same on the live and the staging gateway. */
export const GATEWAY_REFRESH_PATH = "/api/_caelo/refresh";

/**
 * The request header carrying the admin's ID token. Not `Authorization`:
 * Cloud Run and Firebase Hosting each give that header meanings of their own.
 */
export const GATEWAY_REFRESH_TOKEN_HEADER = "x-caelo-refresh-token";

/**
 * The gateway env var naming the one service account whose pings it takes:
 * the admin's runtime service account. Required on the Google Cloud
 * providers; the gateways of the other providers take no pings.
 */
export const GATEWAY_REFRESH_ACCOUNT_ENV = "CAELO_GATEWAY_REFRESH_ACCOUNT";

/** Which gateway a ping is for: the live site's or the staging site's. */
export type GatewayRefreshTarget = "live" | "staging";

/** Both gateways, in the order the admin pings and shows them. */
export const GATEWAY_REFRESH_TARGETS: readonly GatewayRefreshTarget[] = ["live", "staging"];

/**
 * The `aud` of a ping's ID token. Fixed per install environment and gateway,
 * so a token minted for one gateway cannot ping the other, nor any other
 * service that takes Google ID tokens. URL-shaped (some token minters accept
 * only URLs) on the reserved `.invalid` domain: nothing is ever served there.
 *
 * @param env - the install environment (`CAELO_ENV`, e.g. `production`)
 */
export function gatewayRefreshAudience(env: string, target: GatewayRefreshTarget): string {
  return `https://gateway-refresh.caelo.invalid/${encodeURIComponent(env)}/${target}`;
}

/**
 * Whether a provider's gateways run on request-billed CPU and so need the
 * ping. Self-hosted gateways have CPU between requests and handle every
 * notification as it arrives; AWS and Azure have no gateway service yet
 * (#749, #750).
 */
export function gatewayRefreshPingsOn(provider: string | undefined): boolean {
  return provider === "gcp" || provider === "gcp-firebase";
}

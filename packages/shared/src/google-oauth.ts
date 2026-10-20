// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #914 — the shape of a Google OAuth client and the redirect URI IAP
 * needs on it. Shared so the admin's server-side validation and the setup
 * page (which shows IAP's redirect URI as the Owner types the client ID)
 * use one definition.
 */

/**
 * A Google OAuth 2.0 client ID (`<project number>-<random>.apps.googleusercontent.com`).
 * Same pattern as the `operator_oauth_client` CHECK constraint (migration 0320).
 */
export const GOOGLE_OAUTH_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

/**
 * IAP's redirect URI for a custom OAuth client: Google sends a signed-in
 * visitor back to IAP here, so the client must list it among its authorized
 * redirect URIs (cloud.google.com/iap/docs/custom-oauth-configuration).
 *
 * @example
 *   iapRedirectUri("123-abc.apps.googleusercontent.com")
 *   // → "https://iap.googleapis.com/v1/oauth/clientIds/123-abc.apps.googleusercontent.com:handleRedirect"
 */
export function iapRedirectUri(clientId: string): string {
  return `https://iap.googleapis.com/v1/oauth/clientIds/${clientId}:handleRedirect`;
}

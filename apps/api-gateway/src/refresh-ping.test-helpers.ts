// SPDX-License-Identifier: MPL-2.0

/**
 * Test-only RS256 key pairs and Google-shaped ID tokens for the refresh
 * ping tests (the verifier's unit tests, the gateway's integration tests).
 */

import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createRefreshPingVerifier, type RefreshPingVerifier } from "./refresh-ping.js";

/** The admin's runtime account in the tests. */
export const TEST_ADMIN_ACCOUNT = "caelo-test-run-sa@acme.iam.gserviceaccount.com";

/** A signing key pair plus the `kid` Google would publish it under. */
export interface IdTokenTestKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicPem: string;
}

/** A fresh RSA key pair. */
export function idTokenTestKey(kid: string): IdTokenTestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Sign a Google-shaped ID token. `email: null` omits the claim. */
export function signIdTokenForTests(
  key: IdTokenTestKey,
  claims: {
    readonly aud: string;
    readonly email?: string | null;
    readonly emailVerified?: unknown;
    readonly iss?: string;
    readonly iat?: number;
    readonly exp?: number;
  },
): string {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
  const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid }));
  const payload = b64u(
    JSON.stringify({
      iss: claims.iss ?? "https://accounts.google.com",
      aud: claims.aud,
      azp: "112233445566778899",
      sub: "112233445566778899",
      ...(claims.email === null ? {} : { email: claims.email ?? TEST_ADMIN_ACCOUNT }),
      email_verified: "emailVerified" in claims ? claims.emailVerified : true,
      iat: claims.iat ?? now,
      exp: claims.exp ?? now + 3600,
    }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), key.privateKey);
  return `${header}.${payload}.${b64u(signature)}`;
}

/** A verifier that takes `key` as Google's only published key. */
export function testRefreshPingVerifier(
  key: IdTokenTestKey,
  audience: string,
): RefreshPingVerifier {
  return createRefreshPingVerifier({
    account: TEST_ADMIN_ACCOUNT,
    audience,
    keys: async () => ({ [key.kid]: key.publicPem }),
  });
}

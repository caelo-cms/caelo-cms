// SPDX-License-Identifier: MPL-2.0

/**
 * Test-only ES256 key pairs and IAP-shaped assertions for the remote MCP
 * tests (verifier unit tests, principal integration tests, route tests).
 * Exported from the package root under a `ForTests` name so apps/admin's
 * route tests sign with the same helper.
 */

import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { IAP_ISSUER } from "./iap-assertion.js";

/** A signing key pair plus the `kid` IAP would publish it under. */
export interface IapTestKeyPair {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicPem: string;
}

/** A fresh P-256 key pair. */
export function iapTestKeyPair(kid: string): IapTestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    kid,
    privateKey,
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Sign an IAP-shaped assertion. `email: null` omits the claim. */
export function signIapTestAssertion(
  key: IapTestKeyPair,
  claims: {
    readonly aud: string;
    readonly email?: string | null;
    readonly iss?: string;
    readonly iat?: number;
    readonly exp?: number;
  },
): string {
  const now = Math.floor(Date.now() / 1000);
  const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");
  const header = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: key.kid }));
  const payload = b64u(
    JSON.stringify({
      iss: claims.iss ?? IAP_ISSUER,
      aud: claims.aud,
      sub: "accounts.google.com:1234",
      ...(claims.email === null ? {} : { email: claims.email ?? "editor@example.com" }),
      iat: claims.iat ?? now,
      exp: claims.exp ?? now + 600,
    }),
  );
  // JOSE ES256 signatures are raw r||s (IEEE P1363), not DER.
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${b64u(signature)}`;
}

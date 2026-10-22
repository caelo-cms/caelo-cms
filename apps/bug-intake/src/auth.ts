// SPDX-License-Identifier: MPL-2.0

/**
 * Verifies that a request comes from the install it names: the install's
 * pinned Ed25519 key must verify the signature over method, path, timestamp
 * and body hash (shared/bug-intake.ts), and the timestamp must sit inside
 * the replay window.
 */

import {
  BUG_INTAKE_HEADERS,
  BUG_INTAKE_MAX_CLOCK_SKEW_MS,
  bugIntakeSigningString,
} from "@caelo-cms/shared";
import { IntakeRefusal } from "./service.js";
import type { IntakeStore } from "./store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the verified install id, or throws an IntakeRefusal (401). */
export async function verifySignedRequest(args: {
  store: IntakeStore;
  headers: Headers;
  method: string;
  path: string;
  body: string;
  nowMs: number;
}): Promise<string> {
  const installId = args.headers.get(BUG_INTAKE_HEADERS.installId) ?? "";
  const timestamp = args.headers.get(BUG_INTAKE_HEADERS.timestamp) ?? "";
  const signature = args.headers.get(BUG_INTAKE_HEADERS.signature) ?? "";
  if (!UUID.test(installId) || !/^\d{1,16}$/.test(timestamp) || signature === "") {
    throw new IntakeRefusal(401, "Missing or malformed signature headers.");
  }
  if (Math.abs(args.nowMs - Number(timestamp)) > BUG_INTAKE_MAX_CLOCK_SKEW_MS) {
    throw new IntakeRefusal(
      401,
      "Request timestamp is outside the allowed window; check the install's clock.",
    );
  }
  const publicKey = await args.store.getInstallKey(installId);
  if (publicKey === null) {
    throw new IntakeRefusal(401, "Unknown install; register its key first.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(publicKey, "base64"),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const message = await bugIntakeSigningString({
    method: args.method,
    path: args.path,
    timestamp,
    body: args.body,
  });
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    Buffer.from(signature, "base64"),
    new TextEncoder().encode(message),
  );
  if (!valid) throw new IntakeRefusal(401, "Signature does not verify.");
  return installId;
}

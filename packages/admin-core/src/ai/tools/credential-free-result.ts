// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #971 — the one place an approved (gated) tool's apply output becomes
 * what the AI reads. Everything downstream of `attachGatedExecute` — the SDK
 * tool result, `response.messages` persisted in chat_messages and replayed
 * every turn, the caelo_chat reply an external MCP client receives — derives
 * from the value returned here, so a credential stopped here reaches none of
 * them.
 *
 * The primary mechanism is structural: credential-producing executors return
 * a {@link CredentialHandoffRef} instead of the secret (credential_handoffs.ts),
 * and this function turns that reference into the sentence telling the AI
 * where the operator collects it. The key scan below is defense in depth for
 * an executor that regresses: it withholds the field, logs loudly, and the
 * catalogue test (credential-free-ai-results.test.ts) fails the build on the
 * executor's output schema long before that.
 */

import {
  type CredentialHandoffRef,
  credentialHandoffRef,
  describeCredentialHandoffForAi,
} from "../../ops/credential_handoffs.js";

/**
 * A field name that carries a credential: passwords, secrets, plaintext or
 * bearer tokens, API / private keys. `tokenId`, `apiKeySource`,
 * `cookieSecretSet` and friends are metadata — the scan only withholds a
 * matching key whose value is a string.
 */
export const SECRET_SHAPED_KEY =
  /pass(word|wd|phrase)|secret|plaintext|api[-_]?key|private[-_]?key|bearer|^token$|[a-z]Token$/i;

/** What a withheld field reads as. */
export const WITHHELD = "[withheld: credentials never reach the AI]";

/** Paths (`a.b[0].c`) of string-valued secret-shaped fields in `value`. */
export function findSecretShapedFields(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findSecretShapedFields(v, `${path}[${i}]`));
  }
  if (!value || typeof value !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === "string" && SECRET_SHAPED_KEY.test(k)) out.push(p);
    else out.push(...findSecretShapedFields(v, p));
  }
  return out;
}

function withhold(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withhold);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = typeof v === "string" && SECRET_SHAPED_KEY.test(k) ? WITHHELD : withhold(v);
  }
  return out;
}

/**
 * Shape an executor's output for the AI: a credential handoff gains the
 * `credential` sentence (where the operator collects it), and any
 * secret-shaped string field is withheld.
 */
export function credentialFreeResult(toolName: string, value: unknown): unknown {
  const leaked = findSecretShapedFields(value);
  if (leaked.length > 0) {
    // CLAUDE.md §2 — loud: an executor started returning a credential.
    console.error("[gated-tool] withheld secret-shaped fields from an AI-visible result (#971)", {
      tool: toolName,
      fields: leaked,
    });
  }
  const shaped = leaked.length > 0 ? withhold(value) : value;
  if (!shaped || typeof shaped !== "object" || Array.isArray(shaped)) return shaped;
  const record = shaped as Record<string, unknown>;
  const ref = credentialHandoffRef.safeParse(record.credentialHandoff);
  if (!ref.success) return shaped;
  return {
    ...record,
    credential: describeCredentialHandoffForAi(ref.data as CredentialHandoffRef),
  };
}

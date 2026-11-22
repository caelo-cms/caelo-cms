// SPDX-License-Identifier: MPL-2.0

/**
 * Signed conversation history (#1654).
 *
 * The gateway keeps no conversation state: the visitor's browser holds the
 * history and sends it back with every question. So every assistant turn
 * the gateway answered comes back to the browser signed (`done.turn`), and
 * a request whose history holds an unsigned, altered, reordered or foreign
 * turn is refused: a client cannot put words into the assistant's mouth
 * (an invented earlier answer is the classic way to steer a model).
 *
 * A turn token is `<payload>.<mac>`, both base64url: the payload is the
 * turn as JSON (environment, plugin, operation, conversation id, index,
 * question, answer, sources, time), the mac an HMAC-SHA256 over the payload
 * text.
 *
 * The HMAC key is derived (HKDF-SHA256) from this environment's visitor-AI
 * key, which only the gateway can read: the admin adds versions to that
 * secret and never reads one, and nothing about it is in a database. So no
 * second secret is needed, rotating the key ends every open conversation
 * (the next question starts a new one), and a staging turn never verifies
 * on live — the environment is in the derivation and in the payload, also
 * when the Owner uses one key for both.
 */

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** A conversation lives a day; after that its next question starts a new one. */
export const CONVERSATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** One source as the visitor's page shows it: a link the gateway took from a tool result. */
export interface ChatSource {
  readonly n: number;
  readonly url: string;
  readonly title: string;
  readonly anchor: string | null;
  readonly cited: boolean;
}

/** One answered turn, as signed. */
export interface SignedTurn {
  readonly v: 1;
  readonly e: "live" | "staging";
  readonly p: string;
  readonly o: string;
  /** Conversation id: 16 random bytes, base64url. */
  readonly c: string;
  /** Index in the conversation, from 0. */
  readonly n: number;
  readonly q: string;
  readonly a: string;
  readonly s: readonly ChatSource[];
  /** When the conversation's first turn was answered (ms). */
  readonly t0: number;
}

const sourceSchema = z
  .object({
    n: z.number().int().min(1).max(50),
    url: z.string().max(600),
    title: z.string().max(300),
    anchor: z.string().max(120).nullable(),
    cited: z.boolean(),
  })
  .strict();

const turnSchema = z
  .object({
    v: z.literal(1),
    e: z.enum(["live", "staging"]),
    p: z.string().max(64),
    o: z.string().max(120),
    c: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    n: z.number().int().min(0).max(50),
    q: z.string().max(4000),
    a: z.string().max(40_000),
    s: z.array(sourceSchema).max(20),
    t0: z.number().int().nonnegative(),
  })
  .strict();

/** The HMAC key of one environment, from its visitor-AI key. */
export function turnKey(apiKey: string, environment: "live" | "staging"): Buffer {
  return Buffer.from(hkdfSync("sha256", apiKey, "caelo-visitor-ai-turns", `v1:${environment}`, 32));
}

function mac(key: Buffer, payload: string): Buffer {
  return createHmac("sha256", key).update(payload, "utf8").digest();
}

/** The token the browser keeps for `turn`. */
export function signTurn(key: Buffer, turn: SignedTurn): string {
  const payload = Buffer.from(JSON.stringify(turn), "utf8").toString("base64url");
  return `${payload}.${mac(key, payload).toString("base64url")}`;
}

/** Why a history is refused. */
export type HistoryProblem = "unsigned" | "altered" | "foreign" | "out-of-order" | "expired";

/**
 * The turns of a history, verified: every token signed with `key`, all of
 * one conversation of this environment's `plugin`/`operation`, indexed 0..n-1
 * in order, and the conversation younger than a day.
 */
export function verifyHistory(
  key: Buffer,
  tokens: readonly string[],
  expect: {
    readonly environment: "live" | "staging";
    readonly plugin: string;
    readonly operation: string;
  },
  now: number = Date.now(),
): { ok: true; turns: SignedTurn[] } | { ok: false; problem: HistoryProblem } {
  const turns: SignedTurn[] = [];
  for (const token of tokens) {
    const dot = token.indexOf(".");
    if (dot <= 0 || dot !== token.lastIndexOf(".")) return { ok: false, problem: "unsigned" };
    const payload = token.slice(0, dot);
    let given: Buffer;
    try {
      given = Buffer.from(token.slice(dot + 1), "base64url");
    } catch {
      return { ok: false, problem: "unsigned" };
    }
    const expected = mac(key, payload);
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return { ok: false, problem: "altered" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return { ok: false, problem: "altered" };
    }
    const turn = turnSchema.safeParse(parsed);
    if (!turn.success) return { ok: false, problem: "altered" };
    turns.push(turn.data);
  }
  const first = turns[0];
  if (!first) return { ok: true, turns };
  for (const [i, t] of turns.entries()) {
    if (t.e !== expect.environment || t.p !== expect.plugin || t.o !== expect.operation)
      return { ok: false, problem: "foreign" };
    if (t.c !== first.c || t.t0 !== first.t0 || t.n !== i)
      return { ok: false, problem: "out-of-order" };
  }
  if (now - first.t0 > CONVERSATION_MAX_AGE_MS) return { ok: false, problem: "expired" };
  return { ok: true, turns };
}

// SPDX-License-Identifier: MPL-2.0

/**
 * The visitor half of dispatch (issue #1332): what a public operation's
 * declared contract decides before its handler runs, and what of a
 * failure reaches the visitor afterwards.
 *
 * Before the handler:
 *   1. the gateway's proof field (`_caelo_captcha`) is removed — it is
 *      transport, not the operation's input (the honeypot field stays: a
 *      plugin judges it too, so its schema declares it);
 *   2. an operation whose captcha is `required` is refused unless the
 *      gateway verified a proof-of-work bound to exactly this operation for
 *      this request (or the Owner turned the captcha off site-wide);
 *   3. the body is parsed with the operation's `input` schema, and the
 *      handler receives the PARSED value — never a value of the wrong type.
 *
 * After it: a failure's text reaches the visitor only when the handler
 * meant it for them (`PublicOperationError` → `Rejected`). Everything else
 * — a TypeError, a database message, a host error — is logged with its
 * detail and answered with one generic sentence, because its text can
 * carry internals (M3).
 *
 * The checks live in the plugin host, not in the gateway route, so no
 * second entry point can skip them (the same reason default deny lives
 * in dispatch).
 */

import type { PublicOperationDef } from "@caelo-cms/plugin-sdk";
import type { z } from "zod";
import type { RunPluginOperationResult, VisitorCaptchaVerdict } from "./dispatch.js";

/** Body fields the gateway reads itself; never part of an operation's input. */
export const VISITOR_TRANSPORT_FIELDS: ReadonlySet<string> = new Set(["_caelo_captcha"]);

/** Longest refusal text a handler can send a visitor. */
export const VISITOR_MESSAGE_MAX = 300;

/** Most validation issues one refusal lists. */
const MAX_ISSUES = 5;

/** What a visitor sees for any failure the handler did not word for them. */
export const GENERIC_VISITOR_FAILURE = "The request could not be completed. Try again in a moment.";

type Refusal =
  | { readonly ok: true; readonly args: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly kind: "InvalidInput" | "CaptchaRequired";
        readonly message: string;
      };
    };

/**
 * Apply `op`'s contract to a visitor call: the captcha it requires, then
 * its input schema.
 *
 * @returns the parsed arguments the handler receives, or the refusal
 */
export function refusePublicCall(
  op: PublicOperationDef,
  captcha: VisitorCaptchaVerdict,
  rawArgs: unknown,
): Refusal {
  if ((op.captcha ?? "required") === "required" && captcha.enforced && !captcha.proofVerified) {
    return {
      ok: false,
      error: {
        kind: "CaptchaRequired",
        message: `this request needs a captcha proof for "${op.name}": fetch one from /api/captcha/challenge, solve it for this operation and send it as _caelo_captcha`,
      },
    };
  }
  const parsed = op.input.safeParse(withoutTransportFields(rawArgs));
  if (!parsed.success) {
    return { ok: false, error: { kind: "InvalidInput", message: describeIssues(parsed.error) } };
  }
  return { ok: true, args: parsed.data };
}

/** `args` without the gateway's transport fields (a copy; non-objects pass). */
function withoutTransportFields(args: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).filter(
      ([k]) => !VISITOR_TRANSPORT_FIELDS.has(k),
    ),
  );
}

/**
 * The validation issues as one sentence: paths and Zod's messages, which
 * name the expected shape but never echo the values sent.
 */
function describeIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, MAX_ISSUES).map((i) => {
    const path = i.path.map(String).join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
  const more =
    error.issues.length > MAX_ISSUES ? ` (+${error.issues.length - MAX_ISSUES} more)` : "";
  return `the request does not match what this operation accepts — ${issues.join("; ")}${more}`;
}

/**
 * The result a visitor may see: an `OperationFailed` (whatever threw, or
 * a host failure) keeps its detail in the log and answers generically.
 *
 * @param label `<slug>.<operation>`, for the log line
 */
export function visitorSafeResult(
  result: RunPluginOperationResult,
  label: string,
): RunPluginOperationResult {
  if (result.ok || result.error.kind !== "OperationFailed") return result;
  console.error(`[plugin-host] visitor call ${label} failed: ${result.error.message}`);
  return { ok: false, error: { kind: "OperationFailed", message: GENERIC_VISITOR_FAILURE } };
}

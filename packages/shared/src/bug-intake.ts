// SPDX-License-Identifier: MPL-2.0

/**
 * The wire contract between a Caelo install and the Caelo-operated bug
 * intake (epic #901). Both sides import this module, so the request shapes,
 * the signature, the fingerprint and the redaction can never drift apart.
 *
 * Flow:
 *   1. On opt-in the install generates an Ed25519 keypair and registers the
 *      public key under its `install_id` (`POST /v1/installs`). The intake
 *      pins the first key it sees for an id (trust on first use).
 *   2. Every later request is signed: the install signs
 *      {@link bugIntakeSigningString} and sends the three
 *      {@link BUG_INTAKE_HEADERS}. The intake verifies against the pinned key
 *      and refuses timestamps outside {@link BUG_INTAKE_MAX_CLOCK_SKEW_MS}.
 *   3. A report (`POST /v1/reports`) is answered with the status of the
 *      cluster it joined; `POST /v1/clusters/status` refreshes those
 *      statuses later, so the install learns "fixed in vX" without polling
 *      GitHub itself.
 *
 * Redaction runs on the install BEFORE a report is queued (the Owner's
 * preview shows the redacted bytes) and again on the intake before anything
 * reaches the public issue tracker.
 */

import { z } from "zod";

/** Bumped on any breaking change to the request or response shapes below. */
export const BUG_INTAKE_PROTOCOL_VERSION = 1;

/** Header names carrying the install's identity and request signature. */
export const BUG_INTAKE_HEADERS = {
  installId: "x-caelo-install-id",
  timestamp: "x-caelo-timestamp",
  signature: "x-caelo-signature",
} as const;

/** Requests signed further than this from the intake's clock are refused (replay window). */
export const BUG_INTAKE_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Hard caps on what a report may carry once redacted. */
export const BUG_INTAKE_LIMITS = {
  title: 200,
  whatHappened: 4000,
  expected: 4000,
  evidence: 4000,
} as const;

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/, "fingerprint must be 64 hex chars");

/** `POST /v1/installs` — registers the install's public key (unsigned; TOFU). */
export const bugIntakeRegisterRequest = z
  .object({
    protocolVersion: z.literal(BUG_INTAKE_PROTOCOL_VERSION),
    installId: z.string().uuid(),
    /** Raw 32-byte Ed25519 public key, base64. */
    publicKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "publicKey must be a base64 Ed25519 key"),
    caeloVersion: z.string().min(1).max(64),
  })
  .strict();
export type BugIntakeRegisterRequest = z.infer<typeof bugIntakeRegisterRequest>;

/** `POST /v1/reports` — one redacted bug report (signed). */
export const bugIntakeReport = z
  .object({
    protocolVersion: z.literal(BUG_INTAKE_PROTOCOL_VERSION),
    /** The install's own `ai_bug_reports.id`; the intake dedups retries on it. */
    reportId: z.string().uuid(),
    caeloVersion: z.string().min(1).max(64),
    fingerprint: fingerprintSchema,
    source: z.enum(["ai", "auto"]),
    severity: z.enum(["blocking", "degraded", "cosmetic"]),
    blockedTask: z.boolean(),
    suspectedTool: z.string().max(200).nullable(),
    title: z.string().min(1).max(BUG_INTAKE_LIMITS.title),
    whatHappened: z.string().min(1).max(BUG_INTAKE_LIMITS.whatHappened),
    expected: z.string().min(1).max(BUG_INTAKE_LIMITS.expected),
    evidence: z.string().max(BUG_INTAKE_LIMITS.evidence).nullable(),
  })
  .strict();
export type BugIntakeReport = z.infer<typeof bugIntakeReport>;

/**
 * Upstream state of the defect a report belongs to.
 *   open       — known, not fixed yet
 *   fixed      — the issue was closed as fixed; `fixedInVersion` names the
 *                first release carrying the fix when it is known
 *   regression — fixed once, reported again from a version that has the fix
 *   wontfix    — closed as not planned
 */
export const bugClusterStatus = z.enum(["open", "fixed", "regression", "wontfix"]);
export type BugClusterStatus = z.infer<typeof bugClusterStatus>;

/**
 * What the intake knows about one cluster (= one upstream issue). Also the
 * `POST /v1/reports` response body: the cluster the report joined.
 */
export const bugIntakeClusterInfo = z
  .object({
    clusterId: z.string().min(1).max(100),
    status: bugClusterStatus,
    /** Public issue URL; null while the cluster is below the issue threshold. */
    issueUrl: z.string().url().nullable(),
    fixedInVersion: z.string().max(64).nullable(),
  })
  .strict();
export type BugIntakeClusterInfo = z.infer<typeof bugIntakeClusterInfo>;

/** `POST /v1/clusters/status` — refresh the status of clusters this install reported into (signed). */
export const bugIntakeStatusRequest = z
  .object({
    protocolVersion: z.literal(BUG_INTAKE_PROTOCOL_VERSION),
    clusterIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  })
  .strict();
export type BugIntakeStatusRequest = z.infer<typeof bugIntakeStatusRequest>;

export const bugIntakeStatusResponse = z
  .object({ clusters: z.array(bugIntakeClusterInfo) })
  .strict();
export type BugIntakeStatusResponse = z.infer<typeof bugIntakeStatusResponse>;

/** Error body every non-2xx intake response carries. */
export const bugIntakeErrorResponse = z
  .object({
    error: z.string(),
    /** true = retrying the same request later can succeed (rate limit, outage). */
    retryable: z.boolean(),
  })
  .strict();
export type BugIntakeErrorResponse = z.infer<typeof bugIntakeErrorResponse>;

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text) as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * The exact bytes an install signs for a request. Binding method, path and
 * body hash means a captured signature cannot be replayed against another
 * endpoint or with another body; the timestamp bounds replay in time.
 */
export async function bugIntakeSigningString(args: {
  method: string;
  path: string;
  timestamp: string;
  body: string;
}): Promise<string> {
  return `${args.method.toUpperCase()}\n${args.path}\n${args.timestamp}\n${await sha256Hex(args.body)}`;
}

/**
 * Collapse the parts of an error text that differ between occurrences of the
 * same defect (ids, numbers, quoted values, URLs, paths) so the same bug on
 * two installs yields the same text.
 */
export function normalizeBugText(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, "<url>")
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
      .replace(/\b[0-9a-f]{12,}\b/g, "<id>")
      // Quoted values (a slug, a title) vary per occurrence; a quoted field
      // path or tool name (`page.slug`, `build_page`) tells two defects apart,
      // so identifiers carrying `.`, `_` or `[` stay.
      .replace(/(["'`])((?:(?!\1).){0,200})\1/g, (m, _q: string, inner: string) =>
        /^[A-Za-z][\w.[\]-]{0,59}$/.test(inner) && /[._[]/.test(inner) ? m : "<v>",
      )
      .replace(/(?:\/[\w.-]+){2,}/g, "<path>")
      .replace(/\d+(\.\d+)?/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300)
  );
}

/**
 * Deterministic identity of a defect, computed on the install. The Caelo
 * version is deliberately NOT part of it, so one defect stays one cluster
 * across releases (that is how a regression is recognised).
 *
 * Auto-captured reports carry the failing tool's error text as
 * `whatHappened`, which is stable once normalised. AI-filed reports are free
 * prose, so their fingerprint (tool + normalised title) only catches exact
 * repeats; the intake clusters the rest semantically.
 */
export async function computeBugFingerprint(args: {
  source: "ai" | "auto";
  suspectedTool: string | null;
  title: string;
  whatHappened: string;
}): Promise<string> {
  const tool = (args.suspectedTool ?? "").trim().toLowerCase();
  const signal = args.source === "auto" ? args.whatHappened : args.title;
  return sha256Hex(`${args.source}\n${tool}\n${normalizeBugText(signal)}`);
}

/**
 * Remove what must never leave an install inside a bug report: contact
 * data, credentials, network addresses, and links (which name the site and
 * its pages). Conservative by design: a report that lost a URL is still
 * triageable, a leaked key is not recoverable.
 */
export function redactBugText(text: string): string {
  return (
    text
      // Credentials first, before the generic long-token rule eats their prefix.
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted-token]")
      .replace(
        /\b(?:sk|pk|rk)-[\w-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[\w-]{30,}|\bxox[abpr]-[\w-]{10,}/g,
        "[redacted-secret]",
      )
      .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, "$1 [redacted-secret]")
      .replace(
        /\b(password|passwd|secret|token|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
        "$1$2[redacted-secret]",
      )
      .replace(/https?:\/\/[^\s"'<>)]+/g, "[url]")
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
      // International (+49 …) or trunk-prefixed (030 …) numbers; plain digit
      // runs and ISO dates are left alone.
      .replace(/\+\d[\d\s()/-]{7,}\d|\b0\d{2,5}[\s/-]?\d{3,}[\d\s-]*\d/g, "[phone]")
      // Long mixed-case alphanumerics are keys or encoded payloads; source
      // paths and snake_case names (no uppercase+digit mix) survive.
      .replace(
        /\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{40,}={0,2}/g,
        "[redacted-blob]",
      )
  );
}

/** Redact and cap one report's free-text fields (both sides run this). */
export function redactBugReportFields<
  T extends { title: string; whatHappened: string; expected: string; evidence: string | null },
>(report: T): T {
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return {
    ...report,
    title: cap(redactBugText(report.title), BUG_INTAKE_LIMITS.title),
    whatHappened: cap(redactBugText(report.whatHappened), BUG_INTAKE_LIMITS.whatHappened),
    expected: cap(redactBugText(report.expected), BUG_INTAKE_LIMITS.expected),
    evidence:
      report.evidence === null
        ? null
        : cap(redactBugText(report.evidence), BUG_INTAKE_LIMITS.evidence),
  };
}

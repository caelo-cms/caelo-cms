// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — run a Lighthouse audit job in the child process
 * (`lighthouse-child.ts`) and collect its results. See the child's header
 * for why the audit leaves the admin process.
 *
 * Every way the audit can fail ends in a structured `AuditInfraFailure`
 * (browser missing, child crash, timeout, garbage output) — never in a
 * silent pass. The caller records it loudly on the audit run.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type AuditJob, childEventSchema } from "./lighthouse-protocol.js";
import type { PageMeasurement } from "./ratchet.js";

export interface AuditedPage {
  readonly pageId: string;
  readonly url: string;
  readonly finalUrl?: string;
  readonly measurement: PageMeasurement;
  readonly performanceRuns: readonly number[];
}

export interface PageAuditError {
  readonly pageId: string;
  readonly url: string;
  readonly code: string;
  readonly message: string;
}

export interface AuditInfraFailure {
  readonly code: "timeout" | "child-failed" | "browser-unavailable" | "protocol";
  readonly message: string;
}

export type AuditJobResult =
  | {
      readonly ok: true;
      readonly pages: readonly AuditedPage[];
      readonly pageErrors: readonly PageAuditError[];
    }
  | { readonly ok: false; readonly failure: AuditInfraFailure };

/** Per-page budget: 1 full + (n-1) Performance runs at up to ~45 s each
 *  (Lighthouse's own page-load ceiling), plus browser start. */
export function auditTimeoutMs(job: AuditJob): number {
  return 30_000 + job.pages.length * job.performanceRuns * 60_000;
}

/**
 * Locate the child script. `CAELO_LIGHTHOUSE_CHILD` wins; otherwise walk up
 * from the cwd (the admin runs from apps/admin in dev and in the image,
 * where packages/ is copied next to apps/). Throws when it cannot be found
 * (no fallbacks pre-1.0).
 */
export function resolveLighthouseChild(): string {
  const override = process.env.CAELO_LIGHTHOUSE_CHILD;
  if (override) return override;
  const rel = "packages/admin-core/src/quality/lighthouse-child.ts";
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `quality audit: ${rel} not found walking up from ${process.cwd()} — set CAELO_LIGHTHOUSE_CHILD to its absolute path`,
  );
}

/**
 * Spawn the child, feed it the job, and parse its JSON-line events.
 *
 * @param opts.childPath - script to run (tests pass a stub).
 * @param opts.timeoutMs - kill the child after this long (default
 *   `auditTimeoutMs(job)`).
 */
export async function runAuditJob(
  job: AuditJob,
  opts?: { readonly childPath?: string; readonly timeoutMs?: number },
): Promise<AuditJobResult> {
  let childPath: string;
  try {
    childPath = opts?.childPath ?? resolveLighthouseChild();
  } catch (e) {
    return {
      ok: false,
      failure: { code: "child-failed", message: e instanceof Error ? e.message : String(e) },
    };
  }
  const timeoutMs = opts?.timeoutMs ?? auditTimeoutMs(job);
  return await new Promise<AuditJobResult>((respond) => {
    // Same runtime the static-generator subprocess uses (`bun` on PATH):
    // the admin image ships Bun and no Node.
    const child = spawn("bun", [childPath], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const pages: AuditedPage[] = [];
    const pageErrors: PageAuditError[] = [];
    const stderr: Buffer[] = [];
    let buffer = "";
    let done = false;
    let failure: AuditInfraFailure | null = null;
    let settled = false;
    const settle = (r: AuditJobResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      respond(r);
    };
    const timer = setTimeout(() => {
      failure = {
        code: "timeout",
        message: `Lighthouse audit exceeded ${Math.round(timeoutMs / 1000)} s and was stopped`,
      };
      child.kill("SIGKILL");
    }, timeoutMs);

    const handleLine = (line: string) => {
      if (line.trim().length === 0) return;
      let parsed: ReturnType<typeof childEventSchema.safeParse>;
      try {
        parsed = childEventSchema.safeParse(JSON.parse(line));
      } catch {
        failure ??= {
          code: "protocol",
          message: `unparseable audit output: ${line.slice(0, 200)}`,
        };
        return;
      }
      if (!parsed.success) {
        failure ??= {
          code: "protocol",
          message: `invalid audit output: ${parsed.error.message.slice(0, 300)}`,
        };
        return;
      }
      const ev = parsed.data;
      if (ev.kind === "page") {
        pages.push({
          pageId: ev.pageId,
          url: ev.url,
          ...(ev.finalUrl ? { finalUrl: ev.finalUrl } : {}),
          measurement: ev.measurement as PageMeasurement,
          performanceRuns: ev.performanceRuns,
        });
      } else if (ev.kind === "page-error") {
        pageErrors.push({ pageId: ev.pageId, url: ev.url, code: ev.code, message: ev.message });
      } else if (ev.kind === "fatal") {
        failure ??= {
          code: ev.code.startsWith("browser-") ? "browser-unavailable" : "child-failed",
          message: ev.message,
        };
      } else {
        done = true;
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (e) => {
      settle({ ok: false, failure: { code: "child-failed", message: e.message } });
    });
    child.on("close", (code) => {
      handleLine(buffer);
      if (failure) {
        settle({ ok: false, failure });
        return;
      }
      if (!done) {
        const tail = Buffer.concat(stderr).toString("utf8").trim().slice(-500);
        settle({
          ok: false,
          failure: {
            code: "child-failed",
            message: `audit process exited ${code} before finishing${tail ? `: ${tail}` : ""}`,
          },
        });
        return;
      }
      settle({ ok: true, pages, pageErrors });
    });
    child.stdin.end(JSON.stringify(job));
  });
}

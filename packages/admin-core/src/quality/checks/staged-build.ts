// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #849 — the {@link StagedBuild} a site check reads beyond the pages:
 * a probe that asks the staged origin whether it serves a path.
 *
 * The probe asks the same origin the pages were fetched from, so it sees
 * exactly what Publish live ships on every provider (loopback server over
 * the build's files, the Firebase preview channel, self-hosted staging),
 * including staging's own trailing-slash / clean-URL handling — redirects
 * the host answers are followed, and only the final status counts.
 *
 * A path the build does not contain answers 404 (or 410). Anything else
 * that is not a success — a 5xx, a refused connection, a timeout — is not a
 * finding about the link: the probe throws and the check fails loudly
 * (runner.ts), instead of reporting a link as broken or fine on a guess.
 */

import { trimTrailingSlashes } from "@caelo-cms/shared";
import type { StagedBuild, StagedProbe } from "./check.js";

/** Per-probe budget. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Statuses that mean "the build has no such file". */
const MISSING_STATUSES: ReadonlySet<number> = new Set([404, 410]);

async function ask(url: string, method: "HEAD" | "GET", fetcher: typeof fetch): Promise<number> {
  const res = await fetcher(url, {
    method,
    redirect: "follow",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  // Only the status matters; never download a GET fallback's body.
  await res.body?.cancel();
  return res.status;
}

/**
 * A staged build over `origin`.
 *
 * @param origin - the audit's staged origin (and the origin shown to operators).
 * @param fetcher - injectable for tests; the global `fetch` otherwise.
 */
export function stagedBuildAt(
  origin: { readonly baseUrl: string; readonly displayBaseUrl?: string },
  fetcher: typeof fetch = fetch,
): StagedBuild {
  const base = trimTrailingSlashes(origin.baseUrl);
  return {
    baseUrl: origin.baseUrl,
    ...(origin.displayBaseUrl ? { displayBaseUrl: origin.displayBaseUrl } : {}),
    async probe(path: string): Promise<StagedProbe> {
      if (!path.startsWith("/") || path.startsWith("//")) {
        throw new Error(`probe path must be root-relative, got ${JSON.stringify(path)}`);
      }
      const url = `${base}${path}`;
      let status: number;
      try {
        status = await ask(url, "HEAD", fetcher);
      } catch {
        // One retry: a single dropped connection on a busy staging host
        // should not fail the whole audit. A second failure does.
        try {
          status = await ask(url, "HEAD", fetcher);
        } catch (e) {
          throw new Error(
            `staging did not answer for ${path}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      // Hosts that refuse HEAD answer it with 405/501; ask with GET.
      if (status === 405 || status === 501) status = await ask(url, "GET", fetcher);
      if (status >= 200 && status < 300) return { found: true, status };
      if (MISSING_STATUSES.has(status)) return { found: false, status };
      throw new Error(
        `staging answered ${status} for ${path} — neither served nor missing; Stage again, and if it persists check the staging host`,
      );
    },
  };
}

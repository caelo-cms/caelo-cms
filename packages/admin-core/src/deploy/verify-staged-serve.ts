// SPDX-License-Identifier: MPL-2.0

/**
 * Migration run #9 R10 (issue #262) — end-to-end staging serve check.
 *
 * A "succeeded" staging deploy is only true when the serving layer
 * actually serves the build that was just written. Run #9 proved the
 * two can silently diverge: the generator resolves the target's
 * relative `out_dir` against the admin process's cwd, while the
 * dev-compose Caddy container bind-mounts the *checkout's*
 * `apps/admin/output/staging`. With the admin running from a worktree
 * copy, months of staging builds landed in a directory nothing served
 * — and every one of them reported success.
 *
 * The check closes that gap without guessing at filesystem topology:
 * fetch `<stagingBaseUrl>/routing-manifest.json` through the same URL
 * the operator's "Preview" link points at, and require its `runId` to
 * be the run we just built. Any mount/cwd/symlink mismatch — present
 * or future — surfaces as a loud, diagnosable failure instead of a
 * success toast over a stale site.
 */

/** Outcome of the staging serve round-trip. `served: false` carries an
 *  operator-actionable reason (and the stale runId when one was read). */
export type StagedServeCheck =
  | { served: true }
  | { served: false; reason: string; servedRunId?: string };

/**
 * Fetch the staging vhost's routing manifest and compare its runId with
 * the build that was just published.
 *
 * Retries a few times with a short pause: on macOS Docker Desktop the
 * bind-mounted files can take a moment to propagate into the container.
 * The retry is bounded and the final verdict stays loud — it de-flakes
 * propagation latency, it does not paper over a real mismatch.
 *
 * @param args.stagingBaseUrl Base URL of the staging serving layer
 *   (e.g. `http://localhost:8081`). Trailing slashes are tolerated.
 * @param args.runId The deploy run whose build must be live.
 * @param args.timeoutMs Per-attempt fetch budget; default 5000. A
 *   serving layer that cannot answer within this window is treated as
 *   not serving.
 * @param args.attempts Total attempts before giving up; default 3,
 *   spaced ~500ms apart.
 */
export async function verifyStagedBuildServed(args: {
  stagingBaseUrl: string;
  runId: string;
  timeoutMs?: number;
  attempts?: number;
}): Promise<StagedServeCheck> {
  const attempts = Math.max(1, args.attempts ?? 3);
  let last: StagedServeCheck = { served: false, reason: "no attempt ran" };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    last = await checkOnce(args);
    if (last.served) return last;
  }
  return last;
}

async function checkOnce(args: {
  stagingBaseUrl: string;
  runId: string;
  timeoutMs?: number;
}): Promise<StagedServeCheck> {
  const base = args.stagingBaseUrl.replace(/\/+$/, "");
  const url = `${base}/routing-manifest.json`;
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(args.timeoutMs ?? 5000),
      // The manifest changes every deploy; never accept a cached copy.
      headers: { "cache-control": "no-cache" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      served: false,
      reason: `staging serve layer unreachable at ${url} (${message})`,
    };
  }
  if (!res.ok) {
    return {
      served: false,
      reason: `staging serve layer returned HTTP ${res.status} for ${url} — the serving root has no routing manifest, so it is not serving any Caelo build`,
    };
  }
  let manifest: unknown;
  try {
    manifest = await res.json();
  } catch {
    return {
      served: false,
      reason: `staging serve layer returned non-JSON for ${url} — the serving root is not a Caelo build`,
    };
  }
  const servedRunId =
    manifest !== null && typeof manifest === "object" && "runId" in manifest
      ? String((manifest as { runId: unknown }).runId)
      : undefined;
  if (servedRunId !== args.runId) {
    return {
      served: false,
      ...(servedRunId !== undefined ? { servedRunId } : {}),
      reason:
        `staging serves runId=${servedRunId ?? "<missing>"} but this deploy wrote runId=${args.runId} — ` +
        "the serving layer is not mounted on this build's output directory",
    };
  }
  return { served: true };
}

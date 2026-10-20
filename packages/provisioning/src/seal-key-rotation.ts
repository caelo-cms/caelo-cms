// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — rotating the remote-MCP broker's seal key without signing
 * every connected MCP client out.
 *
 * The broker seals its OAuth state, codes and refresh tokens under
 * `CAELO_MCP_OAUTH_SEAL_KEY` (api-gateway mcp/seal.ts, envelope v2 with a
 * key id). While `CAELO_MCP_OAUTH_SEAL_KEY_PREVIOUS` is set it also opens
 * values sealed under that key, and seals everything new under the current
 * one. Refresh tokens live at most {@link SEAL_KEY_ROTATION_WINDOW_DAYS}
 * days (mcp/token.ts), so after that window nothing sealed under the old key
 * is still valid and the previous key can go.
 *
 * Two steps, both `cms-provision rotate-secret mcp-oauth-seal-key`:
 *
 *   start   — add a new version to the secret, then roll the gateway with
 *             the current key at `latest` and the previous key PINNED to
 *             the version that was latest before (a pinned version never
 *             follows the new one), labelled with the start time.
 *   finish  — (`--finish`) once the window has passed: drop the previous key
 *             and the label and roll again. `--finish --now` skips the
 *             window — for a leaked key, where signing every client out is
 *             the point.
 *
 * Refused instead of guessed (CLAUDE.md §2): starting while a rotation is in
 * progress (a second start would pin the CURRENT key as "previous" and drop
 * the real previous one early), and finishing before the window ends.
 *
 * A `cms-provision upgrade` whose `pulumi up` rewrites the gateway template
 * during the window drops the previous key (the stack does not declare it):
 * clients sealed under it sign in again. That fails safe — no token lives
 * longer than intended — and is documented in the rotate output.
 */

import { gcloud as defaultGcloud } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import { gcpSecretId } from "./gcp-names.js";
import { initialSecretValue } from "./runtime-secrets.js";
import { liveContainerEnv } from "./stack-converge.js";

/** The gateway env var holding the previous key during a rotation. */
export const SEAL_KEY_PREVIOUS_ENV = "CAELO_MCP_OAUTH_SEAL_KEY_PREVIOUS";
/** The gateway env var holding the current key (stack-contract SERVICE_SECRET_ENV). */
export const SEAL_KEY_ENV = "CAELO_MCP_OAUTH_SEAL_KEY";
/** Label on the gateway service: when the rotation started (epoch ms). */
export const SEAL_ROTATION_LABEL = "caelo-seal-rotation-started";
/**
 * Days the previous key must stay: the broker's refresh-token lifetime
 * (api-gateway mcp/token.ts REFRESH_MAX_LIFETIME_SECONDS, 30 days).
 */
export const SEAL_KEY_ROTATION_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The deployed gateway a rotation works on. */
export interface SealRotationTarget {
  readonly projectId: string;
  readonly region: string;
  readonly env: string;
  /** Deployed (Pulumi-suffixed) gateway Cloud Run service name. */
  readonly gatewayService: string;
}

export interface SealRotationReport {
  readonly ok: boolean;
  readonly steps: string[];
  readonly error?: string;
}

export interface SealRotationDeps {
  readonly run?: GcloudRunner;
  readonly nowMs?: () => number;
  /** The new key (default: 32 random bytes, base64 — the secret's format). */
  readonly generate?: () => string;
}

interface GatewayState {
  readonly previousPinned: boolean;
  readonly startedAtMs: number | null;
}

async function gatewayState(
  run: GcloudRunner,
  t: SealRotationTarget,
): Promise<{ ok: true; state: GatewayState } | { ok: false; error: string }> {
  const r = await run([
    "run",
    "services",
    "describe",
    t.gatewayService,
    "--region",
    t.region,
    `--project=${t.projectId}`,
    "--format=json",
  ]);
  if (!r.ok) return { ok: false, error: `read the gateway service: ${r.stderr.trim()}` };
  const env = liveContainerEnv(r.stdout);
  const labels =
    (JSON.parse(r.stdout) as { metadata?: { labels?: Record<string, string> } }).metadata?.labels ??
    {};
  const raw = labels[SEAL_ROTATION_LABEL];
  const started = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
  const current = env.get(SEAL_KEY_ENV);
  if (current?.kind !== "secret") {
    return {
      ok: false,
      error: `${SEAL_KEY_ENV} on ${t.gatewayService} is not a Secret Manager reference — run \`cms-provision upgrade\` first (it installs remote MCP's secrets).`,
    };
  }
  return {
    ok: true,
    state: { previousPinned: env.has(SEAL_KEY_PREVIOUS_ENV), startedAtMs: started },
  };
}

function rollFlip(t: SealRotationTarget): string[] {
  return [
    "run",
    "services",
    "update-traffic",
    t.gatewayService,
    "--region",
    t.region,
    `--project=${t.projectId}`,
    "--to-latest",
    "--quiet",
  ];
}

/** Start a rotation: new key at `latest`, the old one pinned as previous. */
export async function startSealKeyRotation(
  t: SealRotationTarget,
  deps: SealRotationDeps = {},
): Promise<SealRotationReport> {
  const run = deps.run ?? defaultGcloud;
  const now = (deps.nowMs ?? Date.now)();
  const generate = deps.generate ?? (() => initialSecretValue("mcp-oauth-seal-key"));
  const secretId = gcpSecretId(t.env, "mcp-oauth-seal-key");
  const project = `--project=${t.projectId}`;
  const steps: string[] = [];

  const live = await gatewayState(run, t);
  if (!live.ok) return { ok: false, steps, error: live.error };
  if (live.state.previousPinned) {
    const since = live.state.startedAtMs;
    return {
      ok: false,
      steps,
      error: `A seal-key rotation is already in progress${since ? ` (started ${new Date(since).toISOString()})` : ""}. Finish it first with \`cms-provision rotate-secret mcp-oauth-seal-key --finish\` once ${SEAL_KEY_ROTATION_WINDOW_DAYS} days have passed; starting again now would drop the previous key early.`,
    };
  }

  const latest = await run([
    "secrets",
    "versions",
    "describe",
    "latest",
    `--secret=${secretId}`,
    project,
    "--format=value(name)",
  ]);
  const version = /\/versions\/(\d+)\s*$/.exec(latest.stdout.trim())?.[1];
  if (!latest.ok || !version) {
    return {
      ok: false,
      steps,
      error: `find the current version of ${secretId}: ${latest.ok ? `unexpected answer "${latest.stdout.trim()}"` : latest.stderr.trim()}`,
    };
  }

  const add = await run(["secrets", "versions", "add", secretId, project, "--data-file=-"], {
    stdin: generate(),
  });
  if (!add.ok) {
    return { ok: false, steps, error: `add a version to ${secretId}: ${add.stderr.trim()}` };
  }
  steps.push(`added a new version to ${secretId} (the previous key is version ${version})`);

  const update = [
    "run",
    "services",
    "update",
    t.gatewayService,
    "--region",
    t.region,
    project,
    `--update-secrets=${SEAL_KEY_ENV}=${secretId}:latest,${SEAL_KEY_PREVIOUS_ENV}=${secretId}:${version}`,
    `--update-labels=${SEAL_ROTATION_LABEL}=${now}`,
    "--quiet",
  ];
  const rolled = await run(update);
  const flipped = rolled.ok ? await run(rollFlip(t)) : rolled;
  if (!flipped.ok) {
    return {
      ok: false,
      steps,
      error: `The new key is stored but the gateway does not use it yet. Do not rotate again — roll the gateway:\n    gcloud ${update.join(" ")}\n    gcloud ${rollFlip(t).join(" ")}\n(${flipped.stderr.trim()})`,
    };
  }
  steps.push(
    `rolled the gateway onto the new key; tokens sealed under version ${version} keep working`,
    `finish after ${new Date(now + SEAL_KEY_ROTATION_WINDOW_DAYS * DAY_MS).toISOString()} with: cms-provision rotate-secret mcp-oauth-seal-key --finish`,
    "a `cms-provision upgrade` before then drops the previous key early: clients sealed under it sign in again",
  );
  return { ok: true, steps };
}

/** Finish a rotation: drop the previous key once the window has passed. */
export async function finishSealKeyRotation(
  t: SealRotationTarget,
  deps: SealRotationDeps = {},
  opts: { readonly now?: boolean } = {},
): Promise<SealRotationReport> {
  const run = deps.run ?? defaultGcloud;
  const now = (deps.nowMs ?? Date.now)();
  const steps: string[] = [];
  const live = await gatewayState(run, t);
  if (!live.ok) return { ok: false, steps, error: live.error };
  if (!live.state.previousPinned) {
    return {
      ok: false,
      steps,
      error: `No seal-key rotation is in progress on ${t.gatewayService} (${SEAL_KEY_PREVIOUS_ENV} is not set). Start one with \`cms-provision rotate-secret mcp-oauth-seal-key\`.`,
    };
  }
  const started = live.state.startedAtMs;
  const due = started === null ? null : started + SEAL_KEY_ROTATION_WINDOW_DAYS * DAY_MS;
  if (!opts.now && (due === null || now < due)) {
    return {
      ok: false,
      steps,
      error:
        due === null
          ? `The gateway has ${SEAL_KEY_PREVIOUS_ENV} but no ${SEAL_ROTATION_LABEL} label, so the rotation's start is unknown. Wait ${SEAL_KEY_ROTATION_WINDOW_DAYS} days from when it started, then run --finish --now.`
          : `The previous key still opens refresh tokens until ${new Date(due).toISOString()} (${SEAL_KEY_ROTATION_WINDOW_DAYS}-day lifetime). Finishing now would sign those clients out; run --finish after that time, or --finish --now if the old key leaked.`,
    };
  }
  const update = [
    "run",
    "services",
    "update",
    t.gatewayService,
    "--region",
    t.region,
    `--project=${t.projectId}`,
    `--remove-secrets=${SEAL_KEY_PREVIOUS_ENV}`,
    `--remove-labels=${SEAL_ROTATION_LABEL}`,
    "--quiet",
  ];
  const rolled = await run(update);
  const flipped = rolled.ok ? await run(rollFlip(t)) : rolled;
  if (!flipped.ok) {
    return { ok: false, steps, error: `roll the gateway: ${flipped.stderr.trim()}` };
  }
  steps.push("removed the previous seal key from the gateway; the rotation is complete");
  return { ok: true, steps };
}

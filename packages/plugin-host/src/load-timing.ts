// SPDX-License-Identifier: MPL-2.0

/**
 * How long each step of one plugin load took (issue #1633).
 *
 * A new admin instance answers its first request only once every active
 * plugin is loaded. On searchVIU (2026-11-16) a load took 0.3 s when the
 * database was quiet and 20 to 130 s per plugin while it was CPU-bound,
 * and nothing said which step the time went to. Every load now logs one
 * line with its steps, so the next slow start names the step.
 *
 * The steps of one attempt are collected in an async-local scope opened by
 * {@link withLoadTiming} (load-outcome.ts, around every load attempt);
 * {@link timedStep} outside such a scope just runs its function.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The steps of a plugin load, in the order a load runs them. */
export type LoadStep =
  | "verify"
  | "register"
  | "provision"
  | "activation lease"
  | "activate"
  | "list types"
  | "skills"
  | "runtime record";

const scope = new AsyncLocalStorage<Map<LoadStep, number>>();

/**
 * Run `fn` and add its duration to `step` of the load attempt in progress.
 * A step that runs twice (two schemas provisioned) adds up.
 */
export async function timedStep<T>(step: LoadStep, fn: () => Promise<T> | T): Promise<T> {
  const steps = scope.getStore();
  if (!steps) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    steps.set(step, (steps.get(step) ?? 0) + (performance.now() - started));
  }
}

/** Run one load attempt with a fresh set of step durations. */
export async function withLoadTiming<T>(
  fn: () => Promise<T>,
): Promise<{ readonly value: T; readonly steps: ReadonlyMap<LoadStep, number> }> {
  const steps = new Map<LoadStep, number>();
  const value = await scope.run(steps, fn);
  return { value, steps };
}

/** Seconds with one decimal, as the boot log prints them. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The log line of one load, e.g.
 * `consent-manager loaded in 113.2 s (register 2.1 s, provision 9.8 s, …)`.
 * Steps keep the order the load ran them in.
 */
export function describeLoadTiming(
  slug: string,
  totalMs: number,
  steps: ReadonlyMap<LoadStep, number>,
): string {
  const parts = [...steps].map(([step, ms]) => `${step} ${seconds(ms)}`);
  return `${slug} loaded in ${seconds(totalMs)}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

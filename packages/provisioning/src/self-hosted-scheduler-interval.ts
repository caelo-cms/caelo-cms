// SPDX-License-Identifier: MPL-2.0

/**
 * #1140 — the self-hosted scheduler interval has two places it can be set:
 * `cms-provision init --scheduler-interval-minutes` records it in
 * `.caelo/config.json` (which every CLI render — `up`, `upgrade`, agent
 * apply — reads), and the Pulumi stack has the config key
 * `caelo-self-hosted:schedulerIntervalMinutes`. Both rewrite the same
 * `docker-compose.yml`, so if each read only its own source a `pulumi up`
 * over a CLI install would silently put the interval back to the default,
 * and the next CLI `upgrade` would undo a Pulumi-only value the same way.
 *
 * The recorded `.caelo/config.json` is the install's one record (the CLI
 * renders from nothing else), so the stack takes the interval from it; the
 * Pulumi key may restate it but a different value is refused rather than
 * one side winning silently (CLAUDE.md §2: no fallbacks).
 */

import { existsSync, readFileSync } from "node:fs";
import { parseSchedulerIntervalMinutes } from "./stack-contract.js";

/**
 * Read the interval `init` recorded in a `.caelo/config.json`.
 *
 * @param configPath - the install's `config.json`.
 * @returns the recorded minutes, or undefined when there is no config.json
 *   (a Pulumi-only install) or it records no interval (the default).
 * @throws when the file is not JSON or the recorded value is out of bounds.
 */
export function recordedSchedulerIntervalMinutes(configPath: string): number | undefined {
  if (!existsSync(configPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`${configPath} is not valid JSON: ${(e as Error).message}`);
  }
  const raw =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { schedulerIntervalMinutes?: unknown }).schedulerIntervalMinutes
      : undefined;
  if (raw === undefined) return undefined;
  if (typeof raw !== "number") {
    throw new Error(
      `${configPath}: schedulerIntervalMinutes ${JSON.stringify(raw)} is not a number of minutes`,
    );
  }
  return parseSchedulerIntervalMinutes(raw, `${configPath}: schedulerIntervalMinutes`);
}

/**
 * The interval the self-hosted Pulumi stack renders into the Compose file.
 *
 * @param pulumiValue - `caelo-self-hosted:schedulerIntervalMinutes`, if set.
 * @param recorded - what {@link recordedSchedulerIntervalMinutes} read.
 * @param configPath - named in the refusal.
 * @returns the minutes to render; undefined means neither source sets one
 *   (the generator's default).
 * @throws when both are set and differ.
 */
export function selfHostedSchedulerIntervalMinutes(
  pulumiValue: number | undefined,
  recorded: number | undefined,
  configPath: string,
): number | undefined {
  if (pulumiValue === undefined) return recorded;
  const minutes = parseSchedulerIntervalMinutes(
    pulumiValue,
    "caelo-self-hosted:schedulerIntervalMinutes",
  );
  if (recorded !== undefined && recorded !== minutes) {
    throw new Error(
      `caelo-self-hosted:schedulerIntervalMinutes is ${minutes} but ${configPath} records ${recorded}; ` +
        "the CLI renders the Compose file from config.json, so the two must agree. " +
        `Set the Pulumi key to ${recorded}, or remove it (\`pulumi config rm caelo-self-hosted:schedulerIntervalMinutes\`) to use the recorded value.`,
    );
  }
  return minutes;
}

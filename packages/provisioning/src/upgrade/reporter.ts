// SPDX-License-Identifier: MPL-2.0

/**
 * How the upgrade phases (converge.ts, app-roll.ts) tell the operator what
 * they do. The CLI renders it with clack spinners; the in-cloud upgrader job
 * (epic #696) will write the same lines to its run log, and the tests record
 * them. The phases never import a terminal UI themselves.
 */

import { log, spinner } from "@clack/prompts";
import { green, red, yellow } from "kleur/colors";

/** One long-running step: started once, ended exactly once. */
export interface ReportStep {
  done(message: string): void;
  failed(message: string): void;
  /** Ended without success, but the upgrade continues. */
  warned(message: string): void;
  /** Still running: say what it is waiting for now. */
  progress(message: string): void;
}

export interface UpgradeReporter {
  step(label: string): ReportStep;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;
}

/** The CLI's reporter: a clack spinner per step, colored log lines. */
export function clackReporter(): UpgradeReporter {
  return {
    step(label) {
      const s = spinner();
      s.start(label);
      return {
        done: (m) => s.stop(green(m)),
        failed: (m) => s.stop(red(m)),
        warned: (m) => s.stop(yellow(m)),
        progress: (m) => s.message(m),
      };
    },
    info: (m) => log.info(m),
    warn: (m) => log.warn(yellow(m)),
    error: (m) => log.error(red(m)),
    success: (m) => log.success(m),
  };
}

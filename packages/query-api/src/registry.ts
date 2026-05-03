// SPDX-License-Identifier: MPL-2.0

import type { Result } from "@caelo-cms/shared";
import { err, ok } from "@caelo-cms/shared";
import type { QueryError } from "./errors.js";
import type { OperationDefinition } from "./operation.js";

/**
 * Central registry of operations. An operation the registry has not seen is not
 * callable — `lookup()` returns `Err('UnknownOperation')` rather than throwing,
 * so the Adapter's execute path can surface the failure uniformly.
 *
 * Phases beyond P1 register their operations at module import time by importing
 * a `registerCoreOperations()` helper per area.
 */
export class OperationRegistry {
  readonly #byName = new Map<string, OperationDefinition<unknown, unknown>>();

  register<I, O>(op: OperationDefinition<I, O>): void {
    if (this.#byName.has(op.name)) {
      throw new Error(`operation '${op.name}' is already registered`);
    }
    this.#byName.set(op.name, op as OperationDefinition<unknown, unknown>);
  }

  lookup(name: string): Result<OperationDefinition<unknown, unknown>, QueryError> {
    const op = this.#byName.get(name);
    if (!op) return err({ kind: "UnknownOperation", name });
    return ok(op);
  }

  has(name: string): boolean {
    return this.#byName.has(name);
  }

  names(): readonly string[] {
    return [...this.#byName.keys()];
  }

  /** Test-only. Production code should not mutate the registry after startup. */
  clear(): void {
    this.#byName.clear();
  }
}

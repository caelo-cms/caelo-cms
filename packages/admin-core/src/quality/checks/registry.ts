// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #727 — the check registry: every check the quality audit of a
 * Stage runs, Lighthouse included.
 *
 * Two kinds of entries:
 * - `findings`: a `QualityCheck` (check.ts). Cheap; runs on EVERY Stage
 *   (SEO-only Stages too) against ALL pages of the staged build.
 * - `lighthouse`: the browser audit. It keeps its own rules unchanged —
 *   the Stage classification decides whether it runs (classify.ts), it
 *   covers the homepage plus up to five changed pages, and its scores go
 *   through the per-category ratchet (ratchet.ts).
 *
 * `source` records who contributed an entry. Core registers Lighthouse and
 * its own findings check, `structure` (#820: repeated free markup that
 * should be a module — maintainer decision: a core topic like Lighthouse,
 * not a plugin add-on). The rule about pages without a meta description
 * is enforced before the build by `deploy.trigger` (#730,
 * deploy/missing-seo.ts), so a staged build can never contain such a page.
 * Plugins add further findings checks (#727, the `checks` composition
 * point) with `{ kind: "plugin", slug }` through the same `register`.
 */

import type { AuditJob } from "../lighthouse-protocol.js";
import { type AuditJobResult, runAuditJob } from "../lighthouse-runner.js";
import type { QualityCheck } from "./check.js";
import { checkIdSchema } from "./findings.js";
import { createStructureCheck, type StructureSources } from "./structure.js";

/** Who contributed a check. */
export type CheckSource =
  | { readonly kind: "core" }
  | { readonly kind: "plugin"; readonly slug: string };

/** The Lighthouse runner: one job (pages + runs) in, measurements out. */
export type LighthouseRunner = (job: AuditJob) => Promise<AuditJobResult>;

/** The reserved id of the Lighthouse entry. */
export const LIGHTHOUSE_CHECK_ID = "lighthouse";

export type RegisteredCheck =
  | {
      readonly kind: "findings";
      readonly id: string;
      readonly title: string;
      readonly scope: QualityCheck["scope"];
      readonly source: CheckSource;
      readonly check: QualityCheck;
    }
  | {
      readonly kind: "lighthouse";
      readonly id: typeof LIGHTHOUSE_CHECK_ID;
      readonly title: string;
      readonly scope: "page";
      readonly source: CheckSource;
      readonly run: LighthouseRunner;
    };

const CORE: CheckSource = { kind: "core" };

/** The ordered set of checks one audit runs. */
export class CheckRegistry {
  readonly #entries = new Map<string, RegisteredCheck>();

  /**
   * Add a findings check. Throws on an invalid or duplicate id — a check
   * that silently shadows another would hide its findings.
   */
  register(check: QualityCheck, source: CheckSource): void {
    const parsed = checkIdSchema.safeParse(check.id);
    if (!parsed.success) {
      throw new Error(
        `quality check id '${check.id}' is invalid: ${parsed.error.issues[0]?.message ?? "bad id"}`,
      );
    }
    if (check.id === LIGHTHOUSE_CHECK_ID || this.#entries.has(check.id)) {
      throw new Error(`quality check id '${check.id}' is already registered`);
    }
    this.#entries.set(check.id, {
      kind: "findings",
      id: check.id,
      title: check.title,
      scope: check.scope,
      source,
      check,
    });
  }

  /** Set the Lighthouse entry (core only; there is exactly one). */
  registerLighthouse(run: LighthouseRunner): void {
    if (this.#entries.has(LIGHTHOUSE_CHECK_ID)) {
      throw new Error("the Lighthouse check is already registered");
    }
    this.#entries.set(LIGHTHOUSE_CHECK_ID, {
      kind: "lighthouse",
      id: LIGHTHOUSE_CHECK_ID,
      title: "Lighthouse",
      scope: "page",
      source: CORE,
      run,
    });
  }

  /** Every entry, in registration order. */
  list(): readonly RegisteredCheck[] {
    return [...this.#entries.values()];
  }

  /** The findings checks only (what runs on every Stage). */
  findingChecks(): readonly Extract<RegisteredCheck, { kind: "findings" }>[] {
    return this.list().filter((e) => e.kind === "findings");
  }

  /** The Lighthouse entry, or null when this registry has none. */
  lighthouse(): Extract<RegisteredCheck, { kind: "lighthouse" }> | null {
    const e = this.#entries.get(LIGHTHOUSE_CHECK_ID);
    return e?.kind === "lighthouse" ? e : null;
  }
}

/**
 * The checks core ships: Lighthouse and the `structure` findings check.
 *
 * @param options.structure - where the structure check reads module
 *   templates and layouts (required: a core check that silently did not
 *   run would read as "no findings").
 */
export function createCoreCheckRegistry(options: {
  readonly lighthouse?: LighthouseRunner;
  readonly structure: StructureSources;
}): CheckRegistry {
  const registry = new CheckRegistry();
  registry.registerLighthouse(options.lighthouse ?? runAuditJob);
  registry.register(createStructureCheck(options.structure), CORE);
  return registry;
}

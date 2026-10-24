// SPDX-License-Identifier: MPL-2.0

/**
 * What a Pulumi preview would change, per resource (#737). `state migrate`
 * used to refuse with "a preview shows 36 change(s)" and the installer ran
 * `pulumi up` blind, so an operator could not tell an IAM tweak from a
 * Cloud SQL replace without assembling a `pulumi preview --diff` by hand.
 *
 * {@link collectPreviewSteps} turns the Automation API's engine events into
 * {@link PlannedStep}s; {@link formatPlan} groups them (creates / updates /
 * REPLACES / DELETES) and names the resources whose replace or delete loses
 * data; {@link writePlanFile} keeps the full diff next to the install.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent, OpType } from "@pulumi/pulumi/automation";

/** The operations a plan lists; the rest (same, read, refresh) change nothing. */
export type PlannedOp = "create" | "update" | "replace" | "delete" | "import";

/** One resource a preview would change. */
export interface PlannedStep {
  readonly op: PlannedOp;
  /** The Pulumi type token, e.g. `gcp:sql/databaseInstance:DatabaseInstance`. */
  readonly type: string;
  /** The resource's name in the program (the URN's last segment). */
  readonly name: string;
  readonly urn: string;
  /** Properties that change. */
  readonly diffs: readonly string[];
  /** Properties that force the replace (replace steps only). */
  readonly replaceReasons: readonly string[];
  /**
   * The inputs the program declares, for create steps only (#1079: they name
   * the cloud resource a create would make, e.g. a service account's
   * `accountId`, so adopt-existing.ts can tell whether it exists already).
   * Secret values arrive masked by the engine. Never written to a plan file.
   */
  readonly inputs?: Readonly<Record<string, unknown>>;
}

/**
 * The step ops that make one planned change. A replace also emits
 * `create-replacement` / `delete-replaced` sub-steps for the same URN; they
 * are the same change and are not counted again.
 */
const PLANNED: Readonly<Partial<Record<OpType, PlannedOp>>> = {
  create: "create",
  update: "update",
  replace: "replace",
  delete: "delete",
  import: "import",
  "import-replacement": "replace",
};

/**
 * Resources whose replace or delete loses data, by Pulumi type token, with
 * the name an operator knows them by. Replacing any of them is never a
 * "state catching up" detail.
 */
const DATA_BEARING: Readonly<Record<string, string>> = {
  "gcp:sql/databaseInstance:DatabaseInstance": "Cloud SQL instance (all site data)",
  "gcp:sql/database:Database": "Cloud SQL database",
  "gcp:storage/bucket:Bucket": "Cloud Storage bucket (media, published site or state)",
  "gcp:secretmanager/secret:Secret": "Secret Manager secret",
  "gcp:secretmanager/secretVersion:SecretVersion": "Secret Manager secret value",
  "gcp:firebase/project:Project": "Firebase project",
  "gcp:firebase/hostingSite:HostingSite": "Firebase Hosting site",
  "gcp:kms/keyRing:KeyRing": "Cloud KMS key ring",
  "gcp:kms/cryptoKey:CryptoKey": "Cloud KMS key (decrypts the install's state)",
  "gcp:bigquery/dataset:Dataset": "BigQuery dataset (edge logs)",
};

/** What a data-bearing resource holds, or null for any other type. */
export function dataBearingKind(type: string): string | null {
  return DATA_BEARING[type] ?? null;
}

/** Whether `step` would destroy data: a replace or delete of a data-bearing resource. */
export function losesData(step: PlannedStep): boolean {
  return (step.op === "replace" || step.op === "delete") && dataBearingKind(step.type) !== null;
}

/** Whether the plan replaces or deletes anything. */
export function hasReplaceOrDelete(steps: readonly PlannedStep[]): boolean {
  return steps.some((s) => s.op === "replace" || s.op === "delete");
}

/** The URN's last `::` segment: the name the program gave the resource. */
function urnName(urn: string): string {
  return urn.split("::").at(-1) ?? urn;
}

/**
 * Collects a preview's planned steps from its engine events: pass
 * {@link PreviewCollector.onEvent} as the preview's `onEvent`, read
 * {@link PreviewCollector.steps} afterwards. One step per URN.
 */
export interface PreviewCollector {
  readonly onEvent: (event: EngineEvent) => void;
  steps(): PlannedStep[];
}

/** A fresh {@link PreviewCollector}. */
export function collectPreviewSteps(): PreviewCollector {
  const byUrn = new Map<string, PlannedStep>();
  return {
    onEvent: (event) => {
      const m = event.resourcePreEvent?.metadata;
      if (!m) return;
      const op = PLANNED[m.op];
      // The stack resource itself and providers are bookkeeping, not cloud changes.
      if (!op || m.type === "pulumi:pulumi:Stack" || m.type.startsWith("pulumi:providers:")) {
        return;
      }
      const prior = byUrn.get(m.urn);
      if (prior?.op === "replace") return;
      byUrn.set(m.urn, {
        op,
        type: m.type,
        name: urnName(m.urn),
        urn: m.urn,
        diffs: [...(m.diffs ?? [])],
        replaceReasons: op === "replace" ? [...(m.keys ?? [])] : [],
        ...(op === "create" && m.new?.inputs ? { inputs: { ...m.new.inputs } } : {}),
      });
    },
    steps: () => [...byUrn.values()],
  };
}

const GROUPS: readonly { readonly op: PlannedOp; readonly title: string }[] = [
  { op: "delete", title: "DELETES" },
  { op: "replace", title: "REPLACES (delete + create)" },
  { op: "update", title: "Updates in place" },
  { op: "create", title: "Creates" },
  { op: "import", title: "Imports" },
];

/** One line for `step`: type, name, what changes and why it is replaced. */
function stepLine(step: PlannedStep): string {
  const kind = dataBearingKind(step.type);
  const data = losesData(step) && kind ? `  <-- LOSES DATA: ${kind}` : "";
  const why =
    step.op === "replace" && step.replaceReasons.length > 0
      ? ` (replaced because ${step.replaceReasons.join(", ")} changes)`
      : step.diffs.length > 0 && step.op !== "create"
        ? ` (${step.diffs.join(", ")})`
        : "";
  return `  ${step.type} ${step.name}${why}${data}`;
}

/**
 * The plan as grouped lines, destructive groups first. Empty plan: one line
 * saying so.
 */
export function formatPlan(steps: readonly PlannedStep[]): string[] {
  if (steps.length === 0) return ["The preview plans no changes."];
  const lines: string[] = [];
  for (const g of GROUPS) {
    const inGroup = steps.filter((s) => s.op === g.op);
    if (inGroup.length === 0) continue;
    lines.push(`${g.title} (${inGroup.length}):`, ...inGroup.map(stepLine));
  }
  const lost = steps.filter(losesData);
  if (lost.length > 0) {
    lines.push(
      "",
      `${lost.length} of these would destroy data: ${lost.map((s) => `${dataBearingKind(s.type)} ${s.name}`).join("; ")}.`,
    );
  }
  return lines;
}

/**
 * Write the full plan (every step with every changed property) to a file in
 * `installRoot` and return its path. Names and property paths only, never
 * values: the file holds no secret.
 *
 * @param label what the preview was for, part of the file name (`state-migrate`, `installer`)
 */
export function writePlanFile(
  installRoot: string,
  label: string,
  steps: readonly PlannedStep[],
  now: Date = new Date(),
): string {
  const path = join(installRoot, `plan-${label}-${now.toISOString().replace(/[:.]/g, "-")}.txt`);
  const body = [
    `Pulumi preview (${label}), ${now.toISOString()}: ${steps.length} change(s)`,
    "",
    ...formatPlan(steps),
    "",
    "Every step:",
    ...steps.map((s) =>
      [
        `- ${s.op} ${s.urn}`,
        ...(s.replaceReasons.length > 0
          ? [`    replaced because: ${s.replaceReasons.join(", ")}`]
          : []),
        ...(s.diffs.length > 0 ? [`    changes: ${s.diffs.join(", ")}`] : []),
      ].join("\n"),
    ),
    "",
  ].join("\n");
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

/** What the installer does with a plan before `pulumi up` (#737). */
export type PlanGate =
  /** Nothing is replaced or deleted: apply. */
  | { readonly kind: "proceed" }
  /** Ask the operator y/N; `losesData` makes the question explicit about it. */
  | { readonly kind: "confirm"; readonly losesData: boolean }
  /** Nobody can be asked and data would be lost: stop, nothing applied. */
  | { readonly kind: "refuse" };

/**
 * The gate for `steps`. A replace or delete is asked about whenever someone
 * can answer. Without a terminal (`--non-interactive`, the install job)
 * replaces and deletes of resources without data go ahead, already listed;
 * a data-bearing one is refused: no flag stands in for that yes.
 */
export function planGate(
  steps: readonly PlannedStep[],
  opts: { readonly interactive: boolean },
): PlanGate {
  if (!hasReplaceOrDelete(steps)) return { kind: "proceed" };
  const lost = steps.some(losesData);
  if (opts.interactive) return { kind: "confirm", losesData: lost };
  return lost ? { kind: "refuse" } : { kind: "proceed" };
}

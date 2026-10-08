// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 — decide from a Stage's changes whether it needs a quality
 * audit. Pure: the `quality_audits.classify_stage` op reads the chat
 * branch's typed snapshots (the same window `chat.list_pending_changes`
 * shows: everything since the chat's last Stage), reduces each entity to a
 * `StageChange`, and hands the list here.
 *
 * Audit when the Stage can change how pages render or perform:
 * - module html/css/js created or changed;
 * - layout, template or theme changes;
 * - new pages (created, or published for the first time);
 * - plugin configuration that renders on pages.
 *
 * Skip when it only changes what pages say or where things sit:
 * - field values (headlines, text, links) — content instances;
 * - an existing, unchanged module placed or moved — page placements;
 * - page metadata (title, slug), navigation lists, deletions;
 * - SEO texts and redirects (not branch-scoped, so never in the list).
 *
 * The first Stage of a site and plugin activations are decided by the
 * `quality_audits.enqueue` op from install-wide state, not from the branch.
 */

/** One entity a Stage changes, reduced to what the decision needs. */
export type StageChange =
  | {
      readonly entity: "module";
      readonly entityId: string;
      readonly label: string;
      /** `code_changed` = html, css or js differs from the main version;
       *  `other` = only the field schema or metadata changed. */
      readonly change: "created" | "code_changed" | "other" | "deleted";
    }
  | { readonly entity: "template"; readonly entityId: string; readonly label: string }
  | { readonly entity: "layout"; readonly entityId: string; readonly label: string }
  | { readonly entity: "theme"; readonly entityId: string; readonly label: string }
  | {
      readonly entity: "page";
      readonly entityId: string;
      readonly label: string;
      /** `published` = was not live on main and is published now;
       *  `template_changed` = a live page moved to another template. */
      readonly change: "created" | "published" | "template_changed" | "updated" | "deleted";
    }
  | { readonly entity: "placement"; readonly entityId: string; readonly label: string }
  | { readonly entity: "content"; readonly entityId: string; readonly label: string }
  | { readonly entity: "list"; readonly entityId: string; readonly label: string }
  | { readonly entity: "pluginConfig"; readonly entityId: string; readonly label: string };

/** Why a Stage is (or is not) audited — one entry per deciding change. */
export interface ClassificationReason {
  readonly rule:
    | "module_code"
    | "layout"
    | "template"
    | "theme"
    | "new_page"
    | "plugin_config"
    | "first_stage"
    | "plugin_activation"
    | "no_chat_context"
    | "previous_not_clean";
  readonly entityId: string | null;
  readonly label: string;
}

export interface StageClassification {
  readonly auditNeeded: boolean;
  /** The changes that make the audit necessary; empty when skipped. */
  readonly reasons: readonly ClassificationReason[];
  /** Short labels of the changes that were looked at and do NOT need an
   *  audit, so a skip is explainable ("only text and placements changed"). */
  readonly skipped: readonly string[];
}

/** Map one change to the rule that makes it audit-worthy, or null. */
function ruleFor(change: StageChange): ClassificationReason["rule"] | null {
  switch (change.entity) {
    case "module":
      return change.change === "created" || change.change === "code_changed" ? "module_code" : null;
    case "template":
      return "template";
    case "layout":
      return "layout";
    case "theme":
      return "theme";
    case "page":
      if (change.change === "template_changed") return "template";
      return change.change === "created" || change.change === "published" ? "new_page" : null;
    case "pluginConfig":
      return "plugin_config";
    case "placement":
    case "content":
    case "list":
      return null;
  }
}

function skippedLabel(change: StageChange): string {
  switch (change.entity) {
    case "module":
      return change.change === "deleted"
        ? `module deleted: ${change.label}`
        : `module fields/metadata only: ${change.label}`;
    case "page":
      return `page ${change.change}: ${change.label}`;
    case "placement":
      return `placements: ${change.label}`;
    case "content":
      return `field values: ${change.label}`;
    case "list":
      return `list: ${change.label}`;
    default:
      return change.label;
  }
}

/**
 * Classify a Stage's branch changes.
 *
 * @param changes - every entity the Stage merges (any order).
 * @returns `auditNeeded` plus the reasons; deterministic for a given input
 *   (reasons follow the input order).
 */
export function classifyStageChanges(changes: readonly StageChange[]): StageClassification {
  const reasons: ClassificationReason[] = [];
  const skipped: string[] = [];
  for (const change of changes) {
    const rule = ruleFor(change);
    if (rule === null) {
      skipped.push(skippedLabel(change));
      continue;
    }
    reasons.push({ rule, entityId: change.entityId, label: change.label });
  }
  return { auditNeeded: reasons.length > 0, reasons, skipped };
}

/**
 * Fold the install-wide rules into a branch classification. These audit
 * regardless of what the branch changed:
 * - a staging deploy without a chat (Ops "Deploy staging", the pages
 *   list's Stage) — there is no branch to prove the change small;
 * - the first Stage of the site;
 * - a plugin activated since the previous Stage (activation is not
 *   branch-scoped, so the branch never shows it);
 * - the previous Stage's audit did not end clean (problems, a failure, or
 *   it never ran): staging always holds the whole site, so skipping now
 *   would let unresolved problems through on a text-only follow-up.
 */
export function withInstallRules(
  branch: StageClassification | null,
  install: {
    readonly firstStage: boolean;
    readonly activatedPlugins: readonly { readonly id: string; readonly slug: string }[];
    /** The previous staging deploy's latest audit when it did not end
     *  clean (`missing` = that deploy has no audit at all; the id is then
     *  the deploy run's); null when it passed or was legitimately skipped. */
    readonly previousNotClean: { readonly auditRunId: string; readonly status: string } | null;
  },
): StageClassification {
  const reasons: ClassificationReason[] = [...(branch?.reasons ?? [])];
  if (branch === null) {
    reasons.push({
      rule: "no_chat_context",
      entityId: null,
      label: "staging deploy outside a chat",
    });
  }
  if (install.firstStage) {
    reasons.push({ rule: "first_stage", entityId: null, label: "first Stage of the site" });
  }
  for (const p of install.activatedPlugins) {
    reasons.push({
      rule: "plugin_activation",
      entityId: p.id,
      label: `plugin activated: ${p.slug}`,
    });
  }
  if (install.previousNotClean) {
    reasons.push({
      rule: "previous_not_clean",
      entityId: install.previousNotClean.auditRunId,
      label:
        install.previousNotClean.status === "missing"
          ? "previous Stage was never audited"
          : `previous Stage's audit is ${install.previousNotClean.status}`,
    });
  }
  return { auditNeeded: reasons.length > 0, reasons, skipped: branch?.skipped ?? [] };
}

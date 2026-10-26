// SPDX-License-Identifier: MPL-2.0

/**
 * Declarative admin panels: the pages a plugin adds to the admin.
 *
 * A panel is DATA, never UI code. The admin renders every panel with one
 * generic renderer (`/plugins/<slug>/<panel>`), so a plugin shipped with a
 * release and one installed at runtime get exactly the same kind of page
 * (one plugin model, CLAUDE.md §2), the page exists only while the plugin
 * is active (it is read from the running host's loaded plugins), and no
 * plugin code ever runs in the operator's browser.
 *
 * Every value a panel shows comes from the plugin's own operations and is
 * rendered as text: plugin data can be visitor-written, so the renderer
 * never interprets it as markup (#635).
 *
 * The vocabulary is deliberately small. Four section kinds:
 *   - `table`    rows from an operation, with filters, paging, per-row,
 *                bulk and toolbar actions, and a CSV download;
 *   - `stats`    labelled numbers from an operation;
 *   - `settings` a form pre-filled from one operation and saved by another;
 *   - `form`     a blank form that submits once to an operation (e.g.
 *                "draft a campaign").
 * A row action may carry a `review` step: the operator first sees exactly
 * what the action will act on, and what they saw is what is submitted
 * (the newsletter's "send exactly this" approval).
 *
 * @example
 *   adminPanels: [{
 *     slug: "inbox", title: "Form submissions", icon: "inbox",
 *     description: "Messages visitors sent through your forms.",
 *     permission: "settings.write",
 *     sections: [{
 *       kind: "table", id: "submissions", title: "Inbox",
 *       operation: "list_submissions", rowsKey: "submissions", rowKey: "id",
 *       emptyMessage: "No submissions in this view.",
 *       columns: [
 *         { key: "form_slug", label: "Form", format: "text" },
 *         { key: "submitted_at", label: "Submitted", format: "datetime" },
 *       ],
 *       rowActions: [{
 *         id: "archive", label: "Archive", operation: "archive", variant: "outline",
 *         rowArgs: { submissionId: "id" }, successMessage: "Archived.",
 *       }],
 *     }],
 *   }],
 */

import { z } from "zod";

/**
 * The admin's permission catalog (`@caelo-cms/admin-core` PERMISSIONS).
 * Repeated here because the SDK cannot depend on admin-core; a test in
 * admin-core fails when the two drift apart.
 */
export const PLUGIN_PANEL_PERMISSIONS = [
  "content.read",
  "content.write",
  "content.structure",
  "deploy.trigger",
  "ops.view",
  "plugins.approve",
  "plugins.install",
  "users.manage",
  "roles.manage",
  "settings.read",
  "settings.write",
  "drafts.view_all",
  "platform.update",
  "privacy.view",
] as const;

/** Who may open a panel and run its actions: one permission of the catalog. */
export const pluginPanelPermission = z.enum(PLUGIN_PANEL_PERMISSIONS);

/** Icons a panel can use in the admin's navigation (a subset of the admin's own icon set). */
export const pluginPanelIcon = z.enum([
  "activity",
  "bot",
  "bug",
  "coins",
  "gauge",
  "globe",
  "image",
  "inbox",
  "link",
  "mail",
  "message-square",
  "package",
  "puzzle",
  "radio",
  "receipt",
  "search",
  "shield",
  "shield-check",
  "sliders",
  "sparkles",
  "star",
  "users",
  "workflow",
]);

export type PluginPanelIcon = z.infer<typeof pluginPanelIcon>;

/** Slugs and ids: they appear in URLs and form fields. */
const panelId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, "must be lowercase, dash-separated, at most 63 characters");

/** An operation argument name. */
const argName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "must be an identifier (letters, digits, _)");

/**
 * Where a value sits in an operation's result: a property name, or up to
 * four dot-separated names for nested objects (`approvedSend.status`).
 */
export const panelKeyPath = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/,
    "must be a property name or a dot path of up to four names",
  );

const operationName = z.string().min(1).max(120);
const label = z.string().min(1).max(80);
/**
 * Operator-facing copy. May name result values as `{key}` (a key path):
 * the renderer replaces each with that value as text.
 */
const copy = z.string().min(1).max(500);

/** A primitive argument value fixed by the panel declaration. */
const fixedArgValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

/**
 * Arguments the panel always passes. Nothing the operator submits replaces
 * them (the admin applies them last), so a "decision: approved" button
 * cannot be turned into another decision.
 */
const fixedArgs = z
  .record(argName, fixedArgValue)
  .refine((v) => Object.keys(v).length <= 16, "at most 16 fixed arguments");

/** Operation arguments taken from a row (or a review result): argument name → key path. */
const mappedArgs = z.record(argName, panelKeyPath).refine((v) => {
  const n = Object.keys(v).length;
  return n >= 1 && n <= 8;
}, "map 1 to 8 arguments");

/** Button styles of the admin's design system. */
export const panelVariant = z.enum(["default", "secondary", "outline", "destructive"]);

/** How a value is shown. Every format renders text; none interprets markup. */
export const panelValueFormat = z.enum([
  /** One line of text. */
  "text",
  /** Text with its line breaks kept (a comment, a message). */
  "multiline",
  /** Monospace (ids, hashes). */
  "code",
  /** An ISO timestamp, shown in the viewer's locale. */
  "datetime",
  /** A number; see `decimals` and `divisor`. */
  "number",
  /** A short status word in a badge; see `badgeVariants`. */
  "badge",
  /** An array of primitives, comma-separated. */
  "list",
  /** Any value as indented JSON (submitted form data). */
  "json",
]);

export type PanelValueFormat = z.infer<typeof panelValueFormat>;

/** How one value is displayed: in a table column, a review field or a stat. */
export const panelValueDisplay = z
  .object({
    key: panelKeyPath,
    label,
    format: panelValueFormat,
    /** `number`: digits after the decimal point (default: as stored). */
    decimals: z.number().int().min(0).max(6).optional(),
    /** `number`: shown as value ÷ divisor (an average stored ×100 → 100). */
    divisor: z.number().positive().optional(),
    /** `badge`: the badge style per value; values not listed are `outline`. */
    badgeVariants: z.record(z.string().max(80), panelVariant).optional(),
  })
  .strict();

export type PanelValueDisplay = z.infer<typeof panelValueDisplay>;

/** A row (or review result) condition: the value at `key` is (not) one of `in`/`notIn`. */
export const panelCondition = z
  .object({
    key: panelKeyPath,
    in: z.array(fixedArgValue).min(1).max(20).optional(),
    notIn: z.array(fixedArgValue).min(1).max(20).optional(),
  })
  .strict()
  .refine((c) => (c.in === undefined) !== (c.notIn === undefined), "set exactly one of in / notIn");

export type PanelCondition = z.infer<typeof panelCondition>;

/** Asked before a destructive action goes through. */
export const panelConfirm = z
  .object({
    /** Names the concrete object: "Mark these comments as spam?" */
    title: z.string().min(1).max(200),
    /** The consequence in plain words. */
    description: z.string().min(1).max(500).optional(),
    confirmLabel: label,
  })
  .strict();

export type PanelConfirm = z.infer<typeof panelConfirm>;

const actionBase = {
  id: panelId,
  label,
  operation: operationName,
  args: fixedArgs.optional(),
  variant: panelVariant,
  confirm: panelConfirm.optional(),
  /** Shown after the action succeeded; `{key}` names a value of the operation's result. */
  successMessage: copy,
};

/**
 * The review step of a row action: `operation` is called with the row
 * action's `rowArgs`, its result is shown (as text) through `fields`, and
 * the action's own operation is then called with `submitArgs` taken from
 * THAT result — exactly what the operator saw, carried in the form, so an
 * operation can refuse when the data changed after the review.
 */
export const panelReview = z
  .object({
    operation: operationName,
    title: label,
    description: copy.optional(),
    fields: z.array(panelValueDisplay).min(1).max(12),
    submitArgs: mappedArgs,
    /** Only when every condition holds on the review result can it be submitted. */
    submitWhen: z.array(panelCondition).max(4).optional(),
    /** Shown instead of the submit button when `submitWhen` does not hold. */
    unavailableMessage: copy.optional(),
    submitLabel: label,
  })
  .strict()
  .refine(
    (r) => (r.submitWhen === undefined) === (r.unavailableMessage === undefined),
    "submitWhen and unavailableMessage go together",
  );

export type PanelReview = z.infer<typeof panelReview>;

/** An action on one row: its arguments come from the row (`rowArgs`). */
export const panelRowAction = z
  .object({
    ...actionBase,
    rowArgs: mappedArgs,
    /** Shown only on rows where every condition holds. */
    when: z.array(panelCondition).max(4).optional(),
    review: panelReview.optional(),
  })
  .strict();

export type PanelRowAction = z.infer<typeof panelRowAction>;

/** An action on the selected rows: their `rowKey` values go to `idsArg` as an array. */
export const panelBulkAction = z.object({ ...actionBase, idsArg: argName }).strict();

export type PanelBulkAction = z.infer<typeof panelBulkAction>;

/** An action of the whole section ("Refresh now"). */
export const panelToolbarAction = z.object(actionBase).strict();

export type PanelToolbarAction = z.infer<typeof panelToolbarAction>;

/**
 * A select filter over a table: the chosen option's value goes to `arg`.
 * With `allLabel`, an extra first option shows everything (the argument is
 * left out); without it the first option is the default.
 */
export const panelFilter = z
  .object({
    arg: argName,
    label,
    options: z
      .array(z.object({ value: z.string().min(1).max(120), label }).strict())
      .min(1)
      .max(20),
    allLabel: label.optional(),
  })
  .strict();

export type PanelFilter = z.infer<typeof panelFilter>;

/**
 * Cursor paging: each page asks for `pageSize` rows through `limitArg`; the
 * next page passes the last row's `cursor.key` value as `cursor.arg`.
 * More pages exist while the result's `hasMoreKey` is true.
 */
export const panelPaging = z
  .object({
    pageSize: z.number().int().min(1).max(500),
    limitArg: argName,
    cursor: z.object({ arg: argName, key: panelKeyPath }).strict(),
    hasMoreKey: panelKeyPath,
  })
  .strict();

export type PanelPaging = z.infer<typeof panelPaging>;

/**
 * A CSV download: `operation` is called with the section's fixed and
 * filter arguments plus `args`, and the text at `csvKey` is the file. The
 * operation owns the CSV (quoting, formula-injection guards).
 */
export const panelDownload = z
  .object({
    label,
    operation: operationName,
    args: fixedArgs.optional(),
    csvKey: panelKeyPath,
    filename: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}\.csv$/, "must be <name>.csv"),
  })
  .strict();

export type PanelDownload = z.infer<typeof panelDownload>;

/** Rows from an operation. */
export const panelTableSection = z
  .object({
    kind: z.literal("table"),
    id: panelId,
    title: label,
    description: copy.optional(),
    operation: operationName,
    args: fixedArgs.optional(),
    /** Where the row array sits in the result (`comments`, `submissions`). */
    rowsKey: panelKeyPath,
    /** The row's identity: what row and bulk actions select by. */
    rowKey: panelKeyPath.optional(),
    columns: z.array(panelValueDisplay).min(1).max(12),
    filters: z.array(panelFilter).max(4).optional(),
    paging: panelPaging.optional(),
    rowActions: z.array(panelRowAction).max(6).optional(),
    bulkActions: z.array(panelBulkAction).max(6).optional(),
    actions: z.array(panelToolbarAction).max(4).optional(),
    download: panelDownload.optional(),
    /** Shown when the operation returns no rows. */
    emptyMessage: copy,
  })
  .strict()
  .refine(
    (t) => t.rowKey !== undefined || (!t.rowActions?.length && !t.bulkActions?.length),
    "row and bulk actions need a rowKey",
  );

export type PanelTableSection = z.infer<typeof panelTableSection>;

/**
 * Labelled numbers from an operation. Either `items` names each value and
 * its label, or `entriesKey` points at an array of `{label, value}` the
 * operation labels itself (one entry per consent category, say).
 */
export const panelStatsSection = z
  .object({
    kind: z.literal("stats"),
    id: panelId,
    title: label,
    description: copy.optional(),
    operation: operationName,
    args: fixedArgs.optional(),
    items: z.array(panelValueDisplay).min(1).max(12).optional(),
    entriesKey: panelKeyPath.optional(),
  })
  .strict()
  .refine(
    (s) => (s.items === undefined) !== (s.entriesKey === undefined),
    "set exactly one of items / entriesKey",
  );

export type PanelStatsSection = z.infer<typeof panelStatsSection>;

const fieldBase = {
  /** The argument the value is submitted as. */
  arg: argName,
  label,
  description: copy.optional(),
};

/**
 * The inputs a form can have, built for a given extra shape: a `form`
 * field needs nothing more, a `settings` field also names where its
 * current value sits in the read result.
 */
function fieldUnion<E extends z.ZodRawShape>(extra: E) {
  return z.discriminatedUnion("input", [
    z
      .object({
        ...fieldBase,
        ...extra,
        input: z.enum(["text", "textarea"]),
        required: z.boolean(),
        placeholder: z.string().min(1).max(200).optional(),
        minLength: z.number().int().min(0).max(50_000).optional(),
        maxLength: z.number().int().min(1).max(50_000),
      })
      .strict(),
    z
      .object({
        ...fieldBase,
        ...extra,
        input: z.literal("number"),
        required: z.boolean(),
        integer: z.boolean(),
        min: z.number().optional(),
        max: z.number().optional(),
      })
      .strict(),
    z.object({ ...fieldBase, ...extra, input: z.literal("checkbox") }).strict(),
    z
      .object({
        ...fieldBase,
        ...extra,
        input: z.literal("select"),
        required: z.boolean(),
        options: z
          .array(z.object({ value: z.string().min(1).max(120), label }).strict())
          .min(1)
          .max(50),
      })
      .strict(),
  ]);
}

/** One input of a `form` section. The admin validates every submitted value against it. */
export const panelField = fieldUnion({});

export type PanelField = z.infer<typeof panelField>;

/** A blank form that submits once (`operation` gets `args` plus the fields). */
export const panelFormSection = z
  .object({
    kind: z.literal("form"),
    id: panelId,
    title: label,
    description: copy.optional(),
    operation: operationName,
    args: fixedArgs.optional(),
    fields: z.array(panelField).min(1).max(20),
    submitLabel: label,
    successMessage: copy,
  })
  .strict();

export type PanelFormSection = z.infer<typeof panelFormSection>;

/** A settings field: a form field pre-filled from `valueKey` of the read result. */
export const panelSettingsField = fieldUnion({ valueKey: panelKeyPath });

export type PanelSettingsField = z.infer<typeof panelSettingsField>;

/**
 * Settings: `readOperation` fills the form, `writeOperation` saves it with
 * `writeArgs` plus every field's value.
 */
export const panelSettingsSection = z
  .object({
    kind: z.literal("settings"),
    id: panelId,
    title: label,
    description: copy.optional(),
    readOperation: operationName,
    readArgs: fixedArgs.optional(),
    writeOperation: operationName,
    writeArgs: fixedArgs.optional(),
    fields: z.array(panelSettingsField).min(1).max(20),
    submitLabel: label,
    successMessage: copy,
  })
  .strict();

export type PanelSettingsSection = z.infer<typeof panelSettingsSection>;

export const panelSection = z.union([
  panelTableSection,
  panelStatsSection,
  panelFormSection,
  panelSettingsSection,
]);

export type PanelSection = z.infer<typeof panelSection>;

/** One admin page of a plugin. */
export const pluginAdminPanel = z
  .object({
    /** URL segment: the panel lives at `/plugins/<pluginSlug>/<slug>`. */
    slug: panelId,
    /** Navigation label and page heading, in the operator's words. */
    title: label,
    /** One line: what the operator does here. */
    description: copy,
    icon: pluginPanelIcon,
    /** Needed to see the panel and to run each of its actions. */
    permission: pluginPanelPermission,
    sections: z.array(panelSection).min(1).max(8),
  })
  .strict();

export type PluginAdminPanel = z.infer<typeof pluginAdminPanel>;

/** Every operation a panel can call, with where it is declared (for error paths). */
export function adminPanelOperations(
  panel: PluginAdminPanel,
): Array<{ operation: string; path: (string | number)[] }> {
  const out: Array<{ operation: string; path: (string | number)[] }> = [];
  for (const [s, section] of panel.sections.entries()) {
    const at = (...rest: (string | number)[]) => ["sections", s, ...rest];
    switch (section.kind) {
      case "table": {
        out.push({ operation: section.operation, path: at("operation") });
        for (const [i, a] of (section.rowActions ?? []).entries()) {
          out.push({ operation: a.operation, path: at("rowActions", i, "operation") });
          if (a.review) {
            out.push({
              operation: a.review.operation,
              path: at("rowActions", i, "review", "operation"),
            });
          }
        }
        for (const [i, a] of (section.bulkActions ?? []).entries()) {
          out.push({ operation: a.operation, path: at("bulkActions", i, "operation") });
        }
        for (const [i, a] of (section.actions ?? []).entries()) {
          out.push({ operation: a.operation, path: at("actions", i, "operation") });
        }
        if (section.download) {
          out.push({ operation: section.download.operation, path: at("download", "operation") });
        }
        break;
      }
      case "stats":
      case "form":
        out.push({ operation: section.operation, path: at("operation") });
        break;
      case "settings":
        out.push({ operation: section.readOperation, path: at("readOperation") });
        out.push({ operation: section.writeOperation, path: at("writeOperation") });
        break;
    }
  }
  return out;
}

/** Each call of a section: its fixed arguments and the ones the operator's input supplies. */
function argumentSets(section: PanelSection): Array<{
  fixed: Record<string, unknown> | undefined;
  mapped: string[];
  path: (string | number)[];
}> {
  switch (section.kind) {
    case "table":
      return [
        {
          fixed: section.args,
          mapped: [
            ...(section.filters ?? []).map((f) => f.arg),
            ...(section.paging ? [section.paging.limitArg, section.paging.cursor.arg] : []),
          ],
          path: ["args"],
        },
        ...(section.rowActions ?? []).flatMap((a, i) => [
          { fixed: a.args, mapped: Object.keys(a.rowArgs), path: ["rowActions", i, "rowArgs"] },
          ...(a.review
            ? [
                {
                  fixed: a.args,
                  mapped: Object.keys(a.review.submitArgs),
                  path: ["rowActions", i, "review", "submitArgs"],
                },
              ]
            : []),
        ]),
        ...(section.bulkActions ?? []).map((a, i) => ({
          fixed: a.args,
          mapped: [a.idsArg],
          path: ["bulkActions", i, "idsArg"],
        })),
      ];
    case "form":
      return [{ fixed: section.args, mapped: section.fields.map((f) => f.arg), path: ["fields"] }];
    case "settings":
      return [
        { fixed: section.writeArgs, mapped: section.fields.map((f) => f.arg), path: ["fields"] },
      ];
    case "stats":
      return [];
  }
}

/**
 * The cross-field checks of a plugin's panels, run by the manifest schema:
 * unique panel slugs, unique section ids per panel, unique action ids per
 * section, unique field arguments per form, no argument both fixed and
 * operator-supplied, and every named operation one of the plugin's
 * `operations`.
 */
export function checkAdminPanels(
  panels: readonly PluginAdminPanel[],
  operations: readonly string[],
  addIssue: (path: (string | number)[], message: string) => void,
): void {
  const declared = new Set(operations);
  const panelSlugs = new Set<string>();
  for (const [p, panel] of panels.entries()) {
    if (panelSlugs.has(panel.slug)) {
      addIssue([p, "slug"], `admin panel "${panel.slug}" is declared twice`);
    }
    panelSlugs.add(panel.slug);
    for (const { operation, path } of adminPanelOperations(panel)) {
      if (!declared.has(operation)) {
        addIssue([p, ...path], `operation "${operation}" is not one of the plugin's operations`);
      }
    }
    const sectionIds = new Set<string>();
    for (const [s, section] of panel.sections.entries()) {
      if (sectionIds.has(section.id)) {
        addIssue([p, "sections", s, "id"], `section "${section.id}" is declared twice`);
      }
      sectionIds.add(section.id);
      if (section.kind === "table") {
        const actionIds = new Set<string>();
        const groups = [
          ["rowActions", section.rowActions ?? []],
          ["bulkActions", section.bulkActions ?? []],
          ["actions", section.actions ?? []],
        ] as const;
        for (const [group, actions] of groups) {
          for (const [i, action] of actions.entries()) {
            if (actionIds.has(action.id)) {
              addIssue(
                [p, "sections", s, group, i, "id"],
                `action "${action.id}" is declared twice in section "${section.id}"`,
              );
            }
            actionIds.add(action.id);
          }
        }
        const filterArgs = new Set<string>();
        for (const [i, filter] of (section.filters ?? []).entries()) {
          if (
            filterArgs.has(filter.arg) ||
            filter.arg === section.paging?.limitArg ||
            filter.arg === section.paging?.cursor.arg
          ) {
            addIssue(
              [p, "sections", s, "filters", i, "arg"],
              `argument "${filter.arg}" is set twice in section "${section.id}"`,
            );
          }
          filterArgs.add(filter.arg);
        }
      }
      for (const { fixed, mapped, path } of argumentSets(section)) {
        for (const arg of mapped) {
          if (fixed !== undefined && Object.hasOwn(fixed, arg)) {
            addIssue(
              [p, "sections", s, ...path],
              `argument "${arg}" is both fixed and taken from the operator; drop one`,
            );
          }
        }
      }
      if (section.kind === "form" || section.kind === "settings") {
        const args = new Set<string>();
        for (const [i, field] of section.fields.entries()) {
          if (args.has(field.arg)) {
            addIssue(
              [p, "sections", s, "fields", i, "arg"],
              `field argument "${field.arg}" is declared twice in section "${section.id}"`,
            );
          }
          args.add(field.arg);
        }
      }
    }
  }
}

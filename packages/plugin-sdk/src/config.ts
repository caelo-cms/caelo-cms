// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin configuration as a schema (epic #1644, R6, issue #1645).
 *
 * A plugin declares what can be configured; the host provides the rest:
 * storage on the branch-aware plugin storage (#508), validation, release
 * binding (frozen with the Stage, live with Publish live), a generated
 * settings form and generated AI tools. `entityConfig` declares fields a
 * plugin keeps per core entity (a page, a module, a content instance, a
 * page type).
 *
 * Every leaf carries what the AI and the operator need to decide without a
 * round-trip (CLAUDE.md §1A): a label, a description of what the value
 * does, its default (stored at activation, CLAUDE.md §2: defaults are data),
 * and three effects:
 *
 * - `effect`: what a change touches. `none` (bookkeeping), `query` (the next
 *   request, e.g. a ranking weight), `pages` (pages must be re-read at the
 *   next Stage), `rebuild` (the plugin's derived data is rebuilt at the next
 *   Stage).
 * - `gate`: `routine` applies like any edit; `approval` needs the
 *   operator's in-chat click (CLAUDE.md §11.A), e.g. a cost limit.
 * - `scope`: `release` waits for Stage and Publish live; `immediate` applies
 *   at once, allowed only for a field without a visitor-visible effect.
 *
 * `visitorVisible` (#1654) marks a leaf the public gateway may read: its
 * value is published with the release into the public database, where an
 * `ai-chat` operation's prompt takes it from (`prompt.fields`). Only scalar
 * leaves with scope `release` qualify, so what the gateway reads is frozen
 * with a Stage and live with Publish live like everything else visitors see.
 * Everything not marked stays on the authoring side.
 */

import { EMBEDDING_MODEL_IDS } from "@caelo-cms/shared/embedding-models";
import { z } from "zod";

/** What a change of a field touches. */
export const CONFIG_EFFECTS = ["none", "query", "pages", "rebuild"] as const;
export type ConfigEffect = (typeof CONFIG_EFFECTS)[number];

/** Keys a `map` field is keyed by. */
export const CONFIG_MAP_KEYS = ["pageType", "language", "module"] as const;

/** Entities a plugin may keep configuration for. */
export const CONFIG_ENTITY_KINDS = ["page", "module", "contentInstance", "pageType"] as const;
export type ConfigEntityKind = (typeof CONFIG_ENTITY_KINDS)[number];

const fieldName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/, "must be snake_case, at most 48 characters");

const leafMeta = {
  label: z.string().min(1).max(80),
  description: z.string().min(1).max(600),
  effect: z.enum(CONFIG_EFFECTS),
  gate: z.enum(["routine", "approval"]).default("routine"),
  scope: z.enum(["release", "immediate"]).default("release"),
  /** #1654 — published with the release for the gateway (see the file comment). */
  visitorVisible: z.boolean().optional(),
};

const scalarLeaves = [
  z.object({ type: z.literal("bool"), ...leafMeta, default: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("int"),
      ...leafMeta,
      min: z.number().int(),
      max: z.number().int(),
      default: z.number().int(),
    })
    .strict(),
  z
    .object({
      type: z.literal("number"),
      ...leafMeta,
      min: z.number(),
      max: z.number(),
      default: z.number(),
    })
    .strict(),
  z
    .object({
      type: z.literal("enum"),
      ...leafMeta,
      options: z
        .array(
          z
            .object({
              value: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/),
              label: z.string().min(1).max(80),
            })
            .strict(),
        )
        .min(2)
        .max(32),
      default: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("string"),
      ...leafMeta,
      maxLength: z.number().int().min(1).max(20_000),
      multiline: z.boolean().default(false),
      default: z.string(),
    })
    .strict(),
] as const;

const scalarField = z.discriminatedUnion("type", scalarLeaves);

/** A leaf whose value is a scalar. */
export type ConfigScalarField = z.output<typeof scalarField>;

const refLeaves = [
  z.object({ type: z.literal("pageRef"), ...leafMeta, default: z.null() }).strict(),
  z
    .object({
      type: z.literal("listRef"),
      ...leafMeta,
      /** The list type the referenced list must have (often one the plugin declares). */
      listType: z.string().min(1).max(80),
      default: z.null(),
    })
    .strict(),
  z
    .object({
      type: z.literal("catalogModel"),
      ...leafMeta,
      purpose: z.literal("embedding"),
      default: z.string().min(1).max(80).nullable(),
    })
    .strict(),
] as const;

const mapField = z
  .object({
    type: z.literal("map"),
    ...leafMeta,
    keys: z.enum(CONFIG_MAP_KEYS),
    value: scalarField,
    /** Values for keys the operator set; a key not listed takes `value.default`. */
    default: z.record(z.string().min(1).max(80), z.union([z.boolean(), z.number(), z.string()])),
  })
  .strict();

/** A configuration field: a leaf or a group of fields. */
export type ConfigField =
  | ConfigScalarField
  | z.output<(typeof refLeaves)[number]>
  | z.output<typeof mapField>
  | {
      readonly type: "group";
      readonly label: string;
      readonly description: string;
      readonly fields: Readonly<Record<string, ConfigField>>;
    };

/** Input form of a field (defaults for `gate` and `scope` may be omitted). */
export type ConfigFieldInput =
  | z.input<typeof scalarField>
  | z.input<(typeof refLeaves)[number]>
  | z.input<typeof mapField>
  | {
      readonly type: "group";
      readonly label: string;
      readonly description: string;
      readonly fields: Readonly<Record<string, ConfigFieldInput>>;
    };

const leafField = z.union([scalarField, ...refLeaves, mapField]);

const configField: z.ZodType<ConfigField, ConfigFieldInput> = z.lazy(() =>
  z.union([
    leafField,
    z
      .object({
        type: z.literal("group"),
        label: z.string().min(1).max(80),
        description: z.string().min(1).max(600),
        fields: z.record(fieldName, configField),
      })
      .strict(),
  ]),
) as z.ZodType<ConfigField, ConfigFieldInput>;

/** A plugin's configuration schema: named fields, nested by groups. */
export const pluginConfigSchema = z.record(fieldName, configField);
export type PluginConfigSchema = Readonly<Record<string, ConfigField>>;

const pageRefLeaf = refLeaves[0];

/**
 * A field kept per entity: a scalar, or a page reference (a module's home
 * page, say). No groups, no lists, no models.
 */
const entityField = z.union([scalarField, pageRefLeaf]);
export type ConfigEntityField = ConfigScalarField | z.output<typeof pageRefLeaf>;

const entityFields = z.record(fieldName, entityField).optional();

/** Fields a plugin keeps per core entity. Leaves only: scalars and page references. */
export const pluginEntityConfigSchema = z
  .object({
    page: entityFields,
    module: entityFields,
    contentInstance: entityFields,
    pageType: entityFields,
  })
  .strict();
export type PluginEntityConfigSchema = Partial<
  Record<ConfigEntityKind, Readonly<Record<string, ConfigEntityField>>>
>;

/** Most leaves one plugin's configuration may have: the generated form and the AI tool stay readable. */
export const MAX_CONFIG_LEAVES = 120;

/** Deepest group nesting. */
export const MAX_CONFIG_DEPTH = 3;

/** One leaf with its dotted path. */
export interface ConfigLeaf {
  readonly path: string;
  readonly field: Exclude<ConfigField, { type: "group" }>;
}

/** Every leaf of a schema, depth first, with its dotted path. */
export function configLeaves(schema: PluginConfigSchema, prefix = ""): ConfigLeaf[] {
  const out: ConfigLeaf[] = [];
  for (const [name, field] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (field.type === "group") out.push(...configLeaves(field.fields, path));
    else out.push({ path, field });
  }
  return out;
}

function scalarValueSchema(field: ConfigScalarField): z.ZodType {
  switch (field.type) {
    case "bool":
      return z.boolean();
    case "int":
      return z.number().int().min(field.min).max(field.max);
    case "number":
      return z.number().min(field.min).max(field.max);
    case "enum":
      return z.enum(field.options.map((o) => o.value) as [string, ...string[]]);
    case "string":
      return z.string().max(field.maxLength);
  }
}

const uuid = z.string().uuid();
const mapKey = z.string().min(1).max(80);

function leafValueSchema(field: ConfigLeaf["field"]): z.ZodType {
  switch (field.type) {
    case "pageRef":
    case "listRef":
      return uuid.nullable();
    case "catalogModel":
      // #1650 — only a model of the core catalog; null turns semantic search off.
      return z.enum(EMBEDDING_MODEL_IDS as [string, ...string[]]).nullable();
    case "map":
      return z.record(mapKey, scalarValueSchema(field.value));
    default:
      return scalarValueSchema(field);
  }
}

/** The Zod schema of a complete configuration value. Strict: unknown keys are errors. */
export function configValueSchema(schema: PluginConfigSchema): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(schema)) {
    shape[name] = field.type === "group" ? configValueSchema(field.fields) : leafValueSchema(field);
  }
  return z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;
}

/**
 * The Zod schema of a merge patch (RFC 7386 without deletion): any subset of
 * the fields, groups patched recursively, maps merged key by key. A map key
 * set to null is removed, so it takes the field's default again.
 */
export function configPatchSchema(schema: PluginConfigSchema): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(schema)) {
    if (field.type === "group") shape[name] = configPatchSchema(field.fields).optional();
    else if (field.type === "map")
      shape[name] = z.record(mapKey, scalarValueSchema(field.value).nullable()).optional();
    else shape[name] = leafValueSchema(field).optional();
  }
  return z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;
}

/** The default configuration value: what activation stores. */
export function configDefaults(schema: PluginConfigSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema))
    out[name] =
      field.type === "group" ? configDefaults(field.fields) : structuredClone(field.default);
  return out;
}

/** Applies a validated merge patch to a configuration value. */
export function applyConfigPatch(
  schema: PluginConfigSchema,
  value: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const [name, change] of Object.entries(patch)) {
    if (change === undefined) continue;
    const field = schema[name];
    if (!field) continue;
    if (field.type === "group") {
      out[name] = applyConfigPatch(
        field.fields,
        (value[name] ?? {}) as Record<string, unknown>,
        change as Record<string, unknown>,
      );
    } else if (field.type === "map") {
      const merged: Record<string, unknown> = {
        ...((value[name] ?? {}) as Record<string, unknown>),
      };
      for (const [k, v] of Object.entries(change as Record<string, unknown>)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      out[name] = merged;
    } else out[name] = change;
  }
  return out;
}

/** The dotted paths of every leaf a patch touches (a map counts as one leaf). */
export function patchedLeaves(
  schema: PluginConfigSchema,
  patch: Readonly<Record<string, unknown>>,
  prefix = "",
): ConfigLeaf[] {
  const out: ConfigLeaf[] = [];
  for (const [name, change] of Object.entries(patch)) {
    if (change === undefined) continue;
    const field = schema[name];
    if (!field) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    if (field.type === "group")
      out.push(...patchedLeaves(field.fields, change as Record<string, unknown>, path));
    else out.push({ path, field });
  }
  return out;
}

/** The value of a map field for one key: the stored value, or the field's own default. */
export function mapValue(
  field: Extract<ConfigField, { type: "map" }>,
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): unknown {
  return value && key in value ? value[key] : field.value.default;
}

/** The Zod schema of one entity's configuration (every field optional; an unset field takes its default). */
export function entityConfigSchema(
  fields: Readonly<Record<string, ConfigEntityField>>,
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(fields))
    shape[name] = (field.type === "pageRef" ? uuid : scalarValueSchema(field))
      .nullable()
      .optional();
  return z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;
}

/** One entity's effective configuration: its stored values over the declared defaults. */
export function entityConfigValue(
  fields: Readonly<Record<string, ConfigEntityField>>,
  stored: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const v = stored?.[name];
    out[name] = v === undefined || v === null ? field.default : v;
  }
  return out;
}

type Issue = (path: readonly (string | number)[], message: string) => void;

/** Leaf types whose value the gateway may read (#1654): text and plain values, never references. */
const VISITOR_VISIBLE_TYPES: ReadonlySet<string> = new Set([
  "string",
  "enum",
  "bool",
  "int",
  "number",
]);

function checkLeaf(path: string[], field: ConfigLeaf["field"], issue: Issue): void {
  if (field.visitorVisible === true) {
    if (!VISITOR_VISIBLE_TYPES.has(field.type))
      issue(
        [...path, "visitorVisible"],
        `a ${field.type} field cannot be visitor-visible: only string, enum, bool, int and number values are published to the gateway`,
      );
    if (field.scope !== "release")
      issue(
        [...path, "visitorVisible"],
        'a visitor-visible field needs scope "release": the gateway reads what the last Publish live released',
      );
  }
  if (field.scope === "immediate" && field.effect !== "none") {
    issue(
      path,
      `"${path.join(".")}" has scope "immediate" but effect "${field.effect}": only a field without a visitor-visible effect (effect "none") may apply at once`,
    );
  }
  if (field.type === "int" || field.type === "number") {
    if (field.min > field.max) issue(path, `min ${field.min} is above max ${field.max}`);
  }
  if (field.type === "map") {
    const valueSchema = scalarValueSchema(field.value);
    for (const [k, v] of Object.entries(field.default))
      if (!valueSchema.safeParse(v).success)
        issue([...path, "default", k], `default for key "${k}" is not a valid value`);
    if (!scalarValueSchema(field.value).safeParse(field.value.default).success)
      issue([...path, "value", "default"], "the value's default is not valid");
    return;
  }
  if (field.type === "catalogModel") {
    if (field.default !== null && !EMBEDDING_MODEL_IDS.includes(field.default))
      issue(
        [...path, "default"],
        `default "${field.default}" is not a model of the core catalog (${EMBEDDING_MODEL_IDS.join(", ")}), or null`,
      );
    return;
  }
  if (field.type === "pageRef" || field.type === "listRef") return;
  if (!scalarValueSchema(field).safeParse(field.default).success)
    issue(
      [...path, "default"],
      `default ${JSON.stringify(field.default)} is not a valid value of the field`,
    );
}

/** Lints a configuration schema and an entity configuration schema; reports every problem. */
export function checkConfig(
  config: PluginConfigSchema | undefined,
  entityConfig: PluginEntityConfigSchema | undefined,
  issue: Issue,
): void {
  if (config) {
    const walk = (fields: PluginConfigSchema, path: string[], depth: number): void => {
      if (depth > MAX_CONFIG_DEPTH) issue(path, `groups nest at most ${MAX_CONFIG_DEPTH} deep`);
      for (const [name, field] of Object.entries(fields)) {
        if (field.type === "group") walk(field.fields, [...path, name, "fields"], depth + 1);
        else {
          checkLeaf([...path, name], field, issue);
          // The host keeps immediate fields in a row of their own, split by top-level field.
          if (depth > 1 && field.scope === "immediate")
            issue(
              [...path, name],
              'a field with scope "immediate" must be top-level, not inside a group',
            );
        }
      }
    };
    walk(config, ["config"], 1);
    const leaves = configLeaves(config).length;
    if (leaves > MAX_CONFIG_LEAVES)
      issue(["config"], `at most ${MAX_CONFIG_LEAVES} leaves, got ${leaves}`);
  }
  for (const kind of CONFIG_ENTITY_KINDS) {
    for (const [name, field] of Object.entries(entityConfig?.[kind] ?? {})) {
      checkLeaf(["entityConfig", kind, name], field, issue);
      if (field.visitorVisible === true)
        issue(
          ["entityConfig", kind, name, "visitorVisible"],
          "entity fields are never published to the gateway: only `config` leaves can be visitor-visible",
        );
      if (field.scope === "immediate")
        issue(
          ["entityConfig", kind, name],
          'entity fields always apply with the Stage: scope "immediate" is not available here',
        );
    }
  }
}

/** The paths of a schema's visitor-visible leaves (#1654), in declaration order. */
export function visitorVisibleLeaves(schema: PluginConfigSchema): ConfigLeaf[] {
  return configLeaves(schema).filter((l) => l.field.visitorVisible === true);
}

/** Parses a configuration schema declaration (the manifest form). */
export function parseConfigSchema(input: unknown): PluginConfigSchema {
  return pluginConfigSchema.parse(input);
}

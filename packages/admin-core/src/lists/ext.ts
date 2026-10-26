// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — definition extensions (`docs/lists.md` §9.2): attributes a
 * plugin declared for list-type fields and nodes and page-type
 * properties, stored under `ext.<pluginSlug>`.
 *
 * Core validates them against the RUNNING plugin's schema and never reads
 * them. With the plugin not running (inactive, disabled, uninstalled) the
 * attributes stay as inert data: a write that keeps them unchanged
 * passes, a write that adds or changes them is refused with the next
 * step — accepting it would store a value no schema checked, which the
 * plugin would meet as "valid" the moment it runs again.
 */

import type { ActiveListExt } from "@caelo-cms/plugin-host";
import type { ListTypeDef, PageTypeDef } from "@caelo-cms/shared";

/** Where an `ext` lives in a definition, e.g. `nodes.entry.fields.label`. */
interface ExtSite {
  readonly path: string;
  readonly kind: "field" | "node";
  readonly ext: Readonly<Record<string, unknown>> | undefined;
}

/** A list type's or a page type's definition. */
type TypeDef = ListTypeDef | PageTypeDef;

function extSites(def: TypeDef): ExtSite[] {
  const out: ExtSite[] = [];
  if ("properties" in def) {
    for (const f of def.properties) {
      out.push({ path: `properties.${f.name}`, kind: "field", ext: f.ext });
    }
    return out;
  }
  for (const [kind, node] of Object.entries(def.nodes)) {
    out.push({ path: `nodes.${kind}`, kind: "node", ext: node.ext });
    for (const f of node.fields) {
      out.push({ path: `nodes.${kind}.fields.${f.name}`, kind: "field", ext: f.ext });
    }
  }
  return out;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Problems of the `ext` attributes in `def`, one AI-actionable message
 * each; empty when every attribute is valid or inert-and-unchanged.
 *
 * @param previous the stored definition this write replaces (null for a
 *   new type) — inert attributes are compared against it.
 * @param schemaFor the running plugin's extension schemas, or null.
 */
export function checkDefinitionExt<D extends TypeDef>(
  def: D,
  previous: D | null,
  schemaFor: (pluginSlug: string) => ActiveListExt | null,
): string[] {
  const before = new Map(previous ? extSites(previous).map((s) => [s.path, s.ext]) : []);
  const issues: string[] = [];
  for (const site of extSites(def)) {
    for (const [plugin, value] of Object.entries(site.ext ?? {})) {
      const at = `${site.path}.ext.${plugin}`;
      const schemas = schemaFor(plugin);
      if (schemas === null) {
        if (sameJson(before.get(site.path)?.[plugin], value)) continue;
        issues.push(
          `${at}: plugin "${plugin}" is not running, so its attributes cannot be added or changed (they stay stored as they are). Activate the plugin first (activate_plugin), or leave ${at} as it was.`,
        );
        continue;
      }
      const schema = site.kind === "field" ? schemas.field : schemas.node;
      if (!schema) {
        issues.push(
          `${at}: plugin "${plugin}" declares no attributes for ${site.kind === "field" ? "fields" : "node kinds"} — remove ${at}.`,
        );
        continue;
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        issues.push(
          `${at}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ")} — fix the attribute to match what plugin "${plugin}" declares.`,
        );
      }
    }
  }
  return issues;
}

/**
 * Paths of `ext.<plugin>` attributes no running plugin interprets
 * (`nodes.entry.fields.label.ext.international-site`), so readers can
 * tell the AI those attributes currently do nothing.
 */
export function inertExtPaths(
  def: TypeDef,
  schemaFor: (pluginSlug: string) => ActiveListExt | null,
): string[] {
  const out: string[] = [];
  for (const site of extSites(def)) {
    for (const plugin of Object.keys(site.ext ?? {})) {
      if (schemaFor(plugin) === null) out.push(`${site.path}.ext.${plugin}`);
    }
  }
  return out;
}

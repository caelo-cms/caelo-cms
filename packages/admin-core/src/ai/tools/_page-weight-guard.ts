// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1371 — write-time hints for one list rendered more than once on a
 * page: the early half of the structure check's `structure/repeated-render`
 * (quality/checks/structure-weight.ts).
 *
 * Two shapes are visible in the stored module, before any page renders:
 *
 * - a template that iterates the same `list` field twice — the desktop
 *   menu and a second copy for mobile. One markup serves every width (the
 *   interaction kit's `mobile-nav` collapses it), so the second loop is
 *   pure DOM weight on every page;
 * - a shared list bound by two modules where one of them is chrome — the
 *   header and the footer both showing the whole menu. The DATA is right
 *   (one list); every page with both still carries every link twice.
 *
 * Hints on an already-successful write, never a gate (same contract as the
 * markup and module-JS guards); the Stage check reports what is left.
 * Pure: the caller reads the catalog once for every write guard.
 */

/** A module as the guard reads it from `modules.list`. */
export interface WeightGuardModule {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly html: string;
  readonly kind: string;
  readonly fields?: readonly unknown[];
}

interface ListField {
  readonly name: string;
  /** `caelo:list/<id>` when the field is bound to a shared list. */
  readonly sharedList: string | null;
}

function listFields(m: WeightGuardModule): ListField[] {
  const out: ListField[] = [];
  for (const raw of m.fields ?? []) {
    const f = raw as { name?: unknown; kind?: unknown; list?: unknown; default?: unknown };
    if (f.kind !== "list" || typeof f.name !== "string") continue;
    const ref = typeof f.list === "string" ? f.list : f.default;
    out.push({
      name: f.name,
      sharedList: typeof ref === "string" && ref.startsWith("caelo:list/") ? ref : null,
    });
  }
  return out;
}

/** How often the template opens a section over `field` (`{{#field}}`). */
function sectionCount(html: string, field: string): number {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...html.matchAll(new RegExp(`\\{\\{\\s*#\\s*${escaped}\\s*\\}\\}`, "g"))].length;
}

/**
 * Hints for the written modules.
 *
 * @param catalog - every module (after the write).
 * @param moduleIds - the modules this write created or changed.
 * @param chromeSlugs - slugs of the modules placed in a layout block.
 */
export function pageWeightHints(
  catalog: readonly WeightGuardModule[],
  moduleIds: readonly string[],
  chromeSlugs: ReadonlySet<string>,
): string[] {
  const isChrome = (m: WeightGuardModule) => m.kind === "chrome" || chromeSlugs.has(m.slug);
  const hints: string[] = [];
  const said = new Set<string>();
  for (const m of catalog.filter((x) => moduleIds.includes(x.id))) {
    for (const field of listFields(m)) {
      const loops = sectionCount(m.html, field.name);
      if (loops >= 2) {
        hints.push(
          `the html of "${m.displayName}" iterates the list field \`${field.name}\` ${loops} times — every entry is written into each page ${loops} times. Iterate it ONCE: one <nav> serves desktop and mobile; collapse it with data-caelo-ui="mobile-nav" and CSS instead of a second {{#${field.name}}} loop (Stage blocks this: structure/repeated-render)`,
        );
      }
      if (field.sharedList === null) continue;
      for (const other of catalog) {
        if (other.id === m.id || !(isChrome(m) || isChrome(other))) continue;
        const shown = listFields(other).find((f) => f.sharedList === field.sharedList);
        const pair = [m.id, other.id].sort().join("\u0000") + field.sharedList;
        if (!shown || said.has(pair)) continue;
        said.add(pair);
        hints.push(
          `"${m.displayName}" (field \`${field.name}\`) and "${other.displayName}" (field \`${shown.name}\`) both show ${field.sharedList} — on every page with both, each link is in the HTML twice. Show the whole list in one of them; give the other (usually the footer) its own short shared list (upsert_lists_many: legal pages, contact, top sections) and bind that field to it`,
        );
      }
    }
  }
  return hints;
}

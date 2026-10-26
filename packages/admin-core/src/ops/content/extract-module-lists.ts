// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — the list pass of `extractModuleStructure`: repeated
 * sibling groups in hand-written module HTML become ONE local `list`
 * field instead of numbered scalars (`item1`, `item2`, `cta2href`, …),
 * which CLAUDE.md §1A forbids for repeating content.
 *
 * A group is converted only when every member renders from one
 * template and a SHIPPED list type holds its values (`docs/lists.md` §3):
 *
 *   - `<li>` (2+) / `<p>` or `<span>` sharing a class (3+) holding only
 *     text                                   → `texts` (node `text`, {text})
 *   - `<a href>` (3+) or `<li><a href></a></li>` (2+), text-only labels
 *                                            → `links` (node `link`, {label, link})
 *   - `<li><a href></a><ul>…</ul></li>` (2+, one level of sub-entries)
 *                                            → `menu` (node `entry`, children)
 *
 * Two bare anchors or two paragraphs stay scalars: a primary/secondary
 * CTA pair and a lead + body paragraph are not lists.
 *
 * The pass never mints a list type: types are site-wide stored data
 * whose writes need `content.structure`, and the extractor is a pure
 * fallback inside `modules.create`. A group no shipped type fits —
 * cards of image + heading + text, entries with extra attributes, mixed
 * markup — keeps the scalar extraction; the authoring AI that wants an
 * editable collection makes the card its own module (a `module-list`)
 * or creates a list type first (`upsert_list_types_many`) and authors
 * the field explicitly.
 *
 * Entries carry no ids: `modules.create` validates list defaults against
 * the type and assigns ids (`normaliseListFieldDefaults`).
 */

import type { ListItemInput, ModuleField } from "@caelo-cms/shared";
import { parseDocument } from "htmlparser2";

/** The structural view of a parsed node this pass reads (domhandler). */
interface DomNode {
  readonly type: string;
  readonly startIndex: number | null;
  readonly endIndex: number | null;
  readonly data?: string;
  readonly name?: string;
  readonly attribs?: Record<string, string>;
  readonly children?: readonly DomNode[];
}

/** Result of {@link extractRepeatedLists}. */
export interface ListExtraction {
  /** The HTML with every converted group replaced by its list section. */
  readonly html: string;
  /** One local `list` field per converted group, `default` = the entries. */
  readonly fields: readonly ModuleField[];
}

/** A group member's rendering: the entry template and its stored entry. */
interface Member {
  readonly template: string;
  readonly entry: ListItemInput;
}

type ListTypeSlug = "texts" | "links" | "menu";

interface GroupShape {
  readonly listType: ListTypeSlug;
  readonly members: readonly Member[];
}

const TEMPLATE_SYNTAX = "{{";
/** Elements that make a member more than its text/link: no shipped type holds them. */
const OPAQUE_TAGS = new Set(["img", "button", "script", "style", "svg", "picture", "video"]);
/** Attributes the scalar pass extracts; a member carrying them is not one template. */
const EXTRACTED_ATTRS = ["src", "alt", "aria-label", "title", "placeholder"];

const isElement = (n: DomNode): boolean =>
  n.type === "tag" || n.type === "script" || n.type === "style";
const isBlankText = (n: DomNode): boolean => n.type === "text" && /^\s*$/.test(n.data ?? "");

function elementChildren(n: DomNode): DomNode[] {
  return (n.children ?? []).filter(isElement);
}

/** Only whitespace text (and comments) between the element children. */
function onlyElementChildren(n: DomNode): boolean {
  return (n.children ?? []).every((c) => isElement(c) || isBlankText(c) || c.type === "comment");
}

/** The element's text when its only children are text nodes, else null. */
function plainText(n: DomNode): string | null {
  const kids = n.children ?? [];
  if (kids.length === 0 || !kids.every((c) => c.type === "text")) return null;
  const text = kids
    .map((c) => c.data ?? "")
    .join("")
    .trim();
  if (text === "" || text.includes(TEMPLATE_SYNTAX)) return null;
  return text;
}

/** The source text of an element's opening tag (`<a class="x" href="/">`). */
function openTag(html: string, n: DomNode): string | null {
  const start = n.startIndex;
  if (start === null) return null;
  let quote: string | null = null;
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return html.slice(start, i + 1);
    }
  }
  return null;
}

/** True when the element's source ends with its explicit closing tag. */
function closesExplicitly(html: string, n: DomNode): boolean {
  if (n.endIndex === null || !n.name) return false;
  return html
    .slice(0, n.endIndex + 1)
    .toLowerCase()
    .endsWith(`</${n.name}>`);
}

/** No attribute the scalar pass would extract, no template syntax in the tag. */
function plainOpenTag(html: string, n: DomNode): string | null {
  const tag = openTag(html, n);
  if (tag === null || tag.includes(TEMPLATE_SYNTAX)) return null;
  const attrs = n.attribs ?? {};
  if (EXTRACTED_ATTRS.some((a) => attrs[a] !== undefined && attrs[a] !== "")) return null;
  return tag;
}

/** `<a href>label</a>` → its template and values, else null. */
function linkShape(
  html: string,
  a: DomNode,
): { template: string; label: string; href: string } | null {
  if (a.name !== "a" || !closesExplicitly(html, a)) return null;
  const href = a.attribs?.href;
  const label = plainText(a);
  const tag = plainOpenTag(html, a);
  if (!href || href.includes(TEMPLATE_SYNTAX) || label === null || tag === null) return null;
  const m = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  const raw = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  if (!m || raw !== href) return null;
  const valueAt = m.index + m[0].lastIndexOf(raw);
  const templatedTag = `${tag.slice(0, valueAt)}{{link}}${tag.slice(valueAt + raw.length)}`;
  return { template: `${templatedTag}{{label}}</a>`, label, href };
}

/** `<li><a href>label</a></li>` → template + values, else null. */
function linkItemShape(
  html: string,
  li: DomNode,
): { template: string; label: string; href: string } | null {
  if (li.name !== "li" || !closesExplicitly(html, li) || !onlyElementChildren(li)) return null;
  const kids = elementChildren(li);
  const tag = plainOpenTag(html, li);
  if (kids.length !== 1 || tag === null || !kids[0]) return null;
  const link = linkShape(html, kids[0]);
  return link ? { ...link, template: `${tag}${link.template}</li>` } : null;
}

function textMember(html: string, el: DomNode): Member | null {
  const text = plainText(el);
  const tag = plainOpenTag(html, el);
  if (text === null || tag === null || !closesExplicitly(html, el)) return null;
  return {
    template: `${tag}{{text}}</${el.name}>`,
    entry: { node: "text", values: { text } },
  };
}

function linkEntry(node: "link" | "entry", label: string, href: string): ListItemInput {
  return { node, values: { label, link: { href } } };
}

/**
 * A menu entry: `<li><a/></li>` or `<li><a/><ul><li><a/></li>…</ul></li>`.
 * `sub` is the sub-list's own template (open tag + one entry template +
 * close tag), compared across members so one block renders them all.
 */
function menuMember(
  html: string,
  li: DomNode,
): { liTag: string; link: string; sub: string | null; entry: ListItemInput } | null {
  if (li.name !== "li" || !closesExplicitly(html, li) || !onlyElementChildren(li)) return null;
  const liTag = plainOpenTag(html, li);
  const kids = elementChildren(li);
  if (liTag === null || kids.length < 1 || kids.length > 2 || !kids[0]) return null;
  const link = linkShape(html, kids[0]);
  if (!link) return null;
  const entry = linkEntry("entry", link.label, link.href);
  const subList = kids[1];
  if (!subList) return { liTag, link: link.template, sub: null, entry };
  if ((subList.name !== "ul" && subList.name !== "ol") || !closesExplicitly(html, subList))
    return null;
  const subTag = plainOpenTag(html, subList);
  if (subTag === null || !onlyElementChildren(subList)) return null;
  const subItems = elementChildren(subList).map((c) => linkItemShape(html, c));
  const first = subItems[0];
  if (!first || subItems.some((s) => s === null || s.template !== first.template)) return null;
  const children = subItems.map((s) => linkEntry("entry", s?.label ?? "", s?.href ?? ""));
  return {
    liTag,
    link: link.template,
    sub: `${subTag}{{#children}}${first.template}{{/children}}</${subList.name}>`,
    entry: { ...entry, children },
  };
}

/** The menu group of a run of `<li>`, or null when it is no menu. */
function menuGroup(html: string, run: readonly DomNode[]): GroupShape | null {
  const members = run.map((li) => menuMember(html, li));
  const first = members[0];
  if (!first || members.some((m) => m === null)) return null;
  const ms = members as NonNullable<(typeof members)[number]>[];
  const subs = new Set(ms.flatMap((m) => (m.sub === null ? [] : [m.sub])));
  if (subs.size !== 1 || ms.some((m) => m.liTag !== first.liTag || m.link !== first.link))
    return null;
  const sub = [...subs][0] ?? "";
  const template = `${first.liTag}${first.link}{{#has_children}}${sub}{{/has_children}}</li>`;
  return { listType: "menu", members: ms.map((m) => ({ template, entry: m.entry })) };
}

/** Classify a run of same-tag siblings; null when no shipped type fits. */
function classifyRun(html: string, run: readonly DomNode[]): GroupShape | null {
  const tag = run[0]?.name;
  if (!tag) return null;
  const same = (members: (Member | null)[]): Member[] | null => {
    const first = members[0];
    if (!first || members.some((m) => m === null || m.template !== first.template)) return null;
    return members as Member[];
  };
  if (tag === "li" && run.length >= 2) {
    const texts = same(run.map((el) => textMember(html, el)));
    if (texts) return { listType: "texts", members: texts };
    const links = same(
      run.map((el) => {
        const s = linkItemShape(html, el);
        return s ? { template: s.template, entry: linkEntry("link", s.label, s.href) } : null;
      }),
    );
    if (links) return { listType: "links", members: links };
    return menuGroup(html, run);
  }
  if (tag === "a" && run.length >= 3) {
    const links = same(
      run.map((el) => {
        const s = linkShape(html, el);
        return s ? { template: s.template, entry: linkEntry("link", s.label, s.href) } : null;
      }),
    );
    return links ? { listType: "links", members: links } : null;
  }
  if ((tag === "p" || tag === "span") && run.length >= 3 && run[0]?.attribs?.class) {
    const texts = same(run.map((el) => textMember(html, el)));
    return texts ? { listType: "texts", members: texts } : null;
  }
  return null;
}

/** Maximal runs of consecutive same-tag element children, blank text between allowed. */
function siblingRuns(parent: DomNode): DomNode[][] {
  const runs: DomNode[][] = [];
  let current: DomNode[] = [];
  const flush = (): void => {
    if (current.length > 1) runs.push(current);
    current = [];
  };
  for (const c of parent.children ?? []) {
    if (isBlankText(c) || c.type === "comment") continue;
    if (!isElement(c)) {
      flush();
      continue;
    }
    if (current.length > 0 && current[0]?.name !== c.name) flush();
    current.push(c);
  }
  flush();
  return runs;
}

function hasOpaqueDescendant(n: DomNode): boolean {
  return (n.children ?? []).some(
    (c) => (isElement(c) && OPAQUE_TAGS.has(c.name ?? "")) || hasOpaqueDescendant(c),
  );
}

const FIELD_NAMES: Record<ListTypeSlug, { name: string; label: string }> = {
  texts: { name: "items", label: "Items" },
  links: { name: "links", label: "Links" },
  menu: { name: "menu", label: "Menu" },
};

/** Field name by where the group sits (`nav_links`, `footer_links`, …). */
function fieldNameFor(listType: ListTypeSlug, ancestors: readonly string[]): string {
  const base = FIELD_NAMES[listType].name;
  if (listType === "texts") return base;
  if (ancestors.includes("nav")) return listType === "menu" ? "nav_menu" : "nav_links";
  if (ancestors.includes("footer")) return `footer_${base}`;
  return base;
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
}

/**
 * Replace every repeated sibling group a shipped list type fits with a
 * `{{#field}}…{{/field}}` section and declare the local `list` field.
 * `usedNames` is extended with the minted names. Idempotent: a group
 * already written as a section contains template syntax and is skipped.
 */
export function extractRepeatedLists(html: string, usedNames: Set<string>): ListExtraction {
  const doc = parseDocument(html, {
    withStartIndices: true,
    withEndIndices: true,
    decodeEntities: false,
    lowerCaseTags: true,
  }) as unknown as DomNode;
  const replacements: { start: number; end: number; text: string }[] = [];
  const fields: ModuleField[] = [];

  const visit = (node: DomNode, ancestors: readonly string[]): void => {
    const converted = new Set<DomNode>();
    for (const run of siblingRuns(node)) {
      if (run.some(hasOpaqueDescendant)) continue;
      const shape = classifyRun(html, run);
      const first = run[0];
      const last = run[run.length - 1];
      const second = run[1];
      if (!shape || !first || !last || !second) continue;
      if (first.startIndex === null || last.endIndex === null || first.endIndex === null) continue;
      // Keep the whitespace between two members inside the block, so
      // inline entries (`<a>`, `<span>`) stay visually separated.
      const gap = html.slice(first.endIndex + 1, second.startIndex ?? first.endIndex + 1);
      const separator = /^\s*$/.test(gap) ? gap : "";
      const name = uniqueName(fieldNameFor(shape.listType, ancestors), usedNames);
      usedNames.add(name);
      const template = shape.members[0]?.template ?? "";
      replacements.push({
        start: first.startIndex,
        end: last.endIndex + 1,
        text: `{{#${name}}}${template}${separator}{{/${name}}}`,
      });
      fields.push({
        name,
        kind: "list",
        label: FIELD_NAMES[shape.listType].label,
        listType: shape.listType,
        default: shape.members.map((m) => m.entry),
      } as ModuleField);
      for (const m of run) converted.add(m);
    }
    for (const c of elementChildren(node)) {
      if (!converted.has(c)) visit(c, [...ancestors, c.name ?? ""]);
    }
  };
  visit(doc, []);

  let out = html;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, r.start)}${r.text}${out.slice(r.end)}`;
  }
  return { html: out, fields };
}

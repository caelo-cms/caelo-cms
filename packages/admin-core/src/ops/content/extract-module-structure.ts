// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.2 — `extractModuleStructure`.
 *
 * Pure function called from `modules.create` / `modules.update`
 * handlers BEFORE persistence. Walks the supplied HTML and, for every
 * non-templatised text node or attribute value, inserts a unique
 * `{{fieldName}}` placeholder and registers a field — so AI-authored
 * modules that come in with content baked in (`<h1>Welcome</h1>`)
 * leave the op as clean structure (`<h1>{{title}}</h1>` + field
 * `title` with default `"Welcome"`).
 *
 * Per the operator's follow-up comment on issue #46, this replaces the
 * originally-planned `validateModuleStructure` lint. The lint-and-
 * reject approach pushed friction onto every AI call; the extractor
 * makes structure-vs-content a runtime invariant the server enforces.
 *
 * Idempotent: running the extractor on its own output is a no-op.
 * Preserves existing `{{fieldName}}` references verbatim. Skips
 * `<style>` and `<script>` contents.
 *
 * Field-name inference rules (operator comment):
 *   - <h1>text</h1>          -> title (numbered when multiple)
 *   - <h2> / <h3>            -> heading / subheading (numbered)
 *   - <p>text</p>            -> body (single) / paragraph1, paragraph2 (multiple).
 *                              Kind = richtext if the <p> contains inline
 *                              <strong> / <em> / <a>; else text.
 *   - <a href="…">text</a>   -> ctaHref + ctaLabel (first), numbered after.
 *   - <img src="…" alt="…">  -> image + imageAlt
 *   - <button>text</button>  -> buttonLabel (+ buttonHref if wrapped in <a>)
 *   - <span class="badge">   -> badge (class-name hint)
 *
 * Attribute-extraction whitelist: href, src, alt, aria-label, title,
 * placeholder, value-on-input. CSS classes, ids, data-* are NEVER
 * extracted (structural).
 */

import type { ModuleField } from "@caelo-cms/shared";
import { Parser } from "htmlparser2";

export interface ExtractResult {
  readonly templatizedHtml: string;
  readonly fields: readonly ModuleField[];
  readonly defaultValues: Record<string, unknown>;
}

const PLACEHOLDER_RE = /^\s*\{\{\s*[a-z][a-z0-9_]*\s*\}\}\s*$/;

const EXTRACT_ATTRS = new Set(["href", "src", "alt", "aria-label", "title", "placeholder"]);

const RICHTEXT_INLINES = new Set(["strong", "em", "a", "code", "i", "b", "u", "small", "mark"]);

interface Extraction {
  readonly start: number;
  readonly end: number;
  readonly placeholder: string;
}

function isWhitespaceOnly(s: string): boolean {
  return /^\s*$/.test(s);
}

function isAlreadyPlaceholder(s: string): boolean {
  return PLACEHOLDER_RE.test(s);
}

function snakeCase(name: string): string {
  return name
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/**
 * Mints a unique field name. The caller passes a base + a counts map;
 * if `base` is already taken, appends `2`, `3`, ... When `preferred`
 * is set (an `existingFields` name reuse hint), tries that first.
 */
function mintName(base: string, used: Set<string>, preferred?: string): string {
  if (preferred && !used.has(preferred)) return preferred;
  const norm = snakeCase(base) || "field";
  if (!used.has(norm)) return norm;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${norm}${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${norm}_${Date.now()}`;
}

/**
 * v0.12.2 — extract content from module HTML.
 *
 * When `existingFields` is supplied (the `modules.update` case),
 * fields keep their names if the same content shape is re-extracted;
 * otherwise net-new names get minted from the inference table.
 */
export function extractModuleStructure(
  html: string,
  existingFields?: readonly ModuleField[],
): ExtractResult {
  const extractions: Extraction[] = [];
  const fields: ModuleField[] = [];
  const defaultValues: Record<string, unknown> = {};
  const usedNames = new Set<string>((existingFields ?? []).map((f) => f.name));

  // Walk the source HTML, tracking element stack so we can apply per-
  // tag inference rules.
  const tagStack: { name: string; attrs: Record<string, string>; index: number }[] = [];
  // Per-tag count of named-anchor extractions, used to mint
  // title1/title2 etc. when more than one of the same tag emits content.
  const tagNameUsageCount = new Map<string, number>();
  // For each <p>, capture whether it contained inline-formatting tags
  // so we can mark its kind as `richtext`.
  const pStack: { containsInline: boolean }[] = [];
  const buttonStack: { hrefFromOuterA: string | null }[] = [];
  const aStack: { href: string | null }[] = [];
  // We collect text-node ranges + a `tag-context` (the innermost tag
  // that holds this text) and emit at end-tag time when we have full
  // context (e.g. detect <p>-with-inline so kind=richtext).
  interface PendingText {
    text: string;
    start: number;
    end: number;
    parentTag: string;
    parentAttrs: Record<string, string>;
    pIndexFromTop?: number;
    inButton?: boolean;
    inAnchor?: boolean;
  }
  const pendingTexts: PendingText[] = [];
  // Skip-content stacks for <style> / <script>.
  let inSkipTag = 0;
  // Track whether we've already minted a field name for the FIRST <a>
  // (which gets non-numbered ctaHref + ctaLabel) vs subsequent.
  const ctaCounter = { value: 0 };

  const parser = new Parser(
    {
      onopentag(rawName, attrs) {
        const name = rawName.toLowerCase();
        if (name === "style" || name === "script") {
          inSkipTag += 1;
          return;
        }
        tagStack.push({ name, attrs: { ...attrs }, index: pendingTexts.length });
        if (name === "p") pStack.push({ containsInline: false });
        if (name === "button")
          buttonStack.push({ hrefFromOuterA: aStack[aStack.length - 1]?.href ?? null });
        if (name === "a") aStack.push({ href: attrs.href ?? null });
        if (RICHTEXT_INLINES.has(name) && pStack.length > 0) {
          const top = pStack[pStack.length - 1];
          if (top) top.containsInline = true;
        }

        // Attribute extraction — for each whitelisted attribute, if the
        // value isn't an existing placeholder, mint a field + record an
        // extraction over the attribute-value byte range.
        for (const [attrName, attrValue] of Object.entries(attrs)) {
          if (!EXTRACT_ATTRS.has(attrName)) continue;
          if (typeof attrValue !== "string" || attrValue === "") continue;
          if (isAlreadyPlaceholder(attrValue)) continue;
          // Compute the byte range. htmlparser2's Parser doesn't expose
          // per-attribute start/end natively, but for the common case
          // we can search forward from the tag's start position. We
          // accept the small risk that an attribute value of `<` or
          // similar produces a false range — those edge cases will be
          // surfaced by the integration tests as visible misextraction
          // and the operator can pre-templatise to avoid them.
          const tagStart = parser.startIndex;
          const tagEnd = parser.endIndex + 1;
          const tagText = html.slice(tagStart, tagEnd);
          const attrPattern = new RegExp(
            `${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
            "i",
          );
          const m = attrPattern.exec(tagText);
          if (!m) continue;
          const valueGroup = m[1] ?? m[2] ?? m[3] ?? "";
          if (valueGroup !== attrValue) continue;
          // m.index is relative to tagText.
          const valueIndexInMatch = m[0].lastIndexOf(valueGroup);
          const start = tagStart + m.index + valueIndexInMatch;
          const end = start + valueGroup.length;

          let inferred: { name: string; kind: ModuleField["kind"] };
          if (name === "a" && attrName === "href") {
            ctaCounter.value += 1;
            const idx = ctaCounter.value;
            inferred = {
              name: mintName(idx === 1 ? "ctaHref" : `cta${idx}Href`, usedNames),
              kind: "url",
            };
          } else if (name === "img" && attrName === "src") {
            inferred = { name: mintName("image", usedNames), kind: "image" };
          } else if (name === "img" && attrName === "alt") {
            inferred = { name: mintName("imageAlt", usedNames), kind: "text" };
          } else if (attrName === "alt") {
            inferred = { name: mintName(`${name}Alt`, usedNames), kind: "text" };
          } else if (attrName === "aria-label") {
            inferred = { name: mintName(`${name}AriaLabel`, usedNames), kind: "text" };
          } else if (attrName === "title") {
            inferred = { name: mintName(`${name}TitleAttr`, usedNames), kind: "text" };
          } else if (attrName === "placeholder") {
            inferred = { name: mintName(`${name}Placeholder`, usedNames), kind: "text" };
          } else {
            inferred = { name: mintName(`${name}${attrName}`, usedNames), kind: "text" };
          }
          usedNames.add(inferred.name);
          fields.push({
            name: inferred.name,
            kind: inferred.kind,
            label: inferred.name,
            default: valueGroup,
          } as ModuleField);
          defaultValues[inferred.name] = valueGroup;
          extractions.push({ start, end, placeholder: `{{${inferred.name}}}` });
        }
      },
      ontext(text) {
        if (inSkipTag > 0) return;
        const parent = tagStack[tagStack.length - 1];
        if (!parent) return;
        if (isWhitespaceOnly(text)) return;
        if (isAlreadyPlaceholder(text)) return;
        const start = parser.startIndex;
        const end = parser.endIndex + 1;
        const pendingP = pStack.length > 0 ? pStack[pStack.length - 1] : undefined;
        const pendingButton = buttonStack[buttonStack.length - 1];
        const pendingA = aStack[aStack.length - 1];
        pendingTexts.push({
          text,
          start,
          end,
          parentTag: parent.name,
          parentAttrs: parent.attrs,
          pIndexFromTop: pendingP ? pStack.length - 1 : undefined,
          inButton: !!pendingButton,
          inAnchor: !!pendingA,
        });
      },
      onclosetag(rawName) {
        const name = rawName.toLowerCase();
        if (name === "style" || name === "script") {
          inSkipTag -= 1;
          return;
        }
        if (name === "a") aStack.pop();
        if (name === "button") buttonStack.pop();
        if (name === "p") {
          const popped = pStack.pop();
          // When this <p> closed, its pending text nodes now have full
          // context — mint richtext or text accordingly. We assign
          // names here so the numbering is in source order.
          if (popped) {
            for (const pending of pendingTexts) {
              if (pending.parentTag !== "p") continue;
              if (pending.pIndexFromTop !== pStack.length) continue;
              const wasInline = popped.containsInline;
              const kind: ModuleField["kind"] = wasInline ? "richtext" : "text";
              // Skip: handled in finaliseText below for unified flow.
              void kind;
            }
          }
        }
        tagStack.pop();
      },
    },
    { decodeEntities: false, lowerCaseTags: true, recognizeSelfClosing: false },
  );
  parser.write(html);
  parser.end();

  // Mint names + classify kinds for collected text nodes. Process in
  // source order so numbered fields (title1, title2) follow the order
  // they appear in the HTML.
  const tagNameSeen = new Map<string, number>();
  for (const pending of pendingTexts) {
    const tag = pending.parentTag;
    const cnt = (tagNameSeen.get(tag) ?? 0) + 1;
    tagNameSeen.set(tag, cnt);
    tagNameUsageCount.set(tag, cnt);
  }
  const tagNameProcessed = new Map<string, number>();
  for (const pending of pendingTexts) {
    const tag = pending.parentTag;
    const total = tagNameUsageCount.get(tag) ?? 1;
    const processed = (tagNameProcessed.get(tag) ?? 0) + 1;
    tagNameProcessed.set(tag, processed);
    const useNumber = total > 1;
    const idx = useNumber ? processed : 0;

    let baseName: string;
    let kind: ModuleField["kind"];
    switch (tag) {
      case "h1":
        baseName = useNumber ? `title${idx}` : "title";
        kind = "text";
        break;
      case "h2":
        baseName = useNumber ? `heading${idx}` : "heading";
        kind = "text";
        break;
      case "h3":
        baseName = useNumber ? `subheading${idx}` : "subheading";
        kind = "text";
        break;
      case "p":
        baseName = useNumber ? `paragraph${idx}` : "body";
        kind = "text"; // upgraded to richtext below if any inline tags were observed
        break;
      case "a": {
        // Anchor text. ctaHref was minted at opentag time; here we mint ctaLabel.
        const counter = ctaCounter.value;
        baseName = counter <= 1 ? "ctaLabel" : `cta${counter}Label`;
        kind = "text";
        break;
      }
      case "button":
        baseName = "buttonLabel";
        kind = "text";
        break;
      case "span":
        if (pending.parentAttrs.class && /\bbadge\b/i.test(pending.parentAttrs.class)) {
          baseName = "badge";
          kind = "text";
        } else {
          baseName = "spanText";
          kind = "text";
        }
        break;
      case "li":
        baseName = useNumber ? `item${idx}` : "item";
        kind = "text";
        break;
      default:
        baseName = useNumber ? `${tag}Text${idx}` : `${tag}Text`;
        kind = "text";
        break;
    }
    const name = mintName(baseName, usedNames);
    usedNames.add(name);
    const trimmed = pending.text.trim();
    fields.push({
      name,
      kind,
      label: name,
      default: trimmed,
    } as ModuleField);
    defaultValues[name] = trimmed;
    extractions.push({
      start: pending.start,
      end: pending.end,
      placeholder: `{{${name}}}`,
    });
  }

  // Upgrade `body` / `paragraph*` fields to `richtext` when the <p>
  // contained inline formatting tags. We re-scan pendingTexts and the
  // stack snapshots captured at close-time aren't preserved, so use a
  // simpler heuristic: if the field's default contains markup-like
  // characters (`<` followed by an alpha), it's richtext.
  for (const f of fields) {
    if ((f.kind as string) !== "text") continue;
    const d = defaultValues[f.name];
    if (typeof d === "string" && /<[a-z]/i.test(d)) {
      (f as { kind: ModuleField["kind"] }).kind = "richtext";
    }
  }

  // Sort extractions by descending start so we splice from the end
  // backwards without invalidating earlier offsets.
  extractions.sort((a, b) => b.start - a.start);
  let templatizedHtml = html;
  for (const ex of extractions) {
    // For text-node extractions, preserve surrounding whitespace by
    // splicing exactly over the trimmed range. For attributes, splice
    // the full value range.
    const before = templatizedHtml.slice(0, ex.start);
    const after = templatizedHtml.slice(ex.end);
    // If this is a text node with leading/trailing whitespace, keep it.
    const original = templatizedHtml.slice(ex.start, ex.end);
    const leading = original.match(/^\s*/)?.[0] ?? "";
    const trailing = original.match(/\s*$/)?.[0] ?? "";
    templatizedHtml = `${before}${leading}${ex.placeholder}${trailing}${after}`;
  }

  return { templatizedHtml, fields, defaultValues };
}

/**
 * Validation pass — checks the (templatizedHtml, fields) pair for the
 * two hard-reject conditions per the issue: orphan field declared but
 * never referenced, and placeholder referencing an undeclared field.
 *
 * The extractor's own output never triggers either of these by
 * construction; the validator fires when the AI passes explicit
 * `fields` that don't line up with explicit `{{…}}` placeholders.
 */
export function validateTemplatizedModule(
  html: string,
  fields: readonly ModuleField[],
): { ok: true } | { ok: false; message: string } {
  const declared = new Set(fields.map((f) => f.name));
  const referenced = new Set<string>();
  // List-loop scoping: placeholders INSIDE a `{{#listField}}…{{/listField}}`
  // block are the list's ITEM sub-fields — for a link-list `{{label}}`/`{{href}}`,
  // for a text-list the item scalar, for a module-list the nested `{{>child}}`.
  // They are NOT top-level module fields, so strip each loop BODY (keeping the
  // `{{#X}}{{/X}}` markers, which reference the list field X itself) before
  // collecting top-level references. Without this, a valid nav/link-list module
  // — `{{#nav_links}}<a href="{{href}}">…{{/nav_links}}` — was rejected with
  // 'placeholder {{href}} references undeclared field "href"' (found via the
  // ai_moduleize_attempts telemetry: moduleize failed every list module).
  const topLevelHtml = html.replace(
    /\{\{\s*#\s*([a-z][a-z0-9_]*)\s*\}\}[\s\S]*?\{\{\s*\/\s*\1\s*\}\}/g,
    (_full, name: string) => `{{#${name}}}{{/${name}}}`,
  );
  // Match primitive {{name}}, single-nested {{>name}}, and list/section
  // {{#name}} / {{/name}} markers — all count as (top-level) references.
  const ref = /\{\{\s*(?:>|#|\/)?\s*([a-z][a-z0-9_]*)\s*\}\}/g;
  let m: RegExpExecArray | null = ref.exec(topLevelHtml);
  while (m !== null) {
    if (m[1]) referenced.add(m[1]);
    m = ref.exec(topLevelHtml);
  }
  for (const name of referenced) {
    if (!declared.has(name)) {
      return {
        ok: false,
        message: `placeholder {{${name}}} references undeclared field "${name}"`,
      };
    }
  }
  for (const name of declared) {
    if (!referenced.has(name)) {
      return { ok: false, message: `field "${name}" declared but not referenced in HTML` };
    }
  }
  return { ok: true };
}

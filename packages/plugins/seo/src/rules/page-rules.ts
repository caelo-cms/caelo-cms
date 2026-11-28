// SPDX-License-Identifier: MPL-2.0

/**
 * #1757 — the objective rules the seo plugin checks on every staged page,
 * from the facts core read out of the page's HTML (`PluginAuditPageFacts`,
 * #1755). Each one is something a crawler or a screen reader gets wrong,
 * not a rule of thumb (those are write hints, ../hints/):
 *
 * - `h1-count` — not exactly one `<h1>`: the H1 names the page's topic.
 * - `heading-level-skipped` — a heading more than one level below the one
 *   before it (h2 → h4): the outline loses a level (axe `heading-order`).
 * - `heading-empty` — a heading that shows nothing (axe `empty-heading`).
 * - `image-alt-missing` — an image without an `alt` that is not marked
 *   decorative (`alt=""`, `role="presentation"`, `aria-hidden`).
 * - `image-alt-filename` — an `alt` that is a file name (`IMG_0042.jpg`).
 * - `link-text-empty` — a link with no text or label.
 * - `link-text-generic` — a link text that says nothing on its own ("click
 *   here", "mehr"), as Lighthouse's SEO audit judges link texts.
 * - `placeholder-text` — lorem ipsum, a "TODO:" left on the page.
 * - `share-image-missing` / `share-image-format` — an indexable page
 *   without `og:image`, or with one that is no JPEG or PNG (LinkedIn shows
 *   no WebP or AVIF).
 *
 * A fact a cap cut short (`truncatedFacts`) is only used where the part
 * that is there already proves the finding.
 */

import type { PluginAuditFinding, PluginAuditPageFacts } from "@caelo-cms/plugin-sdk";

type Facts = PluginAuditPageFacts;
type Finding = PluginAuditFinding;

/** Most findings of one rule on one page: the first ones name the fix. */
const PER_PAGE = 3;

/** Does the page ask to stay out of search (`<meta name="robots">` noindex)? */
export function isNoindex(f: Facts): boolean {
  return (f.robots ?? "").split(",").some((d) => d.trim() === "noindex" || d.trim() === "none");
}

function quote(text: string, max = 80): string {
  return `"${text.length > max ? `${text.slice(0, max - 1)}…` : text}"`;
}

/** Where a fact sits, for the AI to find it: the module, list entry or plugin output. */
function where(place: {
  readonly moduleId: string | null;
  readonly listItem: string | null;
  readonly pluginSlug: string | null;
}): string {
  if (place.pluginSlug) return ` (output of the ${place.pluginSlug} plugin)`;
  if (place.listItem)
    return ` (list entry ${place.listItem}${place.moduleId ? ` in module ${place.moduleId}` : ""})`;
  if (place.moduleId) return ` (module ${place.moduleId})`;
  return " (the page's template or layout)";
}

/** `h1-count`, `heading-level-skipped`, `heading-empty`. */
export function headingFindings(f: Facts): Finding[] {
  const out: Finding[] = [];
  const cut = f.truncatedFacts.includes("headings");
  const h1s = f.headings.filter((h) => h.level === 1);
  if (h1s.length > 1 || (h1s.length === 0 && !cut)) {
    out.push({
      rule: "h1-count",
      severity: "error",
      pageId: f.pageId,
      message:
        h1s.length === 0
          ? `No H1: ${f.path} has no <h1>. Search engines and screen readers take the H1 as the page's topic.`
          : `More than one H1: ${f.path} has ${h1s.length} <h1> headings (${h1s
              .slice(0, 3)
              .map((h) => `${quote(h.text, 40)}${where(h)}`)
              .join(", ")}). One H1 names the page's topic; the others are sections.`,
      fix: {
        tool: "update_modules_many",
        hint:
          h1s.length === 0
            ? "Make the page's main heading (usually in its first module) an <h1>."
            : "Keep the H1 that names the page's topic and make the others <h2> in their modules' markup.",
      },
    });
  }
  let previous = 0;
  let skipped = 0;
  for (const h of f.headings) {
    if (previous > 0 && h.level > previous + 1 && skipped < PER_PAGE) {
      skipped += 1;
      out.push({
        rule: "heading-level-skipped",
        severity: "error",
        pageId: f.pageId,
        message: `Heading level skipped: on ${f.path} the h${h.level} ${quote(h.text, 60)}${where(h)} follows an h${previous}, so the outline jumps a level for screen readers.`,
        fix: {
          tool: "update_modules_many",
          hint: `Make it an h${previous + 1}, or put the missing level above it, in the module's markup.`,
        },
      });
    }
    previous = h.level;
  }
  for (const h of f.headings.filter((x) => x.text === "").slice(0, PER_PAGE)) {
    out.push({
      rule: "heading-empty",
      severity: "error",
      pageId: f.pageId,
      message: `Empty heading: an h${h.level} on ${f.path}${where(h)} shows no text, so screen readers announce a heading with nothing in it.`,
      fix: {
        tool: "update_modules_many",
        hint: "Give the heading its text (a field value), or use a non-heading element if it only spaces the layout.",
      },
    });
  }
  return out;
}

/** An alt that is a file name: a picture's name on disk says nothing about it. */
export function isFileNameAlt(alt: string): boolean {
  const a = alt.trim();
  return (
    /\.(?:jpe?g|png|webp|gif|svg|avif|heic|tiff?|bmp)$/i.test(a) ||
    /^(?:img|image|dsc|dscn|dcim|pxl|screenshot|photo|bild|foto)[-_ ]?\d[\w-]*$/i.test(a)
  );
}

/** `image-alt-missing`, `image-alt-filename`. */
export function imageFindings(f: Facts): Finding[] {
  const out: Finding[] = [];
  const missing = f.images.filter((i) => i.alt === null && !i.decorative);
  for (const i of missing.slice(0, PER_PAGE)) {
    out.push({
      rule: "image-alt-missing",
      severity: "error",
      pageId: f.pageId,
      message: `Image without alt text: on ${f.path} the image ${i.media ? `"${i.media.ref}" (find_media finds it)` : quote(i.src?.href ?? "(no src)", 60)}${where(i)} has no alt attribute, so screen readers and image search get nothing.`,
      fix: {
        tool: "patch_page_module_fields",
        hint: 'Write alt text for it where its module takes it (a field value, or update_modules_many for markup); alt="" only for a purely decorative image.',
      },
    });
  }
  if (missing.length > PER_PAGE) {
    out.push({
      rule: "image-alt-missing",
      severity: "error",
      pageId: f.pageId,
      message: `Images without alt text: ${f.path} has ${missing.length - PER_PAGE} more images without an alt attribute.`,
      fix: { tool: "patch_page_module_fields", hint: "Give every image of the page alt text." },
    });
  }
  for (const i of f.images
    .filter((x) => x.alt !== null && x.alt !== "" && isFileNameAlt(x.alt))
    .slice(0, PER_PAGE)) {
    out.push({
      rule: "image-alt-filename",
      severity: "error",
      pageId: f.pageId,
      message: `Alt text is a file name: on ${f.path} an image${where(i)} has the alt ${quote(i.alt as string)}, which tells a screen reader nothing about the picture.`,
      fix: {
        tool: "patch_page_module_fields",
        hint: "Describe what the image shows in a short sentence where its module takes the alt text.",
      },
    });
  }
  return out;
}

/**
 * Link texts that say nothing on their own, modelled on Lighthouse's SEO
 * `link-text` audit (which fails the pages a Stage's Lighthouse run sees),
 * in the languages Caelo sites are written in most.
 */
const GENERIC_LINK_TEXTS = new Set([
  "click here",
  "click this",
  "go",
  "here",
  "information",
  "learn more",
  "more",
  "more info",
  "more information",
  "right here",
  "read more",
  "see more",
  "start",
  "this",
  "hier",
  "hier klicken",
  "mehr",
  "mehr erfahren",
  "mehr informationen",
  "weiterlesen",
  "weiter",
  "klicken sie hier",
  "cliquez ici",
  "en savoir plus",
  "ici",
  "plus",
  "aquí",
  "haz clic aquí",
  "más",
  "más información",
  "leer más",
  "clicca qui",
  "qui",
  "di più",
  "klik hier",
  "meer",
  "lees meer",
  "clique aqui",
  "aqui",
  "saiba mais",
]);

/** `link-text-empty`, `link-text-generic`. */
export function linkTextFindings(f: Facts): Finding[] {
  const out: Finding[] = [];
  const empty = f.links.filter((l) => l.text.trim() === "");
  for (const l of empty.slice(0, PER_PAGE)) {
    out.push({
      rule: "link-text-empty",
      severity: "error",
      pageId: f.pageId,
      message: `Link without text: on ${f.path} the link to ${quote(l.href, 60)}${where(l)} has no text, no aria-label and no image alt, so neither screen readers nor search engines know where it leads.`,
      fix: {
        tool: "update_modules_many",
        hint: "Give the link visible text, or an aria-label naming its target when it is an icon.",
      },
    });
  }
  const generic = f.links.filter((l) =>
    GENERIC_LINK_TEXTS.has(
      l.text
        .trim()
        .toLowerCase()
        .replace(/[.!…»›→>]+$/u, "")
        .trim(),
    ),
  );
  for (const l of generic.slice(0, PER_PAGE)) {
    out.push({
      rule: "link-text-generic",
      severity: "error",
      pageId: f.pageId,
      message: `Link text says nothing: on ${f.path} the link ${quote(l.text, 40)} to ${quote(l.href, 60)}${where(l)} does not say where it leads (search engines read a link's text as its target's topic, and Lighthouse's SEO audit fails such links).`,
      fix: {
        tool: "update_modules_many",
        hint: "Name the target in the link text (“Read the pricing guide”), in the module's markup or the field that holds the text.",
      },
    });
  }
  return out;
}

/** Text left from a draft: placeholder copy and notes for the writer. */
export function isPlaceholderText(text: string): boolean {
  return (
    /\blorem ipsum\b/i.test(text) ||
    /^\s*(?:todo|tbd|fixme|xxx)\s*(?::|$)/i.test(text) ||
    /\[(?:todo|tbd|placeholder|platzhalter)\b[^\]]*\]/i.test(text)
  );
}

/** `placeholder-text`: lorem ipsum, a "TODO:" in the page or its title / description. */
export function placeholderFindings(f: Facts): Finding[] {
  const hits = [
    ...(f.title && isPlaceholderText(f.title) ? [{ text: f.title, at: " (the <title>)" }] : []),
    ...(f.metaDescription && isPlaceholderText(f.metaDescription)
      ? [{ text: f.metaDescription, at: " (the meta description)" }]
      : []),
    ...f.texts
      .filter((t) => t.source !== "literal" && isPlaceholderText(t.text))
      .map((t) => ({ text: t.text, at: where(t) })),
  ];
  return hits.slice(0, PER_PAGE).map((h) => ({
    rule: "placeholder-text",
    severity: "error",
    pageId: f.pageId,
    message: `Placeholder text: ${f.path} shows ${quote(h.text, 60)}${h.at}, text left from a draft that visitors and search engines read as the page's content.`,
    fix: {
      tool: "set_page_module_content_many",
      hint: "Replace it with the real text (or remove it) where it is written; ask the operator when the real text is not known.",
    },
  }));
}

/** The file type a share image URL names, from its path (`/_assets/x.<hash>.jpg`). */
function shareImageType(url: string): string | null {
  let path: string;
  try {
    path = new URL(url, "https://site.invalid").pathname;
  } catch {
    return null;
  }
  const ext = /\.([a-z0-9]{2,5})$/i.exec(path)?.[1]?.toLowerCase();
  return ext ?? null;
}

/** `share-image-missing`, `share-image-format`, for an indexable page. */
export function shareImageFindings(f: Facts): Finding[] {
  if (isNoindex(f)) return [];
  const image = f.socialMeta.find((m) => m.key === "og:image" || m.key === "og:image:url");
  if (!image) {
    if (f.truncatedFacts.includes("socialMeta")) return [];
    return [
      {
        rule: "share-image-missing",
        severity: "error",
        pageId: f.pageId,
        message: `No share image: ${f.path} has no og:image, so a link to it shared on social networks and messengers shows no picture.`,
        fix: {
          tool: "set_page_seo_many",
          hint: "Set the page's ogImageAssetId (a JPEG or PNG library image), or bind a site default with set_theme_asset slot socialShare.",
        },
      },
    ];
  }
  const type = shareImageType(image.content);
  if (type === "jpg" || type === "jpeg" || type === "png") return [];
  return [
    {
      rule: "share-image-format",
      severity: "error",
      pageId: f.pageId,
      message: `Share image is no JPEG or PNG: the og:image of ${f.path} is ${type ? `a .${type} file` : `${quote(image.content, 60)}`}; LinkedIn shows no WebP or AVIF share images, and some messengers none either. The site ships a library image's original as the share image when it is a JPEG or PNG of at most 5 MB.`,
      fix: {
        tool: "set_page_seo_many",
        hint: "Pick (find_media) or add (import_media_from_urls) a JPEG or PNG image of at most 5 MB and set it as the page's ogImageAssetId, or as the site default (set_theme_asset slot socialShare).",
      },
    },
  ];
}

/** Every page rule on one page's facts. */
export function pageFindings(f: Facts): Finding[] {
  return [
    ...headingFindings(f),
    ...imageFindings(f),
    ...linkTextFindings(f),
    ...placeholderFindings(f),
    ...shareImageFindings(f),
  ];
}

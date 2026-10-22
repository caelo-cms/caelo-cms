// SPDX-License-Identifier: MPL-2.0

/**
 * SVG sanitiser for uploads. Caelo accepts SVG (icons, logos), but SVG is
 * XML and can carry executable content. The output is served as
 * `image/svg+xml` from the admin origin (`/_caelo/media/*`, the staging
 * preview proxy) and from the public site's `_assets/` tree, so anything
 * that survives here can run script in a first-party origin.
 *
 * Why a parser-based ALLOWLIST and not regex stripping: the previous
 * regex denylist was bypassed by every construct it did not spell out —
 * namespace prefixes outside `[a-z0-9_-]` (`<a.b:script>`), DTD internal
 * entities that expand to markup or to a `javascript:` URL (`<!ENTITY>`),
 * schemes split by whitespace the URL parser drops (`java\nscript:`),
 * XHTML-namespaced `<iframe>` / `<embed>` outside `<foreignObject>`, and
 * `<?xml-stylesheet?>` XSLT. Rebuilding the document from parser events
 * means only names we know are safe are ever written back, and every
 * attribute value is checked AFTER entity decoding — the form the browser
 * acts on.
 *
 * What survives: the rendering elements of SVG 1.1/2 (shapes, text,
 * paint servers, filters, clipping/masking, `<use>`, `<a>`, `<image>`,
 * `<style>`) and SMIL animation that cannot target a link or an event
 * handler. What goes: every other element with its whole subtree
 * (`script`, `foreignObject`, anything namespaced — including editor
 * metadata like `sodipodi:namedview`), DOCTYPE / processing instructions
 * / comments, `on*` attributes, namespaced attributes other than
 * `xlink:` / `xml:`, `xml:base`, foreign `xmlns` declarations, and any
 * link whose decoded value is not a fragment, a relative or http(s) URL,
 * or an embedded raster image (`data:image/png|jpeg|gif|webp|avif`).
 */

import { Parser } from "htmlparser2";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Elements written back. Case-sensitive, as in XML (`Script` is dropped). */
const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "a",
  "image",
  "view",
  "style",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "clipPath",
  "mask",
  "pattern",
  "marker",
  "linearGradient",
  "radialGradient",
  "stop",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "animate",
  "animateMotion",
  "animateTransform",
  "set",
  "mpath",
]);

/** SMIL elements: kept only while they cannot rewrite a link or a handler. */
const ANIMATION_ELEMENTS = new Set(["animate", "animateMotion", "animateTransform", "set"]);

/** Embedded rasters are how design tools inline bitmaps; they cannot script. */
const SAFE_DATA_URL_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif)[;,]/;

/**
 * The browser strips ASCII whitespace and C0 controls from a URL before
 * reading its scheme, so `java\nscript:` IS `javascript:`. Normalise the
 * same way before deciding.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point.
const URL_IGNORED_CHARS_RE = /[\u0000- \u007f]+/g;

/** A link value the browser could follow into script — or into another document. */
function isSafeLink(tagName: string, value: string): boolean {
  const v = value.replace(URL_IGNORED_CHARS_RE, "").toLowerCase();
  if (v === "" || v.startsWith("#")) return true;
  if (v.startsWith("//")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v);
  // No scheme before the first path/query/fragment delimiter = relative URL.
  if (!scheme) return true;
  if (scheme[1] === "http" || scheme[1] === "https") {
    return tagName.toLowerCase() === "a";
  }
  return SAFE_DATA_URL_RE.test(v);
}

function isLinkAttribute(lowerName: string): boolean {
  return lowerName === "href" || lowerName === "xlink:href";
}

/**
 * Keep an attribute? `value` is already entity-decoded by the parser.
 * Names are compared case-insensitively where an HTML parser would be
 * case-insensitive (an inlined SVG reads `ONLOAD` / `HREF` too).
 */
function keepAttribute(tagName: string, name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) return false;
  if (lower === "xmlns") return value === SVG_NS;
  if (lower.startsWith("xmlns:")) return lower === "xmlns:xlink" && value === XLINK_NS;
  if (lower === "xml:base") return false;
  if (lower.includes(":") && !lower.startsWith("xlink:") && !lower.startsWith("xml:")) {
    return false;
  }
  if (isLinkAttribute(lower)) return isSafeLink(tagName, value);
  return true;
}

/**
 * SMIL can rewrite another attribute at runtime (`<set attributeName="href"
 * to="javascript:…">`), which no static attribute check sees. An animation
 * of a link or an event handler is dropped whole.
 */
function isSafeAnimation(attribs: Record<string, string>): boolean {
  for (const [name, value] of Object.entries(attribs)) {
    if (name.toLowerCase() !== "attributename") continue;
    const target = value.trim().toLowerCase();
    if (target.startsWith("on") || target.endsWith("href")) return false;
  }
  return true;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/**
 * Rebuild `svg` from an allowlist of SVG elements and attributes (see the
 * file comment for what survives). Idempotent: sanitising the output
 * again returns it unchanged.
 *
 * @param svg - the uploaded document, decoded as UTF-8.
 * @returns a well-formed SVG with no executable content. The root `<svg>`
 *   always carries the SVG namespace (and the xlink one when an `xlink:`
 *   attribute survives), so a file whose namespaces were declared through
 *   now-removed DTD entities still renders.
 */
export function sanitizeSvg(svg: string): string {
  const out: string[] = [];
  /** Depth inside a dropped element; > 0 suppresses everything. */
  let droppedDepth = 0;
  /** Open, written elements — so text outside the root is dropped. */
  let openDepth = 0;
  /** Index in `out` of the root `<svg` open tag, patched with namespaces at the end. */
  let rootIndex = -1;
  let usesXlink = false;
  /** The last written open tag still lacks its `>` (it may self-close). */
  let pendingOpen = false;

  const flushOpen = (): void => {
    if (pendingOpen) {
      out.push(">");
      pendingOpen = false;
    }
  };

  const parser: Parser = new Parser(
    {
      onopentag(name, attribs) {
        if (droppedDepth > 0) {
          droppedDepth++;
          return;
        }
        const allowed =
          ALLOWED_ELEMENTS.has(name) && (!ANIMATION_ELEMENTS.has(name) || isSafeAnimation(attribs));
        if (!allowed) {
          droppedDepth = 1;
          return;
        }
        flushOpen();
        let tag = `<${name}`;
        for (const [attr, value] of Object.entries(attribs)) {
          if (!keepAttribute(name, attr, value)) continue;
          if (attr.toLowerCase().startsWith("xlink:")) usesXlink = true;
          tag += ` ${attr}="${escapeAttr(value)}"`;
        }
        if (openDepth === 0 && name === "svg" && rootIndex === -1) rootIndex = out.length;
        out.push(tag);
        openDepth++;
        pendingOpen = true;
        // Self-closing in the source (`<rect/>`) stays self-closing; the
        // parser reports it as an immediate close.
        if (svg[parser.endIndex - 1] !== "/") flushOpen();
      },
      onclosetag(name) {
        if (droppedDepth > 0) {
          droppedDepth--;
          return;
        }
        if (openDepth === 0) return;
        openDepth--;
        if (pendingOpen) {
          out.push("/>");
          pendingOpen = false;
        } else {
          out.push(`</${name}>`);
        }
      },
      ontext(text) {
        // Text outside the root (incl. the `]>` left of a DTD internal
        // subset) is not allowed by XML and would break the document.
        if (droppedDepth > 0 || openDepth === 0) return;
        flushOpen();
        out.push(escapeText(text));
      },
      // DOCTYPE (and with it every DTD entity), `<?xml-stylesheet?>` and
      // comments are dropped by not handling them.
    },
    { xmlMode: true, decodeEntities: true, recognizeCDATA: true, recognizeSelfClosing: true },
  );
  parser.write(svg);
  parser.end();

  if (rootIndex !== -1) {
    const root = out[rootIndex] ?? "";
    let ns = "";
    if (!/\sxmlns="/.test(root)) ns += ` xmlns="${SVG_NS}"`;
    if (usesXlink && !/\sxmlns:xlink="/.test(root)) ns += ` xmlns:xlink="${XLINK_NS}"`;
    out[rootIndex] = `<svg${ns}${root.slice("<svg".length)}`;
  }
  return out.join("");
}

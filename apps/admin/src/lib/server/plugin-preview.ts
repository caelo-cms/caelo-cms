// SPDX-License-Identifier: MPL-2.0

import { Parser } from "htmlparser2";

const tags = new Set([
  "html",
  "head",
  "body",
  "style",
  "main",
  "section",
  "article",
  "header",
  "footer",
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "small",
  "strong",
  "em",
  "br",
  "hr",
  "img",
  "figure",
  "figcaption",
  "ol",
  "ul",
  "li",
]);
const voids = new Set(["br", "hr", "img"]);
export function escapePreviewText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Untrusted plugin HTML: no links, forms, scripts, embeds, SVG, refresh or external assets.
 * Paired with document-level CSP sandbox even when opened outside an iframe.
 */
export function sanitizePluginPreview(html: string): string {
  let result = "";
  let blocked = 0;
  let inStyle = false;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (blocked || !tags.has(name)) {
          blocked++;
          return;
        }
        result += `<${name}`;
        for (const [key, value] of Object.entries(attributes)) {
          if (
            ["class", "style", "lang", "dir", "alt", "width", "height", "aria-label"].includes(key)
          )
            result += ` ${key}="${escapePreviewText(value)}"`;
          else if (
            name === "img" &&
            key === "src" &&
            /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
          )
            result += ` src="${value}"`;
        }
        result += ">";
        inStyle = name === "style";
      },
      ontext(text) {
        if (!blocked) result += inStyle ? text : escapePreviewText(text);
      },
      onclosetag(name) {
        if (blocked) {
          blocked--;
          return;
        }
        if (!voids.has(name)) result += `</${name}>`;
        if (name === "style") inStyle = false;
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  return result;
}

export const PLUGIN_PREVIEW_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

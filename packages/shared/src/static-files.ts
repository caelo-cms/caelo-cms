// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1461 — small static files on the site's domain: `/bot/ips.json`,
 * `/.well-known/security.txt`, `/ads.txt`. The rules every surface shares
 * (the ops, the generator and the publishers), so a file that passes here
 * is one every provider serves the same way.
 *
 * Plain data only. HTML, JavaScript, CSS and SVG are refused for good: a
 * file of those types would be the way around "no raw HTML on pages" and
 * the module and plugin rules (CLAUDE.md §2). XML is data too, but a browser
 * runs what an XML document carries in the XHTML or SVG namespace or through
 * a stylesheet, so {@link staticFileBodyIssue} refuses those bodies. A header
 * could not do that job on every provider: plain GCP serves object metadata,
 * and a CSP there would be an infrastructure change per path.
 *
 * Docs: docs/dev/static-files.md.
 */

import { z } from "zod";

/** The Content-Types a static file may have (without charset). */
export const STATIC_FILE_CONTENT_TYPES = [
  "application/json",
  "text/plain",
  "text/csv",
  "application/xml",
  "text/xml",
] as const;

/** One allowed Content-Type. */
export type StaticFileContentType = (typeof STATIC_FILE_CONTENT_TYPES)[number];

/** Largest body of one file, in UTF-8 bytes. Every byte lives in a snapshot row. */
export const STATIC_FILE_MAX_BYTES = 256 * 1024;

/** Most files one site may have. Every file is a header rule on Firebase and in Caddy. */
export const STATIC_FILE_MAX_COUNT = 50;

/** Most files one write may carry. */
export const STATIC_FILE_MAX_BATCH = 20;

/** Longest path, in characters. */
export const STATIC_FILE_MAX_PATH_LENGTH = 200;

/** Longest `purpose` text. */
export const STATIC_FILE_MAX_PURPOSE_LENGTH = 500;

/**
 * The build's sidecar naming its static files and their Content-Types. The
 * publishers that serve a file's type from a header rule (Firebase Hosting,
 * Caddy) read it; the others take the type from the upload.
 */
export const STATIC_FILES_MANIFEST_FILE = "_static-files.json";

/** One file as {@link STATIC_FILES_MANIFEST_FILE} lists it. */
export interface StaticFileManifestEntry {
  /** Build-relative path, no leading slash (`bot/ips.json`). */
  readonly path: string;
  /** The Content-Type header the file is served with. */
  readonly contentType: string;
}

const manifestSchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({ path: z.string().min(1), contentType: z.string().min(1) })),
});

/** The sidecar's body for `files`. */
export function formatStaticFilesManifest(files: readonly StaticFileManifestEntry[]): string {
  return JSON.stringify({ version: 1, files }, null, 2);
}

/**
 * Parse the sidecar.
 *
 * @throws when the body is not one the generator wrote: a build whose files
 *   would lose their Content-Type must not be deployed.
 */
export function parseStaticFilesManifest(body: string): readonly StaticFileManifestEntry[] {
  return manifestSchema.parse(JSON.parse(body)).files;
}

/** The Content-Type header for a stored type. All bodies are UTF-8. */
export function staticFileContentTypeHeader(type: StaticFileContentType): string {
  return `${type}; charset=utf-8`;
}

/** The extensions a path may carry, with the types each one may be served as. */
const TYPES_OF_EXTENSION: Readonly<Record<string, readonly StaticFileContentType[]>> = {
  ".json": ["application/json"],
  ".txt": ["text/plain"],
  ".csv": ["text/csv"],
  ".xml": ["application/xml", "text/xml"],
};

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/** Files the build writes at the site root. */
const RESERVED_ROOT_FILES: ReadonlySet<string> = new Set([
  "robots.txt",
  "sitemap.xml",
  "routing-manifest.json",
  "cdn_manifest.json",
  "render-deps.json",
]);

/**
 * `/.well-known/` names the platform answers itself: remote MCP's OAuth
 * metadata (the load balancer routes `oauth-*` to the MCP-Auth-Proxy on gcp,
 * CLAUDE.md §11.B) and certificate issuance.
 */
const RESERVED_WELL_KNOWN = /^(?:oauth-|openid-configuration$|acme-challenge$)/;

/** The extension of the last path segment, lower-cased, or "" when it has none. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Why `path` cannot hold a static file, or null when it can. Pure: the
 * collisions with pages, redirects and other files need data, see
 * {@link staticFileCollisions}.
 */
export function staticFilePathIssue(path: string): string | null {
  if (path.length > STATIC_FILE_MAX_PATH_LENGTH) {
    return `the path is longer than ${STATIC_FILE_MAX_PATH_LENGTH} characters`;
  }
  if (!path.startsWith("/") || path.endsWith("/")) {
    return 'write it as a full file path, starting with "/" and not ending in "/", like /bot/ips.json';
  }
  const segments = path.slice(1).split("/");
  const first = segments[0] ?? "";
  if (first.toLowerCase() === "api" || first.startsWith("_")) {
    return `"/${first}" is reserved for the site's own files and services; choose another folder`;
  }
  if (segments.length === 1 && RESERVED_ROOT_FILES.has(first.toLowerCase())) {
    return `"${path}" is written by every build; a static file cannot replace it`;
  }
  const named = first === ".well-known" ? segments.slice(1) : segments;
  if (named.length === 0) {
    return "name a file inside /.well-known/, like /.well-known/security.txt";
  }
  if (first === ".well-known" && RESERVED_WELL_KNOWN.test(named[0] ?? "")) {
    return `"${path}" is answered by the platform itself (sign-in and certificates)`;
  }
  const bad = named.find((s) => !SEGMENT.test(s));
  if (bad !== undefined) {
    return `"${bad}" cannot be part of a path: use letters, digits, "-", "_", "." and "~", and start each part with a letter or digit (only /.well-known/ starts with a dot)`;
  }
  const ext = extensionOf(path);
  if (ext !== "" && TYPES_OF_EXTENSION[ext] === undefined) {
    return `a file ending in "${ext}" cannot be served: use ${Object.keys(TYPES_OF_EXTENSION).join(", ")} or no extension. HTML, JavaScript, CSS and SVG belong in pages and modules`;
  }
  return null;
}

/**
 * Why `contentType` does not fit `path`, or null. The two must agree: a
 * host that goes by the extension then serves the declared type too. A path
 * without an extension takes any allowed type.
 */
export function staticFileTypeIssue(path: string, contentType: string): string | null {
  if (!(STATIC_FILE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return `"${contentType}" cannot be served: use one of ${STATIC_FILE_CONTENT_TYPES.join(", ")}`;
  }
  const ext = extensionOf(path);
  if (ext === "") return null;
  const allowed = TYPES_OF_EXTENSION[ext];
  if (allowed === undefined || (allowed as readonly string[]).includes(contentType)) return null;
  return `a path ending in "${ext}" is served as ${allowed.join(" or ")}, not ${contentType}. Change the type or the path`;
}

/** The body's size in UTF-8 bytes. */
export function staticFileByteLength(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

/**
 * Namespaces and constructs that make a browser treat an XML document as a
 * page or run a stylesheet over it.
 */
const ACTIVE_XML =
  /www\.w3\.org\/1999\/xhtml|www\.w3\.org\/2000\/svg|www\.w3\.org\/1998\/Math\/MathML|<\?xml-stylesheet|<!DOCTYPE|<!ENTITY/i;

/** An `xmlns` value spelled with character references, which would hide the namespace. */
const ESCAPED_NAMESPACE = /xmlns(?::[^\s=]+)?\s*=\s*(?:"[^"]*&|'[^']*&)/i;

/**
 * Why `body` cannot be served as `contentType`, or null. Checks the size,
 * that JSON parses, and that XML stays data (see the file header).
 */
export function staticFileBodyIssue(contentType: string, body: string): string | null {
  if (body.length === 0) return "the file is empty";
  const bytes = staticFileByteLength(body);
  if (bytes > STATIC_FILE_MAX_BYTES) {
    return `the file has ${bytes} bytes; a static file may have at most ${STATIC_FILE_MAX_BYTES} (${STATIC_FILE_MAX_BYTES / 1024} KiB)`;
  }
  if (body.includes("\0")) return "the file contains a NUL character, so it is not a text file";
  if (contentType === "application/json") {
    try {
      JSON.parse(body);
    } catch (e) {
      return `the file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (contentType === "application/xml" || contentType === "text/xml") {
    if (ACTIVE_XML.test(body) || ESCAPED_NAMESPACE.test(body)) {
      return "the XML carries a DOCTYPE, a stylesheet or an XHTML, SVG or MathML namespace, which a browser would run as a page. Send plain data XML, or build it as a page";
    }
  }
  return null;
}

const withoutTrailingSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * What stands in the way of a file at `path`, one sentence per collision. A
 * file cannot share a URL with a page or a redirect, and because it is a
 * real file on disk and in a bucket it cannot sit where another path needs
 * a folder, or below another file.
 *
 * @param args.pagePaths URL paths of the pages (`/about`, `/about/`).
 * @param args.redirectFromPaths URL paths that redirect.
 * @param args.filePaths URL paths of the other static files.
 */
export function staticFileCollisions(
  path: string,
  args: {
    readonly pagePaths: Iterable<string>;
    readonly redirectFromPaths: Iterable<string>;
    readonly filePaths: Iterable<string>;
  },
): string[] {
  const out: string[] = [];
  for (const raw of args.pagePaths) {
    const page = withoutTrailingSlash(raw);
    if (page === path) out.push(`a page already serves ${path}`);
    else if (page.startsWith(`${path}/`)) out.push(`the page ${page} sits below ${path}`);
  }
  for (const raw of args.redirectFromPaths) {
    if (withoutTrailingSlash(raw) === path) out.push(`a redirect starts at ${path}`);
  }
  for (const other of args.filePaths) {
    if (other === path) continue;
    if (other.startsWith(`${path}/`)) out.push(`the file ${other} sits below ${path}`);
    else if (path.startsWith(`${other}/`)) {
      out.push(`the file ${other} stands where ${path} needs a folder`);
    }
  }
  return out;
}

/** Zod shape of one file in a write. The rules with a message live in the functions above. */
export const staticFileInputSchema = z
  .object({
    /** Full path on the site, like `/bot/ips.json`. */
    path: z.string().min(2).max(STATIC_FILE_MAX_PATH_LENGTH),
    contentType: z.enum(STATIC_FILE_CONTENT_TYPES),
    /** The file's text, UTF-8. */
    body: z.string().min(1),
    /** Why this file exists and who reads it (CLAUDE.md §1A). */
    purpose: z.string().trim().min(1).max(STATIC_FILE_MAX_PURPOSE_LENGTH),
  })
  .strict();

/** One file in a write. */
export type StaticFileInput = z.infer<typeof staticFileInputSchema>;

/** Every problem of one file that needs no data, as sentences. */
export function staticFileIssues(file: StaticFileInput): string[] {
  const pathIssue = staticFilePathIssue(file.path);
  return [
    pathIssue ?? staticFileTypeIssue(file.path, file.contentType),
    staticFileBodyIssue(file.contentType, file.body),
  ].filter((i): i is string => i !== null);
}

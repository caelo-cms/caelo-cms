// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — what a plugin puts in a visitor's browser (`client_assets`,
 * docs/dev/external-plugin-brokers.md §6.7, decision Q4 B), for every
 * plugin, shipped or installed (one plugin model):
 *
 * - **Client files** are part of the reviewed artifact: JS and CSS text in
 *   the manifest (`clientFiles`), so the Owner approves their bytes and the
 *   artifact digest (shipped: the manifest digest, #1332; installed: the
 *   artifact digest) binds them. A changed byte is a new artifact.
 * - **Build data** is the one thing a build may change: a JSON object per
 *   build (`hasBuildData`, the `$buildData` point). Core embeds it as a
 *   data block the files read; it never becomes code.
 * - **Origins** a file may reach beyond the site's own are in the grant
 *   (`capabilityConstraints.client_assets.origins`), shown on the approval
 *   card, and nowhere else.
 * - **Deferral placeholders** are reviewed markup too (`deferralPlaceholders`):
 *   a verdict names one and hands it text values, which core escapes.
 */

import { cspOriginSchema } from "@caelo-cms/shared";
import { z } from "zod";

/** Name of a client file: lowercase with dashes, `.js` or `.css`. */
export const CLIENT_FILE_NAME_RE = /^[a-z][a-z0-9-]*\.(js|css)$/;

/**
 * Total bytes of one plugin's client files. They load on every page, so a
 * plugin that ships its dataset onto every page fails at review instead of
 * at the CDN bill.
 */
export const CLIENT_FILES_MAX_BYTES = 512 * 1024;

/** Largest build-data object, serialized: it is in every page's HTML. */
export const BUILD_DATA_MAX_BYTES = 64 * 1024;

/** The reviewed client files, by name. */
export const pluginClientFiles = z
  .record(
    z.string().regex(CLIENT_FILE_NAME_RE, "a client file is named like runtime.js or widget.css"),
    z.string().min(1),
  )
  .refine((files) => Object.keys(files).length <= 20, "at most 20 client files")
  .refine(
    (files) =>
      Object.values(files).reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0) <=
      CLIENT_FILES_MAX_BYTES,
    `client files hold at most ${CLIENT_FILES_MAX_BYTES} bytes together`,
  );

export type PluginClientFiles = z.infer<typeof pluginClientFiles>;

/** The CSP kinds a client file can reach (the site CSP's, `form` aside: a file posts to its own gateway). */
export const CLIENT_ORIGIN_KINDS = [
  "script",
  "style",
  "img",
  "font",
  "connect",
  "frame",
  "media",
] as const;

/**
 * Third-party origins per kind, as the grant names them. Each is the site
 * CSP's origin (`cspOriginSchema`): `https://` or `wss://` and a host, no
 * path, no keyword, so a grant can never add `'unsafe-inline'` or `*`.
 */
export const clientOrigins = z
  .object(
    Object.fromEntries(
      CLIENT_ORIGIN_KINDS.map((k) => [k, z.array(cspOriginSchema).max(20).optional()]),
    ) as Record<
      (typeof CLIENT_ORIGIN_KINDS)[number],
      z.ZodOptional<z.ZodArray<typeof cspOriginSchema>>
    >,
  )
  .strict();

export type ClientOrigins = z.infer<typeof clientOrigins>;

/** A key of a deferral placeholder or of one of its text values. */
const placeholderKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "a lowercase key with underscores");

/**
 * One placeholder a plugin declares: markup standing in for a withheld
 * module (or, in the editor preview, a notice for an omitted one). `html`
 * may hold `{{name}}` slots that a verdict fills with text; core escapes
 * every value. Checked at review like module HTML: nothing in it loads or
 * runs (plugin-sandbox `client-assets.ts`).
 */
export const deferralPlaceholderSpec = z
  .object({ html: z.string().min(1).max(20_000), css: z.string().max(20_000) })
  .strict();

/** Every placeholder a plugin declares, by name. */
export const deferralPlaceholders = z
  .record(placeholderKey, deferralPlaceholderSpec)
  .refine((p) => Object.keys(p).length <= 20, "at most 20 placeholders");

export type DeferralPlaceholders = z.infer<typeof deferralPlaceholders>;

/** A verdict's pick of a declared placeholder and the text for its slots. */
export const deferralPlaceholderRef = z
  .object({
    name: placeholderKey,
    values: z
      .record(placeholderKey, z.string().max(2000))
      .refine((v) => Object.keys(v).length <= 20, "at most 20 values")
      .optional(),
  })
  .strict();

export type DeferralPlaceholderRef = z.infer<typeof deferralPlaceholderRef>;

/** The `{{name}}` slots of a placeholder, in order of first appearance. */
export function placeholderSlots(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) {
    const name = m[1] as string;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

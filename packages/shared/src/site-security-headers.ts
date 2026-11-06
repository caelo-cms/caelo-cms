// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1454 — the response headers of a site's pages, the one definition
 * every host serves them from (docs/dev/site-security-headers.md).
 *
 * The Owner's {@link SiteSecurityPolicy} (`site_settings.security_headers`)
 * and what a build really ships ({@link SiteCspFacts}, scanned from its
 * pages) make one {@link SiteHeaderSet}. The generator writes it into the
 * build as {@link SECURITY_HEADERS_BUILD_FILE}, so a build and its headers
 * travel together: a CSP derived from one build can never sit on the files
 * of another, which is what would take a site's scripts down. That makes
 * the setting a RENDERED one (CLAUDE.md §2): it goes live with a human
 * Publish live, and a rollback restores the headers of the build it restores.
 *
 * Two levels, so that a rollout cannot break a live site:
 *
 * - Always enforced, on every install: Referrer-Policy, Permissions-Policy,
 *   clickjacking protection and the part of the CSP that blocks no script
 *   (`frame-ancestors`, `base-uri`, `object-src`).
 * - The full CSP: `Content-Security-Policy-Report-Only` until the Owner
 *   switches `cspMode` to `enforce`. Report-only breaks nothing; the Stage's
 *   Lighthouse run reports each violation with its next step, and the
 *   `security-headers` quality check names what could not be derived. That
 *   is all the evidence there is: {@link ENFORCE_EVIDENCE_NOTE}.
 *
 * `script-src` carries no `'unsafe-inline'`: it is `'self'`, the origins the
 * build references and the hashes of the few inline scripts left, because
 * the composer's per-page script is a content-hashed file on a deployed page
 * (static-generator page-scripts-pass.ts). A hash per page would not fit a
 * header on a 50,000-page site. `style-src` does keep `'unsafe-inline'`:
 * `style` attributes cannot be hashed, shadow-DOM `<style>` of plugin
 * components is written at runtime, and each page's inline `<style>` varies
 * with its modules. A linked stylesheet instead would block first paint, and
 * CSS cannot run script.
 */

import { z } from "zod";
import { NOSNIFF } from "./static-security-headers.js";

/** The build file holding the {@link SiteHeaderSet}; served, and read by every publisher. */
export const SECURITY_HEADERS_BUILD_FILE = "_security-headers.json";

/** The source lists an Owner or a build can add to, by what the browser loads. */
export const CSP_SOURCE_KINDS = [
  "script",
  "style",
  "img",
  "font",
  "connect",
  "frame",
  "media",
  "form",
] as const;
export type CspSourceKind = (typeof CSP_SOURCE_KINDS)[number];

/**
 * The most bytes of header names and values one page may carry. Hard limit
 * on `gcp`: 8 KB of custom headers per backend, nosniff included. Firebase
 * documents none, so the same figure is the safe one there; browsers and
 * proxies start refusing around 8 KB too.
 */
export const SITE_HEADERS_MAX_BYTES = 6 * 1024;

/** Features every page denies. Autoplay, fullscreen and the like stay open: video embeds use them. */
export const DENIED_BROWSER_FEATURES = [
  "bluetooth",
  "camera",
  "geolocation",
  "hid",
  "microphone",
  "midi",
  "payment",
  "serial",
  "usb",
] as const;

/** The `Referrer-Policy` values an Owner may pick (no `unsafe-url`: it leaks full URLs). */
export const REFERRER_POLICIES = [
  "strict-origin-when-cross-origin",
  "strict-origin",
  "same-origin",
  "no-referrer",
] as const;

/**
 * What enforcing rests on, said wherever the switch is made. There is no
 * report endpoint, so nothing from a visitor's browser reaches anyone.
 */
export const ENFORCE_EVIDENCE_NOTE =
  "Enforcing rests on what the Stage's quality check saw. It opens a few pages and gives no consent, so a violation on any other page, or after a visitor consents, reaches nobody and is blocked for visitors.";

/** Why a build shipped no page headers, for a Publish live or rollback of one. */
export const NO_BUILD_HEADERS_NOTE =
  "No security headers shipped: this build was staged before Caelo sent them, so the site serves it without them. A new Stage and Publish live fixes it.";

const ORIGIN_RE =
  /^(https|wss):\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;

/** One origin in a source list: scheme and host, lower case, no path. */
export const cspOriginSchema = z
  .string()
  .max(253)
  .regex(
    ORIGIN_RE,
    "an origin like https://cdn.example.com or https://*.example.com: https or wss, no path, no keyword such as 'unsafe-inline', 'unsafe-eval', * or data:",
  );

const originList = (max: number) =>
  z
    .array(cspOriginSchema)
    .max(max)
    .refine((list) => new Set(list).size === list.length, { message: "each origin only once" });

/** Extra origins per kind; a kind left out has none. */
export const cspExtraSourcesSchema = z
  .object({
    script: originList(50).optional(),
    style: originList(50).optional(),
    img: originList(50).optional(),
    font: originList(50).optional(),
    connect: originList(50).optional(),
    frame: originList(50).optional(),
    media: originList(50).optional(),
    form: originList(50).optional(),
  })
  .strict();

/** The Owner's policy, as `site_settings.security_headers` stores it. */
export const siteSecurityPolicySchema = z
  .object({
    /** `report_only` breaks nothing; `enforce` makes browsers block what the policy leaves out. */
    cspMode: z.enum(["report_only", "enforce"]),
    /** Origins that may frame the site, beside itself. */
    frameAncestors: originList(20),
    referrerPolicy: z.enum(REFERRER_POLICIES),
    /** Features this site's own pages use (`feature=(self)` instead of denied). */
    allowedFeatures: z.array(z.enum(DENIED_BROWSER_FEATURES)).max(DENIED_BROWSER_FEATURES.length),
    /** Where the host does not send HSTS itself. Browsers remember it: hard to take back. */
    hsts: z
      .object({
        maxAgeSeconds: z.number().int().min(0).max(63_072_000),
        includeSubdomains: z.boolean(),
        preload: z.boolean(),
      })
      .strict(),
    /** Origins the build cannot see: what a tag or module script loads at runtime. */
    extraSources: cspExtraSourcesSchema,
  })
  .strict();
export type SiteSecurityPolicy = z.infer<typeof siteSecurityPolicySchema>;

/**
 * The stored default of every install (migration 0639): the full CSP is
 * report-only, so an update cannot take a site's scripts down.
 */
export const DEFAULT_SITE_SECURITY_POLICY: SiteSecurityPolicy = {
  cspMode: "report_only",
  frameAncestors: [],
  referrerPolicy: "strict-origin-when-cross-origin",
  allowedFeatures: [],
  hsts: { maxAgeSeconds: 31_536_000, includeSubdomains: false, preload: false },
  extraSources: {},
};

/**
 * What a plugin's client code reaches, returned as the reserved
 * `csp-sources.json` of `buildAssets`: the build cannot see what a runtime
 * injects after consent.
 */
export const pluginCspSourcesSchema = z
  .object({
    origins: z
      .object({
        script: z.array(cspOriginSchema).max(100).optional(),
        style: z.array(cspOriginSchema).max(100).optional(),
        img: z.array(cspOriginSchema).max(100).optional(),
        font: z.array(cspOriginSchema).max(100).optional(),
        connect: z.array(cspOriginSchema).max(100).optional(),
        frame: z.array(cspOriginSchema).max(100).optional(),
        media: z.array(cspOriginSchema).max(100).optional(),
        form: z.array(cspOriginSchema).max(100).optional(),
      })
      .strict()
      .optional(),
    /** Exact text of inline scripts its runtime injects; the build hashes them. */
    inlineScripts: z.array(z.string().max(60_000)).max(200).optional(),
  })
  .strict();
export type PluginCspSources = z.infer<typeof pluginCspSourcesSchema>;

/** Markup no CSP without `'unsafe-inline'` lets run. */
export const cspBlockerSchema = z.object({
  kind: z.enum(["inline-handler", "javascript-url", "data-script", "foreign-base"]),
  /** What was found: `onclick`, the `<base>` target, … */
  detail: z.string().max(200),
  /** Pages it is on, a sample. */
  pages: z.array(z.string().max(1024)).max(5),
  /** On how many pages it is. */
  pageCount: z.number().int().nonnegative(),
});
export type CspBlocker = z.infer<typeof cspBlockerSchema>;

/** What one build ships, as far as the policy depends on it. */
export const siteCspFactsSchema = z.object({
  /** Third-party origins per kind, sorted. The site itself is `'self'`. */
  origins: z.partialRecord(z.enum(CSP_SOURCE_KINDS), z.array(z.string())),
  /** Inline scripts, as CSP sources (`'sha256-…'`), sorted. */
  inlineScriptHashes: z.array(z.string()),
  /** `object-src` sources of `<object>` and `<embed>`, sorted. */
  objectOrigins: z.array(z.string()),
  /**
   * Inline scripts holding the build's own origin. The staging gateway
   * rewrites that origin in the body, which changes their hash, so it hashes
   * them again for its host (staging/site.ts).
   */
  originBoundScripts: z.array(z.string()),
  blockers: z.array(cspBlockerSchema),
  /** What each plugin contributed, shown to the Owner beside the policy. */
  plugins: z.array(
    z.object({
      slug: z.string(),
      origins: z.array(z.string()),
      inlineScripts: z.number().int().nonnegative(),
    }),
  ),
});
export type SiteCspFacts = z.infer<typeof siteCspFactsSchema>;

/** Facts of a build that ships nothing third-party (a policy's preview before the first Stage). */
export const EMPTY_CSP_FACTS: SiteCspFacts = {
  origins: {},
  inlineScriptHashes: [],
  objectOrigins: [],
  originBoundScripts: [],
  blockers: [],
  plugins: [],
};

/** The headers of one build ({@link SECURITY_HEADERS_BUILD_FILE}). */
export const siteHeaderSetSchema = z.object({
  version: z.literal(1),
  policy: siteSecurityPolicySchema,
  facts: siteCspFactsSchema,
  /** On every document, on every host. */
  headers: z.record(z.string(), z.string()),
  /** `Strict-Transport-Security`, for hosts that do not send their own; null at max-age 0. */
  hsts: z.string().nullable(),
  /** True when the CSP did not fit and a report-only build left parts of it out. */
  cspCut: z.boolean(),
});
export type SiteHeaderSet = z.infer<typeof siteHeaderSetSchema>;

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function directive(name: string, sources: readonly string[]): string {
  return `${name} ${sources.join(" ")}`;
}

function frameAncestors(policy: SiteSecurityPolicy): string {
  return directive("frame-ancestors", ["'self'", ...policy.frameAncestors]);
}

function objectSrc(facts: SiteCspFacts): string {
  return directive("object-src", facts.objectOrigins.length > 0 ? facts.objectOrigins : ["'none'"]);
}

/** The directives enforced in every mode: none of them can stop a script or a style. */
function baselineCsp(policy: SiteSecurityPolicy, facts: SiteCspFacts): string[] {
  return [frameAncestors(policy), "base-uri 'self'", objectSrc(facts)];
}

/**
 * The full policy.
 *
 * @param hashes - the inline-script sources it allows.
 */
function fullCsp(
  policy: SiteSecurityPolicy,
  facts: SiteCspFacts,
  hashes: readonly string[],
): string {
  const of = (kind: (typeof CSP_SOURCE_KINDS)[number]) =>
    uniqueSorted([...(facts.origins[kind] ?? []), ...(policy.extraSources[kind] ?? [])]);
  return [
    "default-src 'self'",
    directive("script-src", ["'self'", ...hashes, ...of("script")]),
    // 'unsafe-inline': see the file comment.
    directive("style-src", ["'self'", "'unsafe-inline'", ...of("style")]),
    // data: — inline SVG backgrounds and icons; blob: — what a module draws on a canvas.
    directive("img-src", ["'self'", "data:", "blob:", ...of("img")]),
    directive("font-src", ["'self'", "data:", ...of("font")]),
    directive("connect-src", ["'self'", ...of("connect")]),
    directive("media-src", ["'self'", "blob:", ...of("media")]),
    directive("frame-src", ["'self'", ...of("frame")]),
    directive("form-action", ["'self'", ...of("form")]),
    ...baselineCsp(policy, facts),
  ].join("; ");
}

function permissionsPolicy(policy: SiteSecurityPolicy): string {
  const allowed = new Set<string>(policy.allowedFeatures);
  return DENIED_BROWSER_FEATURES.map((f) => `${f}=${allowed.has(f) ? "(self)" : "()"}`).join(", ");
}

function hstsValue(policy: SiteSecurityPolicy): string | null {
  const { maxAgeSeconds, includeSubdomains, preload } = policy.hsts;
  if (maxAgeSeconds === 0) return null;
  return [
    `max-age=${maxAgeSeconds}`,
    ...(includeSubdomains ? ["includeSubDomains"] : []),
    ...(preload ? ["preload"] : []),
  ].join("; ");
}

function headerBytes(headers: Readonly<Record<string, string>>): number {
  const encoder = new TextEncoder();
  return Object.entries(headers).reduce(
    (sum, [name, value]) => sum + name.length + encoder.encode(value).length,
    0,
  );
}

/** The policy does not fit a response header (see {@link SITE_HEADERS_MAX_BYTES}). */
export class SiteHeadersTooLargeError extends Error {
  constructor(bytes: number, hashes: number) {
    super(
      `The site's security headers take ${bytes} bytes, over the ${SITE_HEADERS_MAX_BYTES} that fit a response, with ${hashes} inline script hashes in the CSP. Move inline <script> elements of modules into the module's js, or remove origins from the policy's extraSources, then Stage again. To Stage meanwhile, propose cspMode report_only.`,
    );
    this.name = "SiteHeadersTooLargeError";
  }
}

/**
 * The headers of one build.
 *
 * In report-only mode a policy that does not fit loses its inline hashes, and
 * then the report-only header (`cspCut`): the page keeps working, the quality
 * check says so and `enforce` stays closed. In enforce mode the same policy
 * would block scripts, so the build stops instead.
 *
 * @throws {@link SiteHeadersTooLargeError} when an enforced policy does not fit.
 */
export function composeSiteHeaders(policy: SiteSecurityPolicy, facts: SiteCspFacts): SiteHeaderSet {
  const base: Record<string, string> = {
    "Referrer-Policy": policy.referrerPolicy,
    "Permissions-Policy": permissionsPolicy(policy),
    // X-Frame-Options has no list; with extra ancestors only the CSP can say it.
    ...(policy.frameAncestors.length === 0 ? { "X-Frame-Options": "SAMEORIGIN" } : {}),
  };
  const hsts = hstsValue(policy);
  const compose = (hashes: readonly string[]): Record<string, string> =>
    policy.cspMode === "enforce"
      ? { ...base, "Content-Security-Policy": fullCsp(policy, facts, hashes) }
      : {
          ...base,
          "Content-Security-Policy": baselineCsp(policy, facts).join("; "),
          "Content-Security-Policy-Report-Only": fullCsp(policy, facts, hashes),
        };
  const size = (headers: Readonly<Record<string, string>>) =>
    headerBytes(headers) + (hsts === null ? 0 : hsts.length + "Strict-Transport-Security".length);
  const set = { version: 1 as const, policy, facts, hsts };
  const headers = compose(facts.inlineScriptHashes);
  if (size(headers) <= SITE_HEADERS_MAX_BYTES) return { ...set, headers, cspCut: false };
  if (policy.cspMode === "enforce") {
    throw new SiteHeadersTooLargeError(size(headers), facts.inlineScriptHashes.length);
  }
  const reduced = compose([]);
  if (size(reduced) <= SITE_HEADERS_MAX_BYTES) return { ...set, headers: reduced, cspCut: true };
  const { "Content-Security-Policy-Report-Only": _cut, ...baseline } = reduced;
  return { ...set, headers: baseline, cspCut: true };
}

/** Parse {@link SECURITY_HEADERS_BUILD_FILE}. */
export function parseSiteHeaderSet(text: string): SiteHeaderSet {
  return siteHeaderSetSchema.parse(JSON.parse(text));
}

/**
 * What would break in `enforce` that the build can already see: blockers in
 * the markup, or hashes that did not fit. Empty when it is safe to offer.
 */
export function enforceBlockers(set: SiteHeaderSet): string[] {
  const out = set.facts.blockers.map(
    (b) => `${b.kind} ${b.detail} on ${b.pageCount} page(s), e.g. ${b.pages[0] ?? "?"}`,
  );
  if (set.cspCut) out.push("the full CSP does not fit a response header");
  return out;
}

// ─── hosts ─────────────────────────────────────────────────────────────

/** How one host serves the headers, or why it cannot. */
export interface SiteHeaderHost {
  /** False where no publisher exists: a Stage refuses there. */
  readonly served: boolean;
  /** The host sends HSTS itself, so the policy's `hsts` is not used. */
  readonly hostSendsHsts: boolean;
  readonly note: string;
}

/** Per `CAELO_PROVIDER`. */
export const SITE_HEADER_HOSTS: Readonly<Record<string, SiteHeaderHost>> = {
  "gcp-firebase": {
    served: true,
    hostSendsHsts: true,
    note: "In the Hosting version: they go live with the release of the build.",
  },
  gcp: {
    served: true,
    hostSendsHsts: false,
    note: "Custom headers of the static backend bucket, set by Publish live and rollback.",
  },
  "self-hosted": {
    served: true,
    hostSendsHsts: false,
    note: "Caddy, from the _redirects.caddy snippet of the build it serves.",
  },
  aws: {
    served: false,
    hostSendsHsts: false,
    note: "No static publisher exists on AWS yet (#749), so nothing is published here.",
  },
  azure: {
    served: false,
    hostSendsHsts: false,
    note: "No static publisher exists on Azure yet (#750), so nothing is published here.",
  },
};

const FIRST_SEGMENT = "(?:[^_a/][^/]*|a(?:[^p/][^/]*)?|ap(?:[^i/][^/]*)?|api[^/]+)";
const FIRST_SEGMENT_NO_DOT = "(?:[^_a/.][^/.]*|a(?:[^p/.][^/.]*)?|ap(?:[^i/.][^/.]*)?|api[^/.]+)";

/**
 * RE2-and-ECMAScript regex for a path that serves a page: `/`, `/about`,
 * `/about/`, `/a/b`, `/about.html`; never `/api`, `/api/…`, `/_…` or a file
 * with another extension. Disjoint from `SVG_PATH_PATTERN`, because Firebase
 * does not document which entry wins when two set the same header. A
 * document is all a CSP acts on, so other files need no entry.
 */
export const SITE_DOCUMENT_PATH_PATTERN = `^/(?:${FIRST_SEGMENT}/(?:.*/|.*\\.html|(?:.*/)?[^/.]+)?|${FIRST_SEGMENT_NO_DOT}|[^_/][^/]*\\.html)?$`;

function withHsts(set: SiteHeaderSet): Record<string, string> {
  return set.hsts === null
    ? set.headers
    : { ...set.headers, "Strict-Transport-Security": set.hsts };
}

/** Caddyfile lines serving `set` on the documents of a public vhost. */
export function emitCaddySiteHeaders(set: SiteHeaderSet): string {
  const lines = ["@caelo_documents {", "\tnot path /api/* /_*", "\tnot path *.svg", "}"];
  for (const [name, value] of Object.entries(withHsts(set))) {
    // A quote or backslash would end the quoted string and a brace would be
    // read as a Caddy placeholder; the composer never produces one, so one
    // here is a broken build file, not something to escape.
    if (!/^[A-Za-z0-9-]+$/.test(name) || !/^[ -~]*$/.test(value) || /["\\{}]/.test(value)) {
      throw new Error(
        `The build's ${name} header holds a character a Caddyfile cannot carry (quote, backslash, brace or control character). Stage again; if it repeats, the build's ${SECURITY_HEADERS_BUILD_FILE} is corrupt.`,
      );
    }
    lines.push(`header @caelo_documents ${name} "${value}"`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The static backend bucket's `customResponseHeaders` on `gcp`, in the
 * `Name: value` form of the Compute API. One list per bucket, so it covers
 * every file; harmless, a CSP only acts on documents and an SVG is served
 * as a download there (`gcsObjectMetadata`). Nosniff stays first: it is the
 * entry the provisioning stack owns.
 *
 * @param set - null for a build from before the headers: its files must not
 *   keep the previous build's CSP, which names other inline scripts.
 */
export function gcpBackendBucketHeaders(set: SiteHeaderSet | null): string[] {
  return [
    `X-Content-Type-Options: ${NOSNIFF}`,
    ...(set === null ? [] : Object.entries(withHsts(set))).map(
      ([name, value]) => `${name}: ${value}`,
    ),
  ];
}

/** The staged manifest's fields for a build's headers. */
export function stagedHeaderFields(set: SiteHeaderSet): {
  securityHeaders: Record<string, string>;
  originBoundScripts: string[];
} {
  return { securityHeaders: set.headers, originBoundScripts: set.facts.originBoundScripts };
}

/** `headers` with more inline-script sources in whichever CSP has a `script-src`. */
export function withScriptHashes(
  headers: Readonly<Record<string, string>>,
  hashes: readonly string[],
): Record<string, string> {
  if (hashes.length === 0) return { ...headers };
  const out = { ...headers };
  for (const name of ["Content-Security-Policy", "Content-Security-Policy-Report-Only"]) {
    const value = out[name];
    if (value?.includes("script-src 'self'")) {
      out[name] = value.replace("script-src 'self'", `script-src 'self' ${hashes.join(" ")}`);
    }
  }
  return out;
}

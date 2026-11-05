// SPDX-License-Identifier: MPL-2.0

/**
 * The validators for a redirect's TARGET (`toPath`) — issues #657, #1358.
 *
 * A routine redirect points at a path on the same site. Every surface that
 * serves the table (the admin's 404 fallback, the generator's
 * `_redirects` / `_redirects.caddy`, the per-provider emitters) writes
 * `toPath` verbatim into a `Location` header. "Starts with `/`" is not
 * enough for that to stay on-site:
 *
 *   - `//host/x` (and `/\host/x`, which browsers normalise to `//`) is a
 *     protocol-relative URL — the browser leaves the site for `host`.
 *     That turns any redirect into an open redirect.
 *   - `/https://example.com/x` is a same-site path whose first segment is
 *     `https:`; the browser lands on `https://<site>/https://example.com/x`,
 *     which is never what the author meant (they pasted a full URL).
 *   - Whitespace / control characters: browsers strip tab/CR/LF inside a
 *     URL, so `/\t/host` collapses to `//host`; the `_redirects` formats
 *     are whitespace-delimited and the emitters already refuse them.
 *
 * Every routine write path (redirects.create / create_many, page delete
 * with `disposition: 'redirect'`, the AI tool schemas, the import composer)
 * calls {@link redirectTargetIssue}, so none of them can store anything but
 * a same-site path.
 *
 * #1358 — the one exception is an `https` address on another domain, written
 * only by `redirects.execute_proposal` after an Owner's approval
 * (CLAUDE.md §11.A). {@link externalRedirectTargetIssue} holds its form: one
 * canonical spelling, so that what the Owner reads is exactly where a
 * browser goes. Serving paths accept both kinds through
 * {@link servableRedirectTargetIssue}, so a value that is neither can never
 * be served.
 */

import { z } from "zod";

/** Max length of a stored redirect path (matches the op schemas). */
const REDIRECT_PATH_MAX_LENGTH = 500;

/** A URL scheme token (RFC 3986 §3.1) followed by `:`. */
const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** Schemes that are never a meaningful first path segment. A pasted
 *  `/https:/x` (slashes collapsed by a form or a CSV tool) is the same
 *  mistake as `/https://x`, so these are rejected even without `//`. */
const WEB_SCHEMES = new Set(["http", "https"]);

const EXTERNAL_NOT_SUPPORTED =
  "This call only takes a path on this site (e.g. '/pricing'). A redirect to another domain needs the Owner's approval: use propose_external_redirect with the https address. If the destination is a page on this site, pass only its path.";

/** Longest external target: a URL-map `pathRedirect` holds 1024 characters. */
const EXTERNAL_REDIRECT_MAX_LENGTH = 1000;

/** Characters no serving layer can carry literally, or that hide a URL's meaning. */
const EXTERNAL_UNSAFE = /[\s\p{Cc}\\{}"`<>^|]/u;

/** A host no browser on the internet can reach, or an address instead of a name. */
const NON_PUBLIC_HOST =
  /^(\[.*\]|\d{1,3}(\.\d{1,3}){3}|localhost|[^.]+|.+\.(localhost|local|internal))$/i;

/** True when a stored target is a URL, not a path on this site. */
export function isExternalRedirectTarget(target: string): boolean {
  return target.startsWith("https://");
}

/**
 * Return why `url` is not a valid external redirect target, or `null` when
 * it is. Only `https`, no credentials, no port, a public host name, and the
 * URL's one canonical spelling: that refuses `https://a.example/x/../y`,
 * `%2e%2e` segments, an upper-case or percent-encoded host and every other
 * form where the text the Owner approves differs from where a browser lands.
 *
 * @example
 *   externalRedirectTargetIssue("https://calendar.example/book")   // null
 *   externalRedirectTargetIssue("https://our.site@evil.example/")  // "... credentials ..."
 *   externalRedirectTargetIssue("http://calendar.example/")        // "... https ..."
 */
export function externalRedirectTargetIssue(url: string): string | null {
  const shown = JSON.stringify(url);
  if (url.length > EXTERNAL_REDIRECT_MAX_LENGTH) {
    return `The address is longer than ${EXTERNAL_REDIRECT_MAX_LENGTH} characters, which not every hosting can serve. Use a shorter one.`;
  }
  if (!url.startsWith("https://")) {
    return `${shown} must be a full https address (https://example.com/page); other schemes are refused.`;
  }
  if (EXTERNAL_UNSAFE.test(url)) {
    return `${shown} contains a space, a control character or one of \\ { } " \` < > ^ |. Percent-encode it or remove it.`;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${shown} is not a valid address.`;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return `${shown} carries credentials before the host; browsers then go to what follows the '@', not to what the address seems to name. Pass the address without them.`;
  }
  if (parsed.port !== "") {
    return `${shown} names a port, which not every hosting can serve. Use an address on the standard https port.`;
  }
  if (NON_PUBLIC_HOST.test(parsed.hostname)) {
    return `${shown} does not name a public host. Use a domain name; IP addresses and internal names are refused.`;
  }
  if (parsed.href !== url && parsed.href !== `${url}/`) {
    return `${shown} is not in its plain form, so it may lead somewhere else than it reads. A browser reads it as ${parsed.href}: pass that if it is what you mean.`;
  }
  return null;
}

/**
 * Return why an otherwise valid external `url` may not be used on this
 * install: its host is one of the install's own. Compares the parsed,
 * lower-cased host, which is what a browser connects to.
 *
 * @param installHosts lower-case host → what it is ("the Caelo admin", …).
 */
export function externalRedirectHostIssue(
  url: string,
  installHosts: ReadonlyMap<string, string>,
): string | null {
  const host = new URL(url).hostname;
  const what = installHosts.get(host);
  if (what === undefined) return null;
  return what === "this site"
    ? `${host} is this site. Use bulk_create_redirects with the path only.`
    : `${host} is ${what}, which a redirect may not point at.`;
}

/**
 * Return why `provider`'s hosting cannot serve this external target, or
 * `null` when it can. Refused at the proposal, because one rule a provider
 * cannot express would stop the sync of the whole table.
 *
 * - `gcp`: the URL map carries a host and a path. It stores a query in
 *   `pathRedirect`, but how the load balancer answers one is unverified, so
 *   it stays refused like every target with a query there.
 * - `aws`, `azure`: no publisher exists yet (#749, #750). Their redirect
 *   writing must add this when it lands.
 *
 * @param provider `CAELO_PROVIDER`; empty = self-hosted.
 */
export function externalRedirectProviderIssue(url: string, provider?: string): string | null {
  switch (provider) {
    case undefined:
    case "":
    case "self-hosted":
    case "gcp-firebase":
      return null;
    case "gcp": {
      const { search, hash } = new URL(url);
      return search === "" && hash === ""
        ? null
        : `The GCP load balancer serves an external redirect without a query string or fragment. Use an address without '?…' and '#…', or a short link at the destination.`;
    }
    case "aws":
    case "azure":
      return `Redirects to another domain are not available on ${provider} yet: Caelo has no publisher there (https://github.com/caelo-cms/caelo-cms/issues/${provider === "aws" ? 749 : 750}).`;
    default:
      throw new Error(
        `externalRedirectProviderIssue: unknown CAELO_PROVIDER='${provider}'. Expected one of: self-hosted | gcp | gcp-firebase | aws | azure.`,
      );
  }
}

/**
 * Return why a stored target cannot be served, or `null` when it can: a
 * same-site path, or an external address in its approved form. What serving
 * layers call; write paths call {@link redirectTargetIssue}.
 */
export function servableRedirectTargetIssue(target: string): string | null {
  return isExternalRedirectTarget(target)
    ? externalRedirectTargetIssue(target)
    : redirectTargetIssue(target);
}

/**
 * Return why `toPath` is not a safe same-site redirect target, or `null`
 * when it is. The message is written for the AI: it names the problem
 * and what to pass instead.
 *
 * @example
 *   redirectTargetIssue("/blog/new?x=1#top")    // null
 *   redirectTargetIssue("//evil.example/x")     // "... protocol-relative ..."
 *   redirectTargetIssue("/https://a.example/x") // "... use '/x' ..."
 */
export function redirectTargetIssue(toPath: string): string | null {
  const shown = JSON.stringify(toPath);
  if (!toPath.startsWith("/")) {
    return `toPath ${shown} must start with '/'. ${EXTERNAL_NOT_SUPPORTED}`;
  }
  if (/[\s\p{Cc}]/u.test(toPath)) {
    return `toPath ${shown} contains whitespace or control characters. Percent-encode them (a space is '%20') or remove them.`;
  }
  if (toPath.includes("\\")) {
    return `toPath ${shown} contains a backslash; browsers treat '\\' as '/', so it can turn into a link to another host. Use forward slashes only.`;
  }
  if (toPath.startsWith("//")) {
    return `toPath ${shown} starts with '//', which browsers read as a protocol-relative URL to another host (an open redirect), not as a path on this site. Use a single leading slash, e.g. '/${trimLeadingSlashes(toPath)}'. ${EXTERNAL_NOT_SUPPORTED}`;
  }
  const scheme = SCHEME_PREFIX.exec(toPath.slice(1));
  if (scheme) {
    const rest = toPath.slice(1 + scheme[0].length);
    const name = (scheme[1] ?? "").toLowerCase();
    if (rest.startsWith("/") || WEB_SCHEMES.has(name)) {
      const suggestion = pathOfEmbeddedUrl(toPath.slice(1));
      const hint = suggestion ? ` If that URL is on this site, use its path '${suggestion}'.` : "";
      return `toPath ${shown} embeds a full URL ('${scheme[1]}:…') after the leading '/'; browsers resolve it as a path on this site, not as that URL.${hint} ${EXTERNAL_NOT_SUPPORTED}`;
    }
  }
  return null;
}

/**
 * Zod schema for a redirect target. Use this — not a bare
 * `z.string().regex(/^\//)` — wherever a redirect target enters the
 * system, so the rule above holds on every path.
 */
export const redirectTargetPathSchema = z
  .string()
  .min(1)
  .max(REDIRECT_PATH_MAX_LENGTH)
  .superRefine((value, ctx) => {
    const issue = redirectTargetIssue(value);
    if (issue) ctx.addIssue({ code: "custom", message: issue });
  });

function trimLeadingSlashes(s: string): string {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 47 /* '/' */) i += 1;
  return s.slice(i);
}

/** `https://a.example/x?y#z` → `/x?y#z`; null when unparseable. */
function pathOfEmbeddedUrl(url: string): string | null {
  // Only a well-formed `scheme://host` URL has a path worth suggesting;
  // `https:/x` would parse as host `x` and suggest a misleading '/'.
  if (!/^https?:\/\/[^/]/i.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

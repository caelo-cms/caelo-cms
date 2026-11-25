// SPDX-License-Identifier: MPL-2.0

/**
 * Moving a measurement between the origins one build is served on. An
 * audit browser loads the build on the origin it can open (a task's own
 * loopback port, the HTTP/2 listener of the admin's), while the admin
 * reads results on the origin it addressed the page on. Pure.
 */

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * `value` with every occurrence of origin `from` (page URL, final URL,
 * flagged resource URLs) replaced by `to`. `value` must be JSON.
 */
export function readdressed<T>(value: T, from: string, to: string): T {
  const a = trimTrailingSlash(from);
  const b = trimTrailingSlash(to);
  if (a === b) return value;
  return JSON.parse(JSON.stringify(value).split(a).join(b)) as T;
}

/**
 * `url` moved from origin `from` to origin `to`.
 *
 * @throws when `url` is not on `from`: the order names a page of another build.
 */
export function onOrigin(url: string, from: string, to: string): string {
  const a = trimTrailingSlash(from);
  if (url !== a && !url.startsWith(`${a}/`)) {
    throw new Error(`url ${url} is not on the staged build's origin ${a}`);
  }
  return `${trimTrailingSlash(to)}${url.slice(a.length)}`;
}
